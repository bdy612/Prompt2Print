import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  resolveProfile, buildConfigs, profileNames, readZipEntries, readSliceStats, findBambuStudio, cliArgs, BAMBU_STUDIO_RX,
} from '../server/printing/bambu-slicer.js';

// A fake resources/profiles/BBL tree with the real P2S profile names and 3–4 level inherits chains.
function fakeResources() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbl-'));
  const w = (kind, name, obj) => {
    fs.mkdirSync(path.join(root, 'BBL', kind), { recursive: true });
    fs.writeFileSync(path.join(root, 'BBL', kind, `${name}.json`), JSON.stringify(obj));
  };
  w('machine', 'fdm_machine_common', { type: 'machine', printable_height: '250', machine_max_speed_x: ['500'], gcode_flavor: 'marlin' });
  w('machine', 'fdm_bbl_3dp_001_common', { inherits: 'fdm_machine_common', printable_height: '256', nozzle_diameter: ['0.4'] });
  w('machine', 'Bambu Lab P2S 0.4 nozzle', { inherits: 'fdm_bbl_3dp_001_common', instantiation: 'true', setting_id: 'GM999', from: 'system', printer_model: 'Bambu Lab P2S', printer_variant: '0.4' });
  w('process', 'fdm_process_common', { type: 'process', wall_loops: '2', sparse_infill_density: '15%', sparse_infill_pattern: 'grid', enable_support: '0', enable_prime_tower: '1', top_shell_layers: '3', bottom_shell_layers: '3', layer_height: '0.2', brim_type: 'auto_brim' });
  w('process', 'fdm_process_single_common', { inherits: 'fdm_process_common', wall_loops: '3' });
  w('process', 'fdm_process_single_0.20', { inherits: 'fdm_process_single_common', layer_height: '0.2' });
  w('process', '0.20mm Standard @BBL P2S', { inherits: 'fdm_process_single_0.20', instantiation: 'true', outer_wall_speed: ['200'], compatible_printers: ['Bambu Lab P2S 0.4 nozzle'] });
  w('filament', 'fdm_filament_common', { type: 'filament', filament_density: ['1.24'], nozzle_temperature: ['220'] });
  w('filament', 'fdm_filament_abs', { inherits: 'fdm_filament_common', filament_type: ['ABS'], nozzle_temperature: ['260'], filament_density: ['1.04'] });
  w('filament', 'Bambu ABS @base', { inherits: 'fdm_filament_abs', filament_vendor: ['Bambu Lab'] });
  w('filament', 'Bambu ABS @BBL P2S', { inherits: 'Bambu ABS @base', instantiation: 'true', nozzle_temperature: ['270'] });
  w('filament', 'fdm_filament_asa', { inherits: 'fdm_filament_common', filament_type: ['ASA'] });
  w('filament', 'Bambu ASA @base', { inherits: 'fdm_filament_asa', filament_vendor: ['Bambu Lab'] });
  w('filament', 'Bambu ASA @BBL P2S 0.4 nozzle', { inherits: 'Bambu ASA @base', instantiation: 'true', nozzle_temperature: ['275'] });
  return root;
}

test('resolveProfile follows a multi-level inherits chain, child wins, no inherits key left', () => {
  const root = fakeResources();
  const m = resolveProfile(root, 'machine', 'Bambu Lab P2S 0.4 nozzle');
  assert.equal(m.printable_height, '256');          // middle level overrides base
  assert.equal(m.gcode_flavor, 'marlin');           // from the base
  assert.equal(m.printer_model, 'Bambu Lab P2S');   // from the leaf
  assert.equal(m.inherits, undefined);
  const p = resolveProfile(root, 'process', '0.20mm Standard @BBL P2S');
  assert.equal(p.wall_loops, '3');
  assert.equal(p.sparse_infill_pattern, 'grid');
  assert.throws(() => resolveProfile(root, 'filament', 'Nope'), /not found/);
});

test('profile names for P2S ABS/ASA', () => {
  assert.deepEqual(profileNames({ material: 'ABS' }), { machine: 'Bambu Lab P2S 0.4 nozzle', process: '0.20mm Standard @BBL P2S', filament: 'Bambu ABS @BBL P2S' });
  assert.equal(profileNames({ material: 'ASA' }).filament, 'Bambu ASA @BBL P2S 0.4 nozzle');
  assert.throws(() => profileNames({ material: 'PLA' }), /No Bambu filament/);
});

