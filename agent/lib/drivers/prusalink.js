// Prusa printers (MK4/MK4S/CORE One/XL/MINI) through PrusaLink's HTTP API.
// Printer settings needed: address (http://ip), API key (printer screen → Settings → Network → PrusaLink).

import fs from 'node:fs';

export function prusalinkDriver(printer) {
  const base = String(printer.url || '').replace(/\/+$/, '');
  const headers = { 'X-Api-Key': printer.api_key || printer.access_code || '' };

  async function call(method, path, { body, raw, timeoutMs = 8000, extra = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...headers, ...extra, ...(body && !raw ? { 'Content-Type': 'application/json' } : {}) },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok && res.status !== 204) throw new Error(`PrusaLink ${path} → HTTP ${res.status}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  return {
    async status() {
      const s = await call('GET', '/api/v1/status');
      const job = s?.job || {};
      const state = String(s?.printer?.state || '').toUpperCase();
      const progress = Number(job.progress || 0);
      const file = job.file?.display_name || job.file?.name || '';
      switch (state) {
        case 'PRINTING': return { state: 'printing', progress, remainingSec: job.time_remaining, file };
        case 'PAUSED': return { state: 'paused', progress, file };
        case 'FINISHED': return { state: 'finished', progress: 100, file };
        case 'ERROR': case 'ATTENTION': return { state: 'error', progress, message: `Printer state ${state}`, file };
        case 'BUSY': return { state: 'printing', progress, file };
        default: return { state: 'idle', progress: 0, file };
      }
    },
    async start({ gcodePath, fileName }) {
      // Upload to the USB drive and start right away.
      await call('PUT', `/api/v1/files/usb/${encodeURIComponent(fileName)}`, {
        raw: true, body: fs.readFileSync(gcodePath), timeoutMs: 300000,
        extra: { 'Content-Type': 'application/octet-stream', 'Print-After-Upload': '?1', 'Overwrite': '?1' },
      });
    },
    pause: () => call('PUT', '/api/v1/job/0/pause').catch(() => call('PUT', '/api/v1/job/pause')),
    resume: () => call('PUT', '/api/v1/job/0/resume').catch(() => call('PUT', '/api/v1/job/resume')),
    cancel: () => call('DELETE', '/api/v1/job/0').catch(() => call('DELETE', '/api/v1/job')),
    async test() {
      const v = await call('GET', '/api/version');
      return { ok: true, message: `Connected to PrusaLink ${v?.server || ''} (${v?.hostname || ''})` };
    },
  };
}
