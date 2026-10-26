// A virtual printer for testing the whole flow without hardware.
// Print time = the slicer's estimate divided by the simulation speed (Admin → Printing settings).
// State is stored on the printer row so it survives an app restart.

import { get, run, getSetting, parseJson } from '../../db.js';

function load(printerId) {
  const row = get('SELECT status_detail FROM printers WHERE id = ?', printerId);
  return parseJson(row?.status_detail, null);
}
function save(printerId, state) {
  run('UPDATE printers SET status_detail = ? WHERE id = ?', [state ? JSON.stringify(state) : null, printerId]);
}

export function simulatorDriver(printer) {
  return {
    async status() {
      const s = load(printer.id);
      if (!s || !s.jobId) return { state: 'idle', progress: 0 };
      if (s.failed) return { state: 'error', progress: s.progressAtFail, message: s.failed };
      const now = Date.now();
      const elapsed = (s.pausedAt ? s.pausedAt : now) - s.startMs - (s.pausedTotal || 0);
      const progress = Math.min(100, (elapsed / s.durMs) * 100);
      if (s.failAt && progress >= s.failAt) {
        save(printer.id, { ...s, failed: 'Simulated failure: filament runout', progressAtFail: progress });
        return { state: 'error', progress, message: 'Simulated failure: filament runout' };
      }
      if (progress >= 100) return { state: 'finished', progress: 100, jobId: s.jobId };
      return {
        state: s.pausedAt ? 'paused' : 'printing',
        progress,
        remainingSec: Math.max(0, ((s.durMs - elapsed) / 1000) * (s.speed || 1)),
        jobId: s.jobId,
      };
    },
    async start({ job, stats }) {
      const speed = Math.max(1, Number(getSetting('simulator_speed', 400)));
      const printSec = Math.max(60, stats?.printTimeSec || 1800);
      const failRate = Number(getSetting('simulator_failure_rate', 0)) / 100;
      save(printer.id, {
        jobId: job.id,
        startMs: Date.now(),
        durMs: Math.max(8000, (printSec / speed) * 1000),
        speed,
        failAt: Math.random() < failRate ? 20 + Math.random() * 60 : null,
      });
    },
    async pause() {
      const s = load(printer.id);
      if (s && !s.pausedAt) save(printer.id, { ...s, pausedAt: Date.now() });
    },
    async resume() {
      const s = load(printer.id);
      if (s && s.pausedAt) save(printer.id, { ...s, pausedTotal: (s.pausedTotal || 0) + Date.now() - s.pausedAt, pausedAt: null });
    },
    async cancel() { save(printer.id, null); },
    async reset() { save(printer.id, null); },
    async test() { return { ok: true, message: 'Simulated printer is ready.' }; },
  };
}