test('buildConfigs applies the durability overrides', () => {
  const root = fakeResources();
  const { machine, process, filament, names } = buildConfigs({ resourcesDir: root, material: 'ASA', settings: { wallLoops: 5, infillPercent: 35, supports: true } });
  assert.equal(process.wall_loops, '5');
  assert.equal(process.sparse_infill_density, '35%');
  assert.equal(process.sparse_infill_pattern, 'gyroid');
  assert.equal(process.enable_support, '1');
  assert.equal(process.support_type, 'tree(auto)');
  assert.equal(process.top_shell_layers, '5');
  assert.equal(process.bottom_shell_layers, '4');
  assert.equal(process.enable_prime_tower, '0');
  assert.equal(process.brim_type, 'auto_brim');
  assert.equal(machine.setting_id, undefined);
  assert.equal(filament.nozzle_temperature[0], '275');
  assert.equal(filament.filament_type[0], 'ASA');
  assert.equal(names.filament, 'Bambu ASA @BBL P2S 0.4 nozzle');
  const noSupport = buildConfigs({ resourcesDir: root, settings: { supports: false, brim: false } }).process;
  assert.equal(noSupport.enable_support, '0');
  assert.equal(noSupport.brim_type, 'no_brim');
});

// Build a zip by hand: local headers + central directory + EOCD.
function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  for (const [name, content, method] of files) {
    const raw = Buffer.from(content);
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc32(raw), 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    parts.push(local, nameBuf, data);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

test('zip reader + slice stats from a Bambu-style 3mf', () => {
  const sliceInfo = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header><header_item key="X-BBL-Client-Type" value="slicer"/></header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="printer_model_id" value="C13"/>
    <metadata key="prediction" value="5423"/>
    <metadata key="weight" value="41.27"/>
    <metadata key="outside" value="false"/>
    <metadata key="support_used" value="false"/>
    <filament id="1" tray_info_idx="GFB00" type="ABS" color="#000000" used_m="13.76" used_g="41.27" />
  </plate>
</config>`;
  const gcode = '; HEADER_BLOCK_START\n; BambuStudio 02.03.00.70\n; model printing time: 1h 30m 23s; total estimated time: 1h 32m\n; total layer number: 312\n; HEADER_BLOCK_END\nG28\n';
  const zip = makeZip([
    ['[Content_Types].xml', '<Types/>', 0],
    ['Metadata/slice_info.config', sliceInfo, 8],
    ['Metadata/plate_1.gcode', gcode, 8],
  ]);
  const entries = readZipEntries(zip);
  assert.equal(entries.get('[Content_Types].xml').read().toString(), '<Types/>');
  assert.equal(entries.get('Metadata/plate_1.gcode').read().toString(), gcode);
  const s = readSliceStats(zip);
  assert.equal(s.printTimeSec, 5423);
  assert.equal(s.filamentGrams, 41.27);
  assert.equal(s.layers, 312);
  assert.equal(s.hasGcode, true);
  assert.deepEqual(s.warnings, []);
  // Without slice_info: fall back to G-code comments.
  const s2 = readSliceStats(makeZip([['Metadata/plate_1.gcode', `${gcode}; total filament weight [g] : 40.5\n`, 8]]));
  assert.equal(s2.printTimeSec, 5423);
  assert.equal(s2.filamentGrams, 40.5);
  assert.ok(s2.warnings[0].includes('slice_info'));
  const s3 = readSliceStats(makeZip([['Metadata/slice_info.config', sliceInfo, 0]]));
  assert.equal(s3.hasGcode, false);
});

test('findBambuStudio returns null here, and the name filter is strict', () => {
  const saved = process.env.BAMBU_STUDIO_PATH;
  delete process.env.BAMBU_STUDIO_PATH;
  if (process.platform !== 'win32') assert.equal(findBambuStudio(), null);
  process.env.BAMBU_STUDIO_PATH = saved ?? '';
  if (saved === undefined) delete process.env.BAMBU_STUDIO_PATH;
  for (const ok of ['bambu-studio.exe', 'Bambu-Studio.exe', 'orca-slicer.exe', 'OrcaSlicer']) assert.ok(BAMBU_STUDIO_RX.test(ok), ok);
  for (const bad of ['cmd.exe', 'evil-bambu-studio.exe', 'bambu-studio.bat']) assert.ok(!BAMBU_STUDIO_RX.test(bad), bad);
});

test('cliArgs matches the documented command line', () => {
  const args = cliArgs({ machineFile: 'm.json', processFile: 'p.json', filamentFile: 'f.json', scale: 1, outDir: 'out', outName: 'job-7.3mf', modelFile: 'model.stl' });
  assert.deepEqual(args.slice(0, 4), ['--load-settings', 'm.json;p.json', '--load-filaments', 'f.json']);
  assert.ok(args.includes('--slice') && args[args.indexOf('--slice') + 1] === '0');
  assert.ok(args.includes('--export-3mf') && args[args.indexOf('--export-3mf') + 1] === 'job-7.3mf');
  assert.ok(!args.includes('--scale'));
  assert.equal(args.at(-1), 'model.stl');
  assert.ok(cliArgs({ machineFile: 'm', processFile: 'p', filamentFile: 'f', scale: 1.5, outDir: 'o', outName: 'x.3mf', modelFile: 'y' }).includes('--scale'));
});
