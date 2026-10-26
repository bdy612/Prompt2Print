// Slicing with Bambu Studio's command line for a Bambu Lab P2S (0.4 mm nozzle).
//
// Bambu printers expect jobs made by Bambu's own slicing engine, so instead of our built-in
// slicer we call bambu-studio.exe (or OrcaSlicer) and ship the sliced .3mf to the printer
// (Metadata/plate_1.gcode inside it, started with the "project_file" command, see drivers/bambu.js).
//
// The CLI wants FULL config files, not the partial "inherits" profiles that ship with Bambu Studio
// in resources/profiles/BBL. We resolve the inherit chains ourselves from the installed copy:
//   machine : "Bambu Lab P2S 0.4 nozzle"  → fdm_bbl_3dp_001_common → fdm_machine_common
//   process : "0.20mm Standard @BBL P2S" → fdm_process_single_0.20 → fdm_process_single_common → fdm_process_common
//   filament: "Bambu ABS @BBL P2S" → Bambu ABS @base → fdm_filament_abs → fdm_filament_common
//             "Bambu ASA @BBL P2S 0.4 nozzle" → Bambu ASA @base → fdm_filament_asa → fdm_filament_common
// Reference: https://github.com/bambulab/BambuStudio/wiki/Command-Line-Usage

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';

export const BAMBU_STUDIO_RX = /^(bambu-studio(-console)?|bambustudio|orca-slicer(-console)?|orcaslicer)(\.exe)?$/i;

const WINDOWS_CANDIDATES = [
  'C:\\Program Files\\Bambu Studio\\bambu-studio.exe',
  'C:\\Program Files\\BambuStudio\\bambu-studio.exe',
  'C:\\Program Files\\OrcaSlicer\\orca-slicer.exe',
];

/** Path of an installed Bambu Studio / OrcaSlicer executable, or null. */
export function findBambuStudio() {
  const env = process.env.BAMBU_STUDIO_PATH;
  if (env && BAMBU_STUDIO_RX.test(path.basename(env)) && fs.existsSync(env)) return env;
  if (process.platform !== 'win32') return null;
  const local = process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'Bambu Studio', 'bambu-studio.exe')] : [];
  for (const p of [...WINDOWS_CANDIDATES, ...local]) if (fs.existsSync(p)) return p;
  return null;
}

/** resources/profiles folder next to the executable (…\Bambu Studio\resources\profiles). */
export function resourcesDirFor(exe) {
  const dir = path.join(path.dirname(exe), 'resources', 'profiles');
  return fs.existsSync(path.join(dir, 'BBL')) ? dir : null;
}

/**
 * Read BBL/<kind>/<name>.json and follow its `inherits` chain, merging child over parent,
 * so the result is a complete config the CLI accepts.
 */
