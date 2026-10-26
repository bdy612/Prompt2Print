// The print queue and dispatcher.
//
// After payment: every ordered copy becomes a print job → sliced to G-code → waits in the queue →
// sent to the next free printer that has the material and a big enough bed → progress is read back
// from the printer → when every copy is done the order becomes "Printed".
//
// Order status: Paid → In print queue → Printing → Printed (automatic) → Packed → Shipped → Delivered (staff)
// Safety: a finished print stays on the bed, so a real printer waits for staff to confirm the bed
// is clear before it gets the next job (simulated printers clear themselves).

import path from 'node:path';
import { all, get, run, tx, parseJson, getSetting } from '../db.js';
import { config } from '../config.js';
import { fitsBuildVolume } from '../mesh/analyze.js';
import { getModel } from '../models.js';
import { sliceForPrinter } from './slicer.js';
import { createDriver } from './drivers/index.js';
import { setStatus, addEvent } from '../orders.js';
import { bad, notFound } from '../lib/http.js';

const log = (...a) => console.log('[print]', ...a);

function printers({ activeOnly = true } = {}) {
  return all(`SELECT * FROM printers ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY id`).map((p) => ({
    ...p, bed: parseJson(p.bed), materials: parseJson(p.materials, []), ams: parseJson(p.ams, null),
  }));
}

function jobContext(job) {
  const item = get('SELECT * FROM order_items WHERE id = ?', job.order_item_id);
  const material = get('SELECT * FROM materials WHERE code = ?', item.material);
  const analysis = getModel(job.model_id).analysis;
  const sizeMm = analysis.bbox.size.map((v) => v * item.scale);
  return { item, material, sizeMm };
}

// Which AMS slot holds this job's material + colour (null when the printer has no AMS list).
export function amsSlotFor(printer, item) {
  if (!Array.isArray(printer.ams) || !printer.ams.length) return null;
  const slot = printer.ams.find((s) => s && s.material === item.material && s.color === item.color);
  return slot ? Number(slot.slot) : -1; // -1 = this colour is not loaded
}

function canPrint(printer, ctx) {
  if (!printer.materials.includes(ctx.item.material) || !fitsBuildVolume(ctx.sizeMm, printer.bed)) return false;
  return amsSlotFor(printer, ctx.item) !== -1;
}

// Why a job is waiting, for the queue page.
function waitingReason(ctx) {
  const anyMaterial = printers().some((p) => p.materials.includes(ctx.item.material) && fitsBuildVolume(ctx.sizeMm, p.bed));
  if (anyMaterial) return `Load ${ctx.item.color} ${ctx.item.material} in the AMS, then update the printer's slots`;
  return `Waiting for a printer that can print ${ctx.item.material} at this size`;
}

const profileKey = (p) => `${p.flavor || 'marlin'}:${p.bed.x}x${p.bed.y}x${p.bed.z}:${p.slicer_profile || ''}`;

// Called by markPaid() once payment is confirmed.
export function enqueueOrder(orderId) {
  tx(() => {
    let pos = get('SELECT COALESCE(MAX(position), 0) AS p FROM print_jobs').p;
    for (const item of all('SELECT * FROM order_items WHERE order_id = ?', orderId)) {
      for (let copy = 1; copy <= item.quantity; copy++) {
        pos += 1;
        run(`INSERT INTO print_jobs(order_id, order_item_id, copy_index, model_id, status, position) VALUES(?, ?, ?, ?, 'queued', ?)`,
          [orderId, item.id, copy, item.model_id, pos]);
      }
    }
    setStatus(orderId, 'in_queue');
  });
  log(`order ${orderId} queued`);
  kick();
}

export function cancelOrderJobs(orderId) {
  for (const job of all("SELECT * FROM print_jobs WHERE order_id = ? AND status NOT IN ('printed','cancelled')", orderId)) {
    cancelJob(job.id).catch((e) => log('cancel failed', e.message));
  }
}

// Worker loop ----------------------------------------------------------------------------------
let running = false;
let timer = null;
let slicing = false;

export function startPrintWorker(intervalMs = 2000) {
  if (timer) return;
  // Jobs that were mid-slice when the app closed go back to the queue.
  run("UPDATE print_jobs SET status = 'queued' WHERE status = 'slicing'");
  timer = setInterval(tick, intervalMs);
  tick();
}

export function stopPrintWorker() { clearInterval(timer); timer = null; }

export function kick() { setImmediate(tick); }

async function tick() {
  if (running) return;
  running = true;
  try {
    await syncPrinters();
    sliceNext(); // runs in the background
    await dispatch();
    updateOrders();
  } catch (err) {
    log('tick error:', err.message);
  } finally {
    running = false;
  }
}

