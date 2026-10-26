// Slicing: model + customer settings (material, size, infill) → G-code for a printer.
// Uses an external PrusaSlicer-compatible command-line slicer when one is configured in
// Admin → Printing (recommended for production quality); otherwise the built-in slicer runs in a
// background thread so the shop stays responsive.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { getSetting } from '../db.js';
import { modelFilePath } from '../models.js';
import { config } from '../config.js';

// Only PrusaSlicer-compatible command-line slicers are accepted.
export const SLICER_NAME_RX = /^(prusa-?slicer|super-?slicer)(-console)?(\.exe)?$/i;

export function slicerSettings({ material, printer, infill, supports }) {
  return {
    layerHeight: material.process === 'resin' ? 0.05 : 0.2,
    infillPercent: infill,
    supports: Boolean(supports),
    material: {
      code: material.code,
      nozzleTemp: material.nozzle_temp || 210,
      bedTemp: material.bed_temp || 60,
      densityGcm3: material.density,
      filamentDiameterMm: 1.75,
      fanPercent: material.code === 'ABS' ? 20 : material.code === 'PETG' ? 50 : 100,
    },
    printer: { name: printer.name, bed: printer.bed, flavor: printer.flavor || 'marlin' },
  };
}

function runBuiltin(job) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./slice-worker.js', import.meta.url), { workerData: job });
    worker.once('message', (msg) => (msg.ok ? resolve(msg.stats) : reject(new Error(msg.error))));
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`Slicer stopped (code ${code})`)); });
  });
}

function runExternal(slicerPath, job) {
  const { modelFile, scale, settings, outFile, profile } = job;
  const args = [
    '--export-gcode',
    ...(profile ? ['--load', profile] : []),
    '--scale', `${(scale * 100).toFixed(2)}%`,
    '--fill-density', `${settings.infillPercent}%`,
    '--temperature', String(settings.material.nozzleTemp),
    '--bed-temperature', String(settings.material.bedTemp),
    '--center', `${settings.printer.bed.x / 2},${settings.printer.bed.y / 2}`,
    ...(settings.supports ? ['--support-material'] : []),
    '--output', outFile,
    modelFile,
  ];
  return new Promise((resolve, reject) => {
    execFile(slicerPath, args, { timeout: 10 * 60e3, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`External slicer failed: ${stderr || err.message}`));
      const tail = fs.readFileSync(outFile, 'utf8').slice(-40000);
      const time = tail.match(/estimated printing time.*?=\s*(.+)/);
      const grams = tail.match(/filament used \[g\]\s*=\s*([\d.]+)/);
      const toSec = (s) => (s || '').split(/\s+/).reduce((t, part) => {
        const m = part.match(/(\d+)([dhms])/);
        return m ? t + Number(m[1]) * { d: 86400, h: 3600, m: 60, s: 1 }[m[2]] : t;
      }, 0);
      resolve({ printTimeSec: toSec(time?.[1]), filamentGrams: grams ? Number(grams[1]) : null, external: true });
    });
  });
}

/** Slice one print job. Returns { gcodeFile, stats }. */
export async function sliceForPrinter({ jobId, modelId, scale, infill, material, printer, supports, attempt = 1, heightMm = 50, unitWeightG = 0 }) {
  if (material.process === 'resin') {
    // Resin (MSLA) printers don't use G-code: they need a layer-image file from the printer maker's
    // slicer (e.g. Chitubox/Lychee/UVtools). We write a job ticket and estimate time from the height.
    const layers = Math.ceil(heightMm / 0.05);
    const ticket = { jobId, modelId, scale, layerHeightMm: 0.05, exposureSec: 2.5, bottomLayers: 6, supports: Boolean(supports), printer: printer.name };
    const fileName = `job-${jobId}-resin-${attempt}.json`;
    fs.writeFileSync(path.join(config.gcodeDir, fileName), JSON.stringify(ticket, null, 2));
    return { gcodeFile: fileName, stats: { layers, layerHeight: 0.05, printTimeSec: Math.round(layers * 3.2 + 240), filamentGrams: unitWeightG, sizeMm: null, slicer: 'resin-ticket', warnings: [] } };
  }
  const settings = slicerSettings({ material, printer, infill, supports });
  const fileName = `job-${jobId}-${printer.flavor || 'marlin'}-${attempt}.gcode`;
  const outFile = path.join(config.gcodeDir, fileName);
  const job = { modelFile: modelFilePath(modelId), scale, settings: { ...settings, jobName: `P2P job ${jobId}` }, outFile, profile: printer.slicer_profile || null };
  const external = process.env.SLICER_PATH || (config.desktop ? getSetting('slicer_path', '') : '') || '';
  let stats;
  if (external && SLICER_NAME_RX.test(path.basename(external)) && fs.existsSync(external)) stats = await runExternal(external, job);
  else stats = await runBuiltin(job);
  return { gcodeFile: fileName, stats: { ...stats, slicer: external ? path.basename(external) : 'built-in', host: os.hostname() } };
}