export function resolveProfile(resourcesDir, kind, name, seen = new Set()) {
  const file = path.join(resourcesDir, 'BBL', kind, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Bambu Studio profile not found: ${kind}/${name}.json`);
  if (seen.has(name)) throw new Error(`Profile inherits loop at ${name}`);
  seen.add(name);
  const own = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { inherits, ...rest } = own;
  const base = inherits ? resolveProfile(resourcesDir, kind, inherits, seen) : {};
  const merged = { ...base, ...rest };
  delete merged.inherits;
  return merged;
}

const PROFILE_NAMES = {
  P2S: {
    machine: (nozzle) => `Bambu Lab P2S ${nozzle} nozzle`,
    process: () => '0.20mm Standard @BBL P2S',
    filament: {
      ABS: (nozzle) => (nozzle === '0.4' ? 'Bambu ABS @BBL P2S' : `Bambu ABS @BBL P2S ${nozzle} nozzle`),
      ASA: (nozzle) => `Bambu ASA @BBL P2S ${nozzle} nozzle`,
    },
  },
  P1S: {
    machine: (nozzle) => `Bambu Lab P1S ${nozzle} nozzle`,
    process: () => '0.20mm Standard @BBL P1S',
    filament: {
      ABS: (nozzle) => `Bambu ABS @BBL P1S ${nozzle} nozzle`,
      ASA: (nozzle) => `Bambu ASA @BBL X1C${nozzle === '0.4' ? '' : ` ${nozzle} nozzle`}`,
    },
  },
};

export function profileNames({ printerModel = 'P2S', nozzle = 0.4, material = 'ABS' } = {}) {
  const set = PROFILE_NAMES[printerModel] || PROFILE_NAMES.P2S;
  const n = typeof nozzle === 'number' ? nozzle.toFixed(1) : String(nozzle);
  const fil = set.filament[material];
  if (!fil) throw new Error(`No Bambu filament profile for ${material}`);
  return { machine: set.machine(n), process: set.process(), filament: fil(n) };
}

/**
 * Full machine/process/filament configs for one job, with our durability settings applied.
 * settings: { wallLoops=5, infillPercent=35, infillPattern='gyroid', layerHeight=0.2, supports=false, brim=true }
 */
export function buildConfigs({ resourcesDir, printerModel = 'P2S', nozzle = 0.4, material = 'ABS', settings = {} }) {
  const names = profileNames({ printerModel, nozzle, material });
  const machine = resolveProfile(resourcesDir, 'machine', names.machine);
  const process = resolveProfile(resourcesDir, 'process', names.process);
  const filament = resolveProfile(resourcesDir, 'filament', names.filament);
  const s = {
    wallLoops: 5, infillPercent: 35, infillPattern: 'gyroid', layerHeight: 0.2, supports: false, brim: true,
    topLayers: 5, bottomLayers: 4, ...settings,
  };
  Object.assign(process, {
    wall_loops: String(Math.max(2, Math.round(s.wallLoops))),
    sparse_infill_density: `${Math.min(100, Math.max(0, Math.round(s.infillPercent)))}%`,
    sparse_infill_pattern: s.infillPattern,
    layer_height: String(s.layerHeight),
    top_shell_layers: String(s.topLayers),
    bottom_shell_layers: String(s.bottomLayers),
    enable_support: s.supports ? '1' : '0',
    support_type: 'tree(auto)',
    brim_type: s.brim ? 'auto_brim' : 'no_brim',
    enable_prime_tower: '0', // single colour: no purge tower
    timelapse_type: '0',
  });
  // The CLI wants plain-name configs (no system "from"/"setting_id" ties).
  for (const c of [machine, process, filament]) { c.from = 'User'; delete c.setting_id; delete c.instantiation; }
  return { machine, process, filament, names };
}

// Minimal ZIP reader (stored + deflate entries) -------------------------------------------------
export function readZipEntries(buf) {
  // Locate the end-of-central-directory record.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Bad central directory');
    const method = buf.readUInt16LE(off + 10);
    const compressed = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26), lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compressed);
    entries.set(name, { method, read: () => (method === 8 ? zlib.inflateRawSync(data) : method === 0 ? Buffer.from(data) : null) });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Print time (s), filament grams and layer count from a sliced Bambu .3mf. */
export function readSliceStats(zipBuffer) {
  const entries = readZipEntries(zipBuffer);
  const stats = { printTimeSec: null, filamentGrams: null, layers: null, warnings: [], hasGcode: entries.has('Metadata/plate_1.gcode') };
  const info = entries.get('Metadata/slice_info.config')?.read()?.toString('utf8');
  if (info) {
    const meta = (key) => info.match(new RegExp(`<metadata\\s+key="${key}"\\s+value="([^"]*)"`))?.[1];
    const pred = Number(meta('prediction'));
    const weight = Number(meta('weight'));
    if (Number.isFinite(pred) && pred > 0) stats.printTimeSec = Math.round(pred);
    if (Number.isFinite(weight) && weight > 0) stats.filamentGrams = Math.round(weight * 100) / 100;
    if (meta('outside') === 'true') stats.warnings.push('Toolpath is outside the printable area');
    if (!stats.filamentGrams) {
      // Sum per-filament used_g when the plate-level weight is missing.
      let total = 0;
      for (const m of info.matchAll(/<filament\b[^>]*\bused_g="([\d.]+)"/g)) total += Number(m[1]);
      if (total > 0) stats.filamentGrams = Math.round(total * 100) / 100;
    }
  } else {
    stats.warnings.push('slice_info.config missing from the 3mf');
  }
  const gcode = stats.hasGcode ? entries.get('Metadata/plate_1.gcode').read()?.toString('latin1') : '';
  if (gcode) {
    const layers = gcode.match(/^; total layer number:\s*(\d+)/m) || gcode.match(/;LAYER_COUNT:(\d+)/);
    if (layers) stats.layers = Number(layers[1]);
    if (!stats.printTimeSec) {
      const t = gcode.match(/^; model printing time: ([^;\n]+);/m)?.[1] || gcode.match(/^; estimated printing time.*?=\s*(.+)$/m)?.[1];
      if (t) stats.printTimeSec = t.trim().split(/\s+/).reduce((s, part) => { const m = part.match(/(\d+)([dhms])/); return m ? s + Number(m[1]) * { d: 86400, h: 3600, m: 60, s: 1 }[m[2]] : s; }, 0) || null;
    }
    if (!stats.filamentGrams) {
      const g = gcode.match(/^; total filament weight \[g\]\s*:\s*([\d.]+)/m) || gcode.match(/^; filament used \[g\]\s*=\s*([\d.]+)/m);
      if (g) stats.filamentGrams = Number(g[1]);
    }
  } else {
    stats.warnings.push('Metadata/plate_1.gcode missing: the plate was not sliced');
  }
  return stats;
}