async function syncPrinters() {
  const autoClearSim = getSetting('simulator_auto_clear', true);
  for (const p of printers()) {
    let st;
    try {
      st = await createDriver(p).status();
    } catch (err) {
      run("UPDATE printers SET status = 'offline', status_detail = CASE WHEN driver = 'simulator' THEN status_detail ELSE ? END WHERE id = ?", [err.message.slice(0, 200), p.id]);
      continue;
    }
    run("UPDATE printers SET last_seen = datetime('now'), progress = ? WHERE id = ?", [p.current_job_id ? Math.round((st.progress || 0) * 10) / 10 : 0, p.id]);
    const job = p.current_job_id ? get('SELECT * FROM print_jobs WHERE id = ?', p.current_job_id) : null;

    if (job) {
      if (st.state === 'printing') {
        run("UPDATE print_jobs SET status = 'printing', progress = ?, updated_at = datetime('now') WHERE id = ?", [st.progress, job.id]);
        run("UPDATE printers SET status = 'printing' WHERE id = ?", p.id);
      } else if (st.state === 'paused') {
        run("UPDATE print_jobs SET status = 'paused', progress = ?, updated_at = datetime('now') WHERE id = ?", [st.progress, job.id]);
        run("UPDATE printers SET status = 'paused' WHERE id = ?", p.id);
      } else if (st.state === 'finished') {
        run("UPDATE print_jobs SET status = 'printed', progress = 100, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", job.id);
        const clearNow = p.driver === 'simulator' && autoClearSim;
        if (p.driver === 'simulator') await createDriver(p).reset();
        run('UPDATE printers SET status = ?, current_job_id = NULL, progress = 0 WHERE id = ?', [clearNow ? 'idle' : 'awaiting_clear', p.id]);
        log(`job ${job.id} printed on ${p.name}`);
      } else if (st.state === 'idle' && job.started_at && Date.now() - Date.parse(`${job.started_at.replace(' ', 'T')}Z`) < 90e3) {
        // Just uploaded: some printers report idle for a moment before the print starts.
      } else if (st.state === 'error' || st.state === 'idle' || st.state === 'offline') {
        const reason = st.state === 'error' ? st.message || 'Printer error' : st.state === 'offline' ? 'Printer went offline' : 'Printer stopped without finishing';
        run("UPDATE print_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?", [reason, job.id]);
        run("UPDATE printers SET status = 'error', status_detail = CASE WHEN driver = 'simulator' THEN status_detail ELSE ? END, current_job_id = NULL WHERE id = ?", [reason, p.id]);
        log(`job ${job.id} failed on ${p.name}: ${reason}`);
      }
    } else if (p.status === 'offline' || (p.status === 'printing' && st.state === 'idle')) {
      run("UPDATE printers SET status = 'idle' WHERE id = ?", p.id);
    } else if (st.state === 'error' && p.status !== 'error') {
      run("UPDATE printers SET status = 'error' WHERE id = ?", p.id);
    }
  }
}

function pickPrinterFor(ctx) {
  return printers().find((p) => canPrint(p, ctx)) || null;
}

async function sliceNext() {
  if (slicing) return;
  // The first waiting job that some active printer can take. Jobs nobody can print (for example
  // resin while the resin printer is off) wait with a note and don't hold up the rest.
  let job = null, ctx = null, target = null;
  for (const candidate of all("SELECT * FROM print_jobs WHERE status = 'queued' AND held = 0 ORDER BY position")) {
    const c = jobContext(candidate);
    const p = pickPrinterFor(c);
    if (p) { job = candidate; ctx = c; target = p; break; }
    if (!candidate.error) run('UPDATE print_jobs SET error = ? WHERE id = ?', [waitingReason(c), candidate.id]);
  }
  if (!job) return;
  slicing = true;
  run("UPDATE print_jobs SET status = 'slicing', error = NULL, updated_at = datetime('now') WHERE id = ?", job.id);
  try {
    const result = await sliceJob(job, ctx, target);
    run("UPDATE print_jobs SET status = 'ready', gcode_file = ?, stats = ?, sliced_for = ?, updated_at = datetime('now') WHERE id = ? AND status = 'slicing'",
      [result.gcodeFile, JSON.stringify(result.stats), profileKey(target), job.id]);
    log(`job ${job.id} sliced (${Math.round(result.stats.printTimeSec / 60)} min, ${result.stats.filamentGrams?.toFixed?.(1)} g)`);
  } catch (err) {
    run("UPDATE print_jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ? AND status = 'slicing'", [`Slicing failed: ${err.message}`.slice(0, 400), job.id]);
    log(`job ${job.id} slicing failed:`, err.message);
  } finally {
    slicing = false;
    kick();
  }
}

