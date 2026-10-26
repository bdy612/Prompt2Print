#!/usr/bin/env node
// Prompt2Print print agent — runs on the PC next to the printers.
//
// Every 5 s it looks at the cloud (Supabase) for paid print jobs, picks the smallest free printer that
// fits the part and has the right material + colour loaded, downloads the model, slices it and starts
// the print over the LAN. It reports progress back and moves the order along
// (in_queue → printing → printed). Nothing else runs on this PC; the shop itself lives in the cloud.
//
// Config: agent/config.json next to this file (see config.example.json) or environment variables
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATA_DIR, BAMBU_STUDIO_PATH, SLICER_PATH.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRest } from './lib/rest.js';
import { choosePrinter } from './lib/select.js';
import { createDriver, DRIVERS } from './lib/drivers/index.js';
import { sliceJob } from './lib/slice.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLL_MS = 5000;
const MAX_ATTEMPTS = 3;

// ------------------------------------------------------------------ config + logging
export function loadConfig() {
  let file = {};
  const cfgPath = path.join(HERE, 'config.json');
  if (fs.existsSync(cfgPath)) file = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const env = process.env;
  const cfg = {
    SUPABASE_URL: env.SUPABASE_URL || file.SUPABASE_URL || '',
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY || file.SUPABASE_SERVICE_ROLE_KEY || '',
    DATA_DIR: env.DATA_DIR || file.DATA_DIR || (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Prompt2PrintAgent') : path.join(HERE, 'data')),
    BAMBU_STUDIO_PATH: env.BAMBU_STUDIO_PATH || file.BAMBU_STUDIO_PATH || '',
    SLICER_PATH: env.SLICER_PATH || file.SLICER_PATH || '',
    POLL_MS: Number(env.POLL_MS || file.POLL_MS || POLL_MS),
  };
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (agent/config.json or environment).');
  }
  return cfg;
}

