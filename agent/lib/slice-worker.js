// Runs the built-in slicer in a background thread.
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { parseSTL } from './mesh/formats.js';
import { scaleMesh } from './mesh/core.js';
import { sliceMesh } from './builtin-slicer.js';

try {
  const { modelFile, scale, settings, outFile } = workerData;
  const mesh = scaleMesh(parseSTL(fs.readFileSync(modelFile)), scale);
  const { gcode, stats } = sliceMesh(mesh, settings);
  fs.writeFileSync(outFile, gcode);
  parentPort.postMessage({ ok: true, stats });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
