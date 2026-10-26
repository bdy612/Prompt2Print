// Slicing for the agent: STL + job settings → a print file for the chosen printer.
//
//   Bambu printers      → Bambu Studio / OrcaSlicer CLI (.3mf) when installed, else the built-in slicer (.gcode)
//   Prusa / Klipper / OctoPrint → PrusaSlicer-compatible CLI (.gcode) when installed, else the built-in slicer
//
// Durability defaults match the shop rules: 5 walls, gyroid infill (30–40 %), 0.2 mm layers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { findBambuStudio, sliceWithBambuStudio } from './bambu-slicer.js';

export const SLICER_NAME_RX = /^(prusa-?slicer|super-?slicer|orca-?slicer)(-console)?(\.exe)?$/i;
export const PRINT_DEFAULTS = { wallLoops: 5, infillPattern: 'gyroid', topLayers: 5, bottomLayers: 4, layerHeight: 0.2, brim: true };

const WINDOWS_PRUSA = [
  'C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe',
  'C:\\Program Files\\PrusaSlicer\\prusa-slicer-console.exe',
];

export function findPrusaSlicer(configured) {
  const c = configured || process.env.SLICER_PATH;
  if (c && SLICER_NAME_RX.test(path.basename(c)) && fs.existsSync(c)) return c;
  if (process.platform !== 'win32') return null;
  for (const p of WINDOWS_PRUSA) if (fs.existsSync(p)) return p;
  return null;
}

export function slicerSettings({ material, printer, infill, supports }) {
  const code = String(material.code || '').toUpperCase();
  return {
    layerHeight: PRINT_DEFAULTS.layerHeight,
    wallLoops: PRINT_DEFAULTS.wallLoops,
    topLayers: PRINT_DEFAULTS.topLayers,
    bottomLayers: PRINT_DEFAULTS.bottomLayers,
    infillPercent: infill,
    supports: Boolean(supports),
    material: {
      code,
      nozzleTemp: material.nozzle_temp || 230,
      bedTemp: material.bed_temp || 60,
      densityGcm3: Number(material.density) || 1.04,
      filamentDiameterMm: 1.75,
      fanPercent: code === 'ABS' || code === 'ASA' ? 20 : code === 'PETG' ? 50 : 100,
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

function runPrusaCli(slicerPath, { modelFile, scale, settings, outFile, printerProfile, processProfile }) {
  const args = [
    '--export-gcode',
    ...(printerProfile ? ['--load', printerProfile] : []),
    ...(processProfile ? ['--load', processProfile] : []),
    '--scale', `${(scale * 100).toFixed(2)}%`,
    '--fill-density', `${settings.infillPercent}%`,
    '--fill-pattern', PRINT_DEFAULTS.infillPattern,
    '--perimeters', String(PRINT_DEFAULTS.wallLoops),
    '--top-solid-layers', String(PRINT_DEFAULTS.topLayers),
    '--bottom-solid-layers', String(PRINT_DEFAULTS.bottomLayers),
    '--temperature', String(settings.material.nozzleTemp),
    '--bed-temperature', String(settings.material.bedTemp),
    '--center', `${settings.printer.bed.x / 2},${settings.printer.bed.y / 2}`,
    ...(settings.supports ? ['--support-material'] : []),
    '--output', outFile,
    modelFile,
  ];
  return new Promise((resolve, reject) => {
    execFile(slicerPath, args, { timeout: 10 * 60e3, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
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

/**
 * Slice one job.
 * @param opts { jobId, attempt, modelFile, scale, infill, supports, material (row), printer { name, driver, bed, flavor, nozzle_mm },
 *               type (printer_types row), outDir, config { BAMBU_STUDIO_PATH, SLICER_PATH } }
 * @returns { file, fileName, stats }
 */
export async function sliceJob(opts) {
  const { jobId, attempt = 1, modelFile, scale = 1, infill = 35, supports = false, material, printer, type, outDir, config = {} } = opts;
  fs.mkdirSync(outDir, { recursive: true });
  const settings = slicerSettings({ material, printer, infill, supports });
  const jobName = `p2p-job-${jobId}-${attempt}`;

  if (printer.driver === 'bambu') {
    const exe = findBambuStudio() || (config.BAMBU_STUDIO_PATH && fs.existsSync(config.BAMBU_STUDIO_PATH) ? config.BAMBU_STUDIO_PATH : null);
    if (exe) {
      const nozzle = Number(printer.nozzle_mm) || 0.4;
      const n = nozzle.toFixed(1);
      const machine = type?.slicer_printer_profile || `Bambu Lab P2S ${n} nozzle`;
      const process_ = type?.slicer_process_profile || '0.20mm Standard @BBL P2S';
      const model = (machine.match(/Bambu Lab (.+?) [\d.]+ nozzle/) || [])[1] || 'P2S';
      const filament = `Bambu ${settings.material.code} @BBL ${model}${n === '0.4' && settings.material.code === 'ABS' && model === 'P2S' ? '' : ` ${n} nozzle`}`;
      const r = await sliceWithBambuStudio({
        exe, modelFile, scale, outDir, jobName, material: settings.material.code, nozzle,
        settings: { ...PRINT_DEFAULTS, infillPercent: infill, supports },
        profiles: { machine, process: process_, filament },
      });
      return { file: r.file, fileName: path.basename(r.file), stats: { ...r.stats, host: os.hostname() } };
    }
  }

  const fileName = `${jobName}.gcode`;
  const outFile = path.join(outDir, fileName);
  const job = { modelFile, scale, settings: { ...settings, jobName }, outFile };
  const external = printer.driver === 'bambu' ? null : findPrusaSlicer(config.SLICER_PATH);
  const stats = external ? await runPrusaCli(external, job) : await runBuiltin(job);
  return { file: outFile, fileName, stats: { ...stats, slicer: external ? path.basename(external) : 'built-in', host: os.hostname() } };
}
