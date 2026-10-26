// OctoPrint REST API driver (https://docs.octoprint.org/en/master/api/).
// Needs the printer's base URL (e.g. http://192.168.1.50) and an Application/API key.

import fs from 'node:fs';

export function octoprintDriver(printer) {
  const base = String(printer.url || '').replace(/\/+$/, '');
  const headers = { 'X-Api-Key': printer.api_key || '' };

  async function call(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body && !(body instanceof FormData) ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(method === 'POST' && body instanceof FormData ? 300000 : 8000),
    });
    if (!res.ok && res.status !== 204) throw new Error(`OctoPrint ${path} → HTTP ${res.status}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  return {
    async status() {
      const job = await call('GET', '/api/job');
      const state = String(job?.state || '');
      const completion = job?.progress?.completion ?? 0;
      const file = job?.job?.file?.name || '';
      if (/^Printing|^Pausing|^Resuming|^Starting/.test(state)) return { state: 'printing', progress: completion, remainingSec: job.progress.printTimeLeft, file };
      if (/^Paused/.test(state)) return { state: 'paused', progress: completion, file };
      if (/^Error/.test(state)) return { state: 'error', progress: completion, message: job.error || state };
      if (/^Offline|^Closed/.test(state)) return { state: 'offline', progress: 0, message: state };
      if (completion >= 100 && file) return { state: 'finished', progress: 100, file };
      return { state: 'idle', progress: 0, file };
    },
    async start({ gcodePath, fileName }) {
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(gcodePath)]), fileName);
      form.append('select', 'true');
      form.append('print', 'true');
      await call('POST', '/api/files/local', form);
    },
    pause: () => call('POST', '/api/job', { command: 'pause', action: 'pause' }),
    resume: () => call('POST', '/api/job', { command: 'pause', action: 'resume' }),
    cancel: () => call('POST', '/api/job', { command: 'cancel' }),
    async test() {
      const v = await call('GET', '/api/version');
      return { ok: true, message: `Connected to OctoPrint ${v?.server || ''}` };
    },
  };
}