function sliceJob(job, ctx, printer) {
  return sliceForPrinter({
    jobId: job.id, modelId: job.model_id, scale: ctx.item.scale, infill: ctx.item.infill, material: ctx.material,
    printer, supports: Boolean(ctx.item.needs_supports), attempt: job.attempts + 1,
    heightMm: ctx.sizeMm[2], unitWeightG: ctx.item.weight_g / ctx.item.quantity,
  });
}

async function dispatch() {
  const idle = printers().filter((p) => p.status === 'idle' && !p.current_job_id);
  if (!idle.length) return;
  const ready = all("SELECT * FROM print_jobs WHERE status = 'ready' AND held = 0 ORDER BY position");
  const taken = new Set();
  for (const p of idle) {
    for (const job of ready) {
      if (taken.has(job.id)) continue;
      const ctx = jobContext(job);
      if (!canPrint(p, ctx)) continue;
      taken.add(job.id);
      try {
        let { gcode_file: gcodeFile, stats } = job;
        stats = parseJson(stats, {});
        if (job.sliced_for !== profileKey(p)) { // different printer type: slice again for this one
          const r = await sliceJob(job, ctx, p);
          gcodeFile = r.gcodeFile; stats = r.stats;
          run('UPDATE print_jobs SET gcode_file = ?, stats = ?, sliced_for = ? WHERE id = ?', [gcodeFile, JSON.stringify(stats), profileKey(p), job.id]);
        }
        // Staff may have cancelled or paused the job (or refunded the order) while we sliced.
        const fresh = get('SELECT status, held FROM print_jobs WHERE id = ?', job.id);
        if (fresh?.status !== 'ready' || fresh.held) continue;
        const amsSlot = amsSlotFor(p, ctx.item);
        await createDriver(p).start({ job, stats, gcodePath: path.join(config.gcodeDir, gcodeFile), fileName: gcodeFile, amsSlot: amsSlot > 0 ? amsSlot : null });
        run('UPDATE print_jobs SET ams_slot = ? WHERE id = ?', [amsSlot > 0 ? amsSlot : null, job.id]);
        const started = tx(() => {
          const r = run(`UPDATE print_jobs SET status = 'printing', printer_id = ?, progress = 0, attempts = attempts + 1, started_at = datetime('now'),
               error = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'ready' AND held = 0`, [p.id, job.id]);
          if (!r.changes) return false;
          run("UPDATE printers SET status = 'printing', current_job_id = ?, progress = 0 WHERE id = ?", [job.id, p.id]);
          const order = get('SELECT status FROM orders WHERE id = ?', job.order_id);
          if (order.status === 'in_queue') setStatus(job.order_id, 'printing');
          return true;
        });
        if (!started) { // cancelled during the upload: stop it on the printer again
          await createDriver(p).cancel().catch(() => {});
          run("UPDATE printers SET status = ? WHERE id = ?", [p.driver === 'simulator' ? 'idle' : 'awaiting_clear', p.id]);
          break; // this printer is done for this round
        }
        log(`job ${job.id} started on ${p.name}`);
      } catch (err) {
        run("UPDATE print_jobs SET error = ?, updated_at = datetime('now') WHERE id = ?", [`Could not start on ${p.name}: ${err.message}`.slice(0, 400), job.id]);
        run("UPDATE printers SET status = 'error', status_detail = CASE WHEN driver = 'simulator' THEN status_detail ELSE ? END WHERE id = ?", [err.message.slice(0, 200), p.id]);
        log(`job ${job.id} could not start on ${p.name}:`, err.message);
      }
      break; // one job per printer
    }
  }
}

function updateOrders() {
  for (const o of all("SELECT id, status FROM orders WHERE status IN ('in_queue', 'printing')")) {
    const jobs = all("SELECT status FROM print_jobs WHERE order_id = ? AND status != 'cancelled'", o.id);
    if (jobs.length && jobs.every((j) => j.status === 'printed')) {
      setStatus(o.id, 'printed');
      log(`order ${o.id} fully printed`);
    }
  }
}

// Staff controls (admin panel) ----------------------------------------------------------------
function jobOrThrow(id) {
  const job = get('SELECT * FROM print_jobs WHERE id = ?', id);
  if (!job) throw notFound('Print job not found.');
  return job;
}

export function moveJob(id, direction) {
  const job = jobOrThrow(id);
  const open = all("SELECT id, position FROM print_jobs WHERE status IN ('queued','slicing','ready') ORDER BY position");
  const i = open.findIndex((j) => j.id === job.id);
  if (i < 0) throw bad('Only waiting jobs can be reordered.');
  const j = direction === 'top' ? 0 : direction === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= open.length || j === i) return;
  if (direction === 'top') {
    run('UPDATE print_jobs SET position = ? WHERE id = ?', [open[0].position - 1, job.id]);
  } else {
    tx(() => {
      run('UPDATE print_jobs SET position = ? WHERE id = ?', [open[j].position, open[i].id]);
      run('UPDATE print_jobs SET position = ? WHERE id = ?', [open[i].position, open[j].id]);
    });
  }
  kick();
}