function makeLogger(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'agent.log');
  return (level, msg, extra) => {
    const line = `${new Date().toISOString()} [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
    (level === 'error' ? console.error : console.log)(line);
    try { fs.appendFileSync(file, line + '\n'); } catch { /* disk full etc. — keep running */ }
  };
}

// ------------------------------------------------------------------ data access
function printerForDriver(p) {
  // Shape the drivers expect (they were written for the old local server).
  return {
    id: p.id, name: p.name, driver: p.type?.driver, url: p.address, serial: p.serial, access_code: p.access_code, api_key: p.access_code,
    bed: p.type?.bed || { x: 220, y: 220, z: 250 }, flavor: p.type?.driver === 'bambu' ? 'bambu' : p.type?.driver === 'moonraker' ? 'klipper' : 'marlin',
    nozzle_mm: p.nozzle_mm, materials: p.materials, slots: p.slots, active: p.active, type: p.type,
  };
}

export class Agent {
  constructor({ rest, config, log, drivers = createDriver, slicer = sliceJob, now = () => Date.now() }) {
    this.rest = rest; this.config = config; this.log = log; this.drivers = drivers; this.slicer = slicer; this.now = now;
    this.running = new Map();   // printer id -> { job, driver, printer }
    this.driverCache = new Map();
    this.stopped = false;
  }

  driverFor(printer) {
    const key = `${printer.id}:${printer.driver}:${printer.url}:${printer.serial}:${printer.access_code}`;
    if (!this.driverCache.has(key)) this.driverCache.set(key, this.drivers(printer));
    return this.driverCache.get(key);
  }

  async loadPrinters() {
    const rows = await this.rest.select('printers', { select: '*,type:printer_types(*)', order: 'id.asc' });
    return rows.map(printerForDriver);
  }

  async loadQueuedJobs() {
    return this.rest.select('print_jobs', {
      select: '*,item:order_items(*,model:models(id,stl_path,analysis)),order:orders(id,number,status)',
      filters: [['status', 'eq', 'queued']], order: 'created_at.asc', limit: 50,
    });
  }

  async loadActiveJobs() {
    return this.rest.select('print_jobs', {
      select: '*,item:order_items(*,model:models(id,stl_path,analysis)),order:orders(id,number,status)',
      filters: [['status', 'in', ['slicing', 'printing']]], order: 'created_at.asc',
    });
  }

  async materialRow(code) {
    if (!this._materials) this._materials = Object.fromEntries((await this.rest.select('materials', {})).map((m) => [m.code, m]));
    return this._materials[code] || { code, nozzle_temp: 230, bed_temp: 60, density: 1.04 };
  }

  async setJob(id, patch) { await this.rest.update('print_jobs', [['id', 'eq', id]], patch); }
  async setPrinter(id, patch) { await this.rest.update('printers', [['id', 'eq', id]], { ...patch, last_seen: new Date(this.now()).toISOString() }); }
  async orderEvent(orderId, status, detail = '') {
    await this.rest.update('orders', [['id', 'eq', orderId]], { status });
    await this.rest.insert('order_events', [{ order_id: orderId, status, detail }]);
  }

  // ------------------------------------------------------------------ one pass
  async tick() {
    const printers = await this.loadPrinters();
    await this.handleTestRequest(printers);
    await this.watchRunning(printers);
    await this.resumeRunning(printers);
    await this.dispatch(printers);
  }

  /** Admin pressed "Test connection": settings row agent:test_printer = { id } */
  async handleTestRequest(printers) {
    const row = await this.rest.one('settings', { filters: [['key', 'eq', 'agent:test_printer']] });
    if (!row) return;
    const id = Number(row.value?.id ?? row.value);
    await this.rest.remove('settings', [['key', 'eq', 'agent:test_printer']]);
    const p = printers.find((x) => x.id === id);
    if (!p) return;
    try {
      const r = await this.driverFor(p).test();
      await this.setPrinter(id, { status: 'idle', status_detail: r.message || 'Connected' });
      this.log('info', `printer ${p.name}: ${r.message}`);
    } catch (err) {
      await this.setPrinter(id, { status: 'offline', status_detail: `Test failed: ${err.message}` });
      this.log('error', `printer ${p.name} test failed: ${err.message}`);
    }
  }

  /** Jobs that were printing when the agent last stopped: keep watching them. */
  async resumeRunning(printers) {
    const active = await this.loadActiveJobs();
    for (const job of active) {
      if (job.status === 'printing' && job.printer_id && !this.running.has(job.printer_id)) {
        const p = printers.find((x) => x.id === job.printer_id);
        if (p) this.running.set(p.id, { job, printer: p, driver: this.driverFor(p), startedMs: this.now(), sawPrinting: true });
      }
      if (job.status === 'slicing' && !this.running.has(job.printer_id)) {
        // the agent died mid-slice: slice again
        await this.setJob(job.id, { status: 'queued', printer_id: null, slot: null });
      }
    }
  }

  /** Poll the printers that are printing and move jobs to done/failed. */
  async watchRunning(printers) {
    for (const [printerId, run] of [...this.running]) {
      const p = printers.find((x) => x.id === printerId) || run.printer;
      let s;
      try { s = await run.driver.status(); } catch (err) {
        await this.setPrinter(p.id, { status: 'offline', status_detail: err.message });
        continue;
      }
      await this.setPrinter(p.id, { status: s.state, status_detail: s.message || s.file || '' });
      const progress = Math.max(0, Math.min(100, Math.round(s.progress || 0)));
      if (s.state === 'printing' || s.state === 'paused') {
        await this.setJob(run.job.id, { progress, status: s.state === 'paused' ? 'paused' : 'printing' });
      } else if (s.state === 'finished' || (s.state === 'idle' && this.now() - run.startedMs > 60000 && run.sawPrinting)) {
        await this.finishJob(run, 'done');
      } else if (s.state === 'error') {
        await this.failJob(run.job, p, s.message || 'printer error', run);
      } else if (s.state === 'idle' && this.now() - run.startedMs > 10 * 60000 && !run.sawPrinting) {
        await this.failJob(run.job, p, 'the printer never started the job', run);
      }
      if (s.state === 'printing') run.sawPrinting = true;
    }
  }

  async finishJob(run, status) {
    const job = run.job;
    await this.setJob(job.id, { status, progress: 100, finished_at: new Date(this.now()).toISOString() });
    this.running.delete(run.printer.id);
    this.log('info', `job ${job.id} ${status} on ${run.printer.name}`);
    await this.advanceOrder(job.order_id);
  }

  async failJob(job, printer, message, run = null) {
    const attempts = (job.attempts || 0) + 1;
    if (run) this.running.delete(printer.id);
    if (attempts < MAX_ATTEMPTS) {
      await this.setJob(job.id, { status: 'queued', attempts, error: message, printer_id: null, slot: null, progress: 0 });
      this.log('error', `job ${job.id} failed (attempt ${attempts}/${MAX_ATTEMPTS}): ${message} — back in the queue`);
    } else {
      await this.setJob(job.id, { status: 'failed', attempts, error: message, finished_at: new Date(this.now()).toISOString() });
      this.log('error', `job ${job.id} failed for good: ${message}`);
      await this.advanceOrder(job.order_id);
    }
  }

  /** Order status follows its jobs: printing while any runs, printed when all are done. */
  async advanceOrder(orderId) {
    const jobs = await this.rest.select('print_jobs', { select: 'id,status', filters: [['order_id', 'eq', orderId]] });
    const order = await this.rest.one('orders', { select: 'id,status', filters: [['id', 'eq', orderId]] });
    if (!order || !jobs.length) return;
    if (jobs.every((j) => j.status === 'done')) {
      if (order.status !== 'printed') await this.orderEvent(orderId, 'printed', `${jobs.length} part(s) printed`);
    } else if (jobs.some((j) => j.status === 'failed') && jobs.every((j) => ['done', 'failed', 'cancelled'].includes(j.status))) {
      if (order.status !== 'failed') await this.orderEvent(orderId, 'failed', 'a part could not be printed; needs attention');
    } else if (jobs.some((j) => ['printing', 'slicing'].includes(j.status)) && order.status !== 'printing') {
      await this.orderEvent(orderId, 'printing', '');
    }
  }

  /** Give queued jobs to free printers. */
  async dispatch(printers) {
    const queued = await this.loadQueuedJobs();
    const busy = new Set(this.running.keys());
    for (const job of queued) {
      if (job.order?.status && ['cancelled', 'refunded'].includes(job.order.status)) {
        await this.setJob(job.id, { status: 'cancelled' });
        continue;
      }
      const item = job.item;
      if (!item?.model) { await this.setJob(job.id, { waiting_reason: 'model missing' }); continue; }
      const pick = choosePrinter(printers, { material: item.material, color: item.color, sizeMm: item.size_mm }, busy);
      if (!pick.printer) {
        if (job.waiting_reason !== pick.reason) await this.setJob(job.id, { waiting_reason: pick.reason });
        continue;
      }
      busy.add(pick.printer.id);
      await this.startJob(job, pick.printer, pick.slot);
    }
  }

  async startJob(job, printer, slot) {
    const item = job.item;
    const attempt = (job.attempts || 0) + 1;
    const dataDir = this.config.DATA_DIR;
    try {
      await this.setJob(job.id, { status: 'slicing', printer_id: printer.id, slot, waiting_reason: '', progress: 0 });
      await this.setPrinter(printer.id, { status: 'slicing', status_detail: `job ${job.id}` });
      const modelsDir = path.join(dataDir, 'models');
      fs.mkdirSync(modelsDir, { recursive: true });
      const modelFile = path.join(modelsDir, `${item.model.id}.stl`);
      if (!fs.existsSync(modelFile)) fs.writeFileSync(modelFile, await this.rest.download('models', item.model.stl_path));
      const material = await this.materialRow(item.material);
      const supports = Boolean(item.model.analysis?.needsSupports || job.stats?.supports);
      const { file, fileName, stats } = await this.slicer({
        jobId: job.id, attempt, modelFile, scale: Number(item.scale) || 1, infill: Number(item.infill) || 35, supports,
        material, printer, type: printer.type, outDir: path.join(dataDir, 'gcode'), config: this.config,
      });
      const driver = this.driverFor(printer);
      await driver.start({ gcodePath: file, fileName, amsSlot: slot });
      const run = { job, printer, driver, startedMs: this.now(), sawPrinting: false };
      this.running.set(printer.id, run);
      await this.setJob(job.id, { status: 'printing', gcode_path: fileName, stats, started_at: new Date(this.now()).toISOString(), attempts: attempt, error: null });
      await this.setPrinter(printer.id, { status: 'printing', status_detail: fileName });
      this.log('info', `job ${job.id} (order ${job.order?.number}) started on ${printer.name}, slot ${slot}`, { printTimeSec: stats?.printTimeSec });
      await this.advanceOrder(job.order_id);
    } catch (err) {
      this.log('error', `job ${job.id} could not start: ${err.message}`);
      await this.failJob({ ...job, attempts: attempt - 1 }, printer, err.message, this.running.get(printer.id) ? { printer } : null);
      await this.setPrinter(printer.id, { status: 'idle', status_detail: `Last error: ${err.message}` }).catch(() => {});
    }
  }

  async loop() {
    this.log('info', `Prompt2Print print agent on ${os.hostname()} — drivers: ${Object.keys(DRIVERS).join(', ')}`);
    while (!this.stopped) {
      try { await this.tick(); } catch (err) { this.log('error', `tick failed: ${err.message}`); }
      await new Promise((r) => setTimeout(r, this.config.POLL_MS || POLL_MS));
    }
  }
}

// ------------------------------------------------------------------ main
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let cfg;
  try { cfg = loadConfig(); } catch (err) { console.error(err.message); process.exit(1); }
  const log = makeLogger(cfg.DATA_DIR);
  const rest = createRest({ url: cfg.SUPABASE_URL, serviceRoleKey: cfg.SUPABASE_SERVICE_ROLE_KEY });
  const agent = new Agent({ rest, config: cfg, log });
  const stop = () => { log('info', 'stopping…'); agent.stopped = true; setTimeout(() => process.exit(0), 500); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('uncaughtException', (e) => log('error', `uncaught: ${e.stack || e.message}`));
  process.on('unhandledRejection', (e) => log('error', `unhandled: ${e?.stack || e}`));
  agent.loop();
}
