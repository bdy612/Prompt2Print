// Builds the stand-alone app bundle (app-dist/): one classic script, loadable from file:// by the
// Windows launcher or from any static host. Usage: node scripts/build-app.mjs
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const out = path.join(root, 'app-dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const common = { bundle: true, minify: true, sourcemap: false, target: ['es2020', 'chrome100'], legalComments: 'none', logLevel: 'warning', define: { 'process.env.NODE_ENV': '"production"' } };
await build({ ...common, entryPoints: [path.join(pub, 'js/app.js')], outfile: path.join(out, 'app.js'), format: 'iife' });
await build({ ...common, entryPoints: [path.join(pub, 'js/viewer.js')], outfile: path.join(out, 'viewer.js'), format: 'iife', globalName: 'P2PViewer' });

fs.copyFileSync(path.join(pub, 'css/app.css'), path.join(out, 'app.css'));
fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });
for (const f of fs.readdirSync(path.join(pub, 'vendor/fonts'))) fs.copyFileSync(path.join(pub, 'vendor/fonts', f), path.join(out, 'fonts', f));
fs.cpSync(path.join(pub, 'img'), path.join(out, 'img'), { recursive: true });

const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8')
  .replace('<link rel="stylesheet" href="css/app.css">', `<link rel="stylesheet" href="app.css?v=${pkg.version}">`)
  .replace('<script type="module" src="js/app.js"></script>', `<script src="app.js?v=${pkg.version}" defer></script>`);
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, 'version.txt'), `${pkg.version}\n`);

const size = (f) => `${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)} KB`;
console.log(`app-dist built: app.js ${size('app.js')}, viewer.js ${size('viewer.js')}, app.css ${size('app.css')}`);