/** The argument list we hand to bambu-studio.exe (exported for logging and tests). */
export function cliArgs({ machineFile, processFile, filamentFile, scale, outDir, outName, modelFile }) {
  return [
    '--load-settings', `${machineFile};${processFile}`,
    '--load-filaments', filamentFile,
    '--orient', '0',
    '--arrange', '1',
    ...(scale && Math.abs(scale - 1) > 1e-6 ? ['--scale', String(scale)] : []),
    '--slice', '0',
    '--export-3mf', outName,
    '--outputdir', outDir,
    '--debug', '1',
    modelFile,
  ];
}

/**
 * Slice `modelFile` (STL, mm, already at the customer's size unless `scale` is given) and return
 * { file: '<outDir>/<jobName>.3mf', stats: { printTimeSec, filamentGrams, layers, warnings } }.
 */
export async function sliceWithBambuStudio({ exe, resourcesDir, modelFile, scale = 1, outDir, jobName = 'job', printerModel = 'P2S', nozzle = 0.4, material = 'ABS', settings = {}, timeoutMs = 15 * 60e3 }) {
  const exePath = exe || findBambuStudio();
  if (!exePath) throw new Error('Bambu Studio is not installed (set BAMBU_STUDIO_PATH or install it in C:\\Program Files\\Bambu Studio).');
  const res = resourcesDir || resourcesDirFor(exePath);
  if (!res) throw new Error('Bambu Studio profiles folder (resources/profiles) not found next to the executable.');
  const { machine, process: proc, filament, names } = buildConfigs({ resourcesDir: res, printerModel, nozzle, material, settings });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-bambu-'));
  const machineFile = path.join(tmp, 'machine.json'), processFile = path.join(tmp, 'process.json'), filamentFile = path.join(tmp, 'filament.json');
  fs.writeFileSync(machineFile, JSON.stringify(machine));
  fs.writeFileSync(processFile, JSON.stringify(proc));
  fs.writeFileSync(filamentFile, JSON.stringify(filament));
  fs.mkdirSync(outDir, { recursive: true });
  const outName = `${jobName}.3mf`;
  const args = cliArgs({ machineFile, processFile, filamentFile, scale, outDir, outName, modelFile });
  try {
    await new Promise((resolve, reject) => {
      execFile(exePath, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(new Error(`Bambu Studio failed (${err.code ?? err.signal}): ${(stderr || stdout || err.message).toString().slice(-800)}`));
        else resolve();
      });
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // The CLI writes the file into --outputdir (some versions honour only the base name).
  let file = path.join(outDir, outName);
  if (!fs.existsSync(file)) {
    const alt = fs.readdirSync(outDir).filter((f) => f.endsWith('.3mf')).map((f) => path.join(outDir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    if (!alt) throw new Error('Bambu Studio finished but produced no .3mf');
    file = alt;
  }
  const stats = readSliceStats(fs.readFileSync(file));
  if (!stats.hasGcode) throw new Error(`Bambu Studio did not slice the plate: ${stats.warnings.join('; ')}`);
  return { file, stats: { ...stats, profiles: names, slicer: path.basename(exePath) } };
}
