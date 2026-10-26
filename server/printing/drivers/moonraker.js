// Klipper printers through the Moonraker API (https://moonraker.readthedocs.io).
// Needs the printer's base URL (e.g. http://192.168.1.60:7125) and, if enabled, an API key.

import fs from 'node:fs';

export function moonrakerDriver(printer) {
  const base = String(printer.url || '').replace(/\/+$/, '');
  const headers = printer.api_key ? { 'X-Api-Key': printer.api_key } : {};

  async function call(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(body instanceof FormData ? 300000 : 8000),
    });
    if (!res.ok) throw new Error(`Moonraker ${path} → HTTP ${res.status}`);
    return res.json().catch(() => null);
  }

  return {
    async status() {
      const r = await call('GET', '/printer/objects/query?print_stats&virtual_sdcard');
      const ps = r?.result?.status?.print_stats || {};
      const progress = (r?.result?.status?.virtual_sdcard?.progress || 0) * 100;
      const file = ps.filename || '';
      switch (ps.state) {
        case 'printing': return { state: 'printing', progress, file };
        case 'paused': return { state: 'paused', progress, file };
        case 'complete': return { state: 'finished', progress: 100, file };
        case 'error': return { state: 'error', progress, message: ps.message || 'Klipper error', file };
        default: return { state: 'idle', progress: 0, file };
      }
    },
    async start({ gcodePath, fileName }) {
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(gcodePath)]), fileName);
      form.append('root', 'gcodes');
      form.append('print', 'true');
      await call('POST', '/server/files/upload', form);
    },
    pause: () => call('POST', '/printer/print/pause'),
    resume: () => call('POST', '/printer/print/resume'),
    cancel: () => call('POST', '/printer/print/cancel'),
    async test() {
      const r = await call('GET', '/server/info');
      return { ok: true, message: `Connected to Moonraker (Klipper ${r?.result?.klippy_state || 'unknown'})` };
    },
  };
}
