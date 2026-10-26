// Bambu Lab printers in LAN mode (X1, P1, A1 series). Beta: written against the publicly
// documented LAN protocol, not yet tested on hardware.
//   • status and commands: MQTT over TLS on port 8883 (user "bblp", password = LAN access code)
//   • file upload: implicit FTPS on port 990 (same credentials)
// Printer settings needed: IP address (url), serial number, LAN access code.
// Recent firmware requires "LAN only" + "Developer mode" for third-party control.
// Bambu printers expect G-code produced for them (Bambu Studio / OrcaSlicer profiles); set a
// PrusaSlicer-compatible profile or upload .3mf jobs made for the printer.

import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';

// Minimal MQTT 3.1.1 client (QoS 0) -----------------------------------------------------------------
function encodeLength(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; out.push(b); } while (n > 0);
  return Buffer.from(out);
}
const str = (s) => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
const packet = (type, body) => Buffer.concat([Buffer.from([type]), encodeLength(body.length), body]);

class MiniMqtt {
  constructor({ host, username, password, clientId, onMessage }) {
    Object.assign(this, { host, username, password, clientId, onMessage });
    this.buf = Buffer.alloc(0);
    this.ready = null;
  }
  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const sock = tls.connect({ host: this.host, port: 8883, rejectUnauthorized: false }); // printers use a self-signed certificate
      this.sock = sock;
      const fail = (err) => { this.ready = null; clearInterval(this.ping); reject(err); };
      sock.setTimeout(15000, () => { sock.destroy(); fail(new Error('MQTT timeout')); });
      sock.once('error', fail);
      sock.once('close', () => { this.ready = null; clearInterval(this.ping); });
      sock.on('secureConnect', () => {
        const vh = Buffer.concat([str('MQTT'), Buffer.from([4, 0xc2, 0, 60])]);
        sock.write(packet(0x10, Buffer.concat([vh, str(this.clientId), str(this.username), str(this.password)])));
      });
      sock.on('data', (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        for (;;) {
          if (this.buf.length < 2) break;
          let mult = 1, len = 0, i = 1, byte;
          do { byte = this.buf[i++]; len += (byte & 127) * mult; mult *= 128; } while (byte & 128 && i < this.buf.length);
          if (this.buf.length < i + len) break;
          const type = this.buf[0] >> 4;
          const body = this.buf.subarray(i, i + len);
          this.buf = this.buf.subarray(i + len);
          if (type === 2) { // CONNACK
            if (body[1] !== 0) { fail(new Error(`MQTT connection refused (code ${body[1]}) – check the access code`)); return; }
            sock.setTimeout(0);
            this.ping = setInterval(() => sock.write(Buffer.from([0xc0, 0])), 30000);
            resolve(this);
          } else if (type === 3) { // PUBLISH
            const tl = body.readUInt16BE(0);
            const topic = body.subarray(2, 2 + tl).toString();
            const payload = body.subarray(2 + tl).toString();
            try { this.onMessage(topic, JSON.parse(payload)); } catch { /* ignore non-JSON */ }
          }
        }
      });
    });
    return this.ready;
  }
  async subscribe(topic) {
    await this.connect();
    this.sock.write(packet(0x82, Buffer.concat([Buffer.from([0, 1]), str(topic), Buffer.from([0])])));
  }
  async publish(topic, obj) {
    await this.connect();
    this.sock.write(packet(0x30, Buffer.concat([str(topic), Buffer.from(JSON.stringify(obj))])));
  }
}