export async function pauseJob(id) {
  const job = jobOrThrow(id);
  if (job.status === 'printing') {
    const p = printers().find((x) => x.id === job.printer_id);
    await createDriver(p).pause();
    run("UPDATE print_jobs SET status = 'paused' WHERE id = ?", id);
    run("UPDATE printers SET status = 'paused' WHERE id = ?", p.id);
  } else if (['queued', 'ready'].includes(job.status)) {
    run('UPDATE print_jobs SET held = 1 WHERE id = ?', id);
  } else throw bad(`A ${job.status} job can't be paused.`);
}

export async function resumeJob(id) {
  const job = jobOrThrow(id);
  if (job.status === 'paused') {
    const p = printers().find((x) => x.id === job.printer_id);
    await createDriver(p).resume();
    run("UPDATE print_jobs SET status = 'printing' WHERE id = ?", id);
    run("UPDATE printers SET status = 'printing' WHERE id = ?", p.id);
  } else {
    run('UPDATE print_jobs SET held = 0 WHERE id = ?', id);
  }
  kick();
}

export async function cancelJob(id) {
  const job = jobOrThrow(id);
  if (['printing', 'paused'].includes(job.status) && job.printer_id) {
    const p = printers({ activeOnly: false }).find((x) => x.id === job.printer_id);
    if (p) {
      await createDriver(p).cancel().catch(() => {});
      run("UPDATE printers SET status = ?, current_job_id = NULL, progress = 0 WHERE id = ?", [p.driver === 'simulator' ? 'idle' : 'awaiting_clear', p.id]);
    }
  }
  run("UPDATE print_jobs SET status = 'cancelled', held = 0, updated_at = datetime('now') WHERE id = ?", id);
  kick();
}

export function reprintJob(id) {
  const job = jobOrThrow(id);
  if (!['failed', 'cancelled', 'printed'].includes(job.status)) throw bad('Only failed, cancelled or printed jobs can be reprinted.');
  const order = get('SELECT * FROM orders WHERE id = ?', job.order_id);
  if (['cancelled', 'refunded'].includes(order.status)) throw bad(`The order is ${order.status}.`);
  run(`UPDATE print_jobs SET status = ?, progress = 0, error = NULL, held = 0, printer_id = NULL, started_at = NULL, finished_at = NULL,
       updated_at = datetime('now') WHERE id = ?`, [job.gcode_file ? 'ready' : 'queued', id]);
  if (['printed', 'packed'].includes(order.status)) setStatus(order.id, 'in_queue', `Reprint of job #${id}`);
  else addEvent(order.id, order.status, `Reprint of job #${id}`);
  kick();
}

export function clearPrinter(id) {
  const p = get('SELECT * FROM printers WHERE id = ?', id);
  if (!p) throw notFound('Printer not found.');
  if (!['awaiting_clear', 'error', 'offline'].includes(p.status)) return;
  if (p.driver === 'simulator') run('UPDATE printers SET status_detail = NULL WHERE id = ?', id);
  // A job that was still marked as printing on this printer can't finish any more: mark it failed
  // so staff can reprint it (instead of the order waiting forever).
  if (p.current_job_id) {
    run("UPDATE print_jobs SET status = 'failed', error = 'Printer was reset before the job finished', updated_at = datetime('now') WHERE id = ? AND status IN ('printing','paused')", p.current_job_id);
  }
  run("UPDATE printers SET status = 'idle', current_job_id = NULL, progress = 0 WHERE id = ?", id);
  kick();
}

export async function testPrinter(printerRow) {
  const p = { ...printerRow, bed: parseJson(printerRow.bed, printerRow.bed), materials: parseJson(printerRow.materials, printerRow.materials) };
  return createDriver(p).test();
}

export function queueSnapshot() {
  const jobs = all(`
    SELECT j.*, o.number AS order_number, i.title_en, i.title_ar, i.material, i.color, i.color_hex, i.scale, i.infill, i.thumb,
           p.name AS printer_name
    FROM print_jobs j
    JOIN orders o ON o.id = j.order_id
    JOIN order_items i ON i.id = j.order_item_id
    LEFT JOIN printers p ON p.id = j.printer_id
    WHERE j.status NOT IN ('printed', 'cancelled') OR j.updated_at > datetime('now', '-1 day')
    ORDER BY CASE j.status WHEN 'printing' THEN 0 WHEN 'paused' THEN 1 WHEN 'slicing' THEN 2 WHEN 'ready' THEN 3 WHEN 'queued' THEN 4 WHEN 'failed' THEN 5 ELSE 6 END, j.position`);
  return jobs.map((j) => ({ ...j, stats: parseJson(j.stats) }));
}