// Minimal implicit-FTPS upload ---------------------------------------------------------------------
function ftpsUpload(host, password, localFile, remoteName) {
  return new Promise((resolve, reject) => {
    const ctrl = tls.connect({ host, port: 990, rejectUnauthorized: false });
    let buffer = '';
    const queue = [];
    const expect = () => new Promise((res) => queue.push(res));
    ctrl.setTimeout(30000, () => { ctrl.destroy(); reject(new Error('FTPS timeout')); });
    ctrl.on('error', reject);
    ctrl.on('data', (d) => {
      buffer += d.toString();
      let idx;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (/^\d{3} /.test(line) && queue.length) queue.shift()(line);
      }
    });
    const cmd = async (c, ok) => {
      const p = expect();
      ctrl.write(`${c}\r\n`);
      const line = await p;
      if (ok && !ok.test(line)) throw new Error(`FTPS ${c.split(' ')[0]} failed: ${line}`);
      return line;
    };
    (async () => {
      const greet = await expect();
      if (!/^220/.test(greet)) throw new Error(`FTPS greeting: ${greet}`);
      await cmd('USER bblp', /^331/);
      await cmd(`PASS ${password}`, /^230/);
      await cmd('PBSZ 0', /^200/);
      await cmd('PROT P', /^200/);
      await cmd('TYPE I', /^200/);
      const pasv = await cmd('PASV', /^227/);
      const nums = pasv.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/).slice(1).map(Number);
      const port = nums[4] * 256 + nums[5];
      const data = tls.connect({ host, port, rejectUnauthorized: false, session: ctrl.getSession() });
      await new Promise((r, j) => { data.once('secureConnect', r); data.once('error', j); });
      const stor = cmd(`STOR ${remoteName}`);
      await new Promise((r, j) => {
        fs.createReadStream(localFile).on('error', j).pipe(data).on('finish', r).on('error', j);
      });
      const first = await stor;
      if (/^150|^125/.test(first)) {
        const done = await expect();
        if (!/^226/.test(done)) throw new Error(`FTPS upload failed: ${done}`);
      }
      ctrl.end('QUIT\r\n');
      resolve();
    })().catch((e) => { ctrl.destroy(); reject(e); });
  });
}

// Driver ---------------------------------------------------------------------------------------
const clients = new Map(); // printer id -> { mqtt, state }

export function bambuDriver(printer) {
  const host = String(printer.url || '').replace(/^https?:\/\//, '').replace(/[:/].*$/, '');
  const serial = printer.serial;
  const reportTopic = `device/${serial}/report`;
  const requestTopic = `device/${serial}/request`;

  async function client() {
    let c = clients.get(printer.id);
    if (!c) {
      c = { state: {} };
      c.mqtt = new MiniMqtt({
        host, username: 'bblp', password: printer.access_code || '', clientId: `p2p-${printer.id}-${Date.now()}`,
        onMessage: (_t, msg) => { if (msg.print) Object.assign(c.state, msg.print); },
      });
      clients.set(printer.id, c);
    }
    try {
      await c.mqtt.subscribe(reportTopic);
      await c.mqtt.publish(requestTopic, { pushing: { sequence_id: '0', command: 'pushall' } });
    } catch (e) {
      clients.delete(printer.id);
      throw e;
    }
    return c;
  }
  const command = async (cmd, extra = {}) => (await client()).mqtt.publish(requestTopic, { print: { sequence_id: '0', command: cmd, ...extra } });

  return {
    async status() {
      const c = await client();
      await new Promise((r) => setTimeout(r, 400));
      const s = c.state;
      const progress = Number(s.mc_percent || 0);
      const file = s.subtask_name || s.gcode_file || '';
      switch (s.gcode_state) {
        case 'RUNNING': case 'PREPARE': case 'SLICING': return { state: 'printing', progress, remainingSec: (s.mc_remaining_time || 0) * 60, file };
        case 'PAUSE': return { state: 'paused', progress, file };
        case 'FINISH': return { state: 'finished', progress: 100, file };
        case 'FAILED': return { state: 'error', progress, message: `Printer reported failure (code ${s.print_error || '?'})`, file };
        default: return { state: 'idle', progress: 0, file };
      }
    },
    async start({ gcodePath, fileName, amsSlot = null }) {
      await ftpsUpload(host, printer.access_code || '', gcodePath, fileName);
      if (path.extname(fileName) === '.3mf') {
        // ams_mapping maps the project's filament 1 to the AMS slot (0-based) holding the chosen colour.
        await command('project_file', {
          param: 'Metadata/plate_1.gcode', url: `ftp:///${fileName}`, subtask_name: fileName,
          use_ams: amsSlot !== null, ams_mapping: amsSlot !== null ? [amsSlot - 1] : [],
          timelapse: false, bed_leveling: true, flow_cali: false, vibration_cali: false, layer_inspect: true,
        });
      } else {
        await command('gcode_file', { param: `/sdcard/${fileName}` });
      }
    },
    pause: () => command('pause'),
    resume: () => command('resume'),
    cancel: () => command('stop'),
    async test() {
      const s = await this.status();
      return { ok: true, message: `Connected to Bambu printer ${serial} (${s.state})` };
    },
  };
}
