// Interactive 3D preview (rotate / zoom). Shows the reduced preview mesh only — there is no
// download, and the printable model file is never sent to the browser.
import * as THREE from '../vendor/three/three.module.min.js';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
// Runtime handles (functions url + auth headers) are published by supabase.js so this bundle
// stays independent of the main app bundle.
const rt = () => window.P2P_RT || { functionsUrl: '', authHeaders: async () => ({}) };

const LOOKS = {
  PLA: { roughness: 0.55, metalness: 0, clearcoat: 0.1 },
  PETG: { roughness: 0.28, metalness: 0, clearcoat: 0.45 },
  ABS: { roughness: 0.7, metalness: 0, clearcoat: 0 },
  TPU: { roughness: 0.85, metalness: 0, clearcoat: 0 },
  RESIN: { roughness: 0.22, metalness: 0, clearcoat: 0.6 },
};

const cache = new Map();

// Decode the "P2PV" preview format (quantised positions + indices).
async function fetchPreview(modelId) {
  if (cache.has(modelId)) return cache.get(modelId);
  const p = (async () => {
    const res = await fetch(`${rt().functionsUrl}/api/preview?model=${encodeURIComponent(modelId)}`, { headers: await rt().authHeaders(), cache: 'no-store' });
    if (!res.ok) throw new Error('Preview unavailable');
    const buf = await res.arrayBuffer();
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'P2PV') throw new Error('Bad preview');
    const wide = dv.getUint32(4, true) === 2;
    const nv = dv.getUint32(8, true);
    const nt = dv.getUint32(12, true);
    const min = [dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true)];
    const size = [dv.getFloat32(28, true), dv.getFloat32(32, true), dv.getFloat32(36, true)];
    const q = new Uint16Array(buf, 40, nv * 3);
    const QMAX = 2047;
    const pos = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      const x = min[0] + (q[i * 3] / QMAX) * size[0];
      const y = min[1] + (q[i * 3 + 1] / QMAX) * size[1];
      const z = min[2] + (q[i * 3 + 2] / QMAX) * size[2];
      // Model space is Z-up; three.js is Y-up.
      pos[i * 3] = x; pos[i * 3 + 1] = z; pos[i * 3 + 2] = -y;
    }
    let off = 40 + nv * 6;
    off += (4 - (off % 4)) % 4;
    const idx = wide ? new Uint32Array(buf, off, nt * 3) : new Uint16Array(buf, off, nt * 3);
    return creasedGeometry(pos, idx, 38);
  })();
  cache.set(modelId, p);
  p.catch(() => cache.delete(modelId));
  return p;
}

// Smooth shading on curves, crisp edges on corners.
function creasedGeometry(pos, idx, creaseDeg) {
  const nt = idx.length / 3;
  const out = new Float32Array(nt * 9);
  const faceN = new Float32Array(nt * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  const byVertex = new Map();
  for (let t = 0; t < nt; t++) {
    const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
    a.fromArray(pos, i0 * 3); b.fromArray(pos, i1 * 3); c.fromArray(pos, i2 * 3);
    ab.subVectors(b, a); ac.subVectors(c, a); ab.cross(ac);
    const area = ab.length();
    if (area > 0) ab.divideScalar(area);
    faceN[t * 3] = ab.x * area; faceN[t * 3 + 1] = ab.y * area; faceN[t * 3 + 2] = ab.z * area; // area-weighted
    out.set([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], t * 9);
    for (const v of [i0, i1, i2]) { let l = byVertex.get(v); if (!l) byVertex.set(v, (l = [])); l.push(t); }
  }
  const cos = Math.cos((creaseDeg * Math.PI) / 180);
  const normals = new Float32Array(nt * 9);
  const unit = (t) => { const x = faceN[t * 3], y = faceN[t * 3 + 1], z = faceN[t * 3 + 2]; const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
  for (let t = 0; t < nt; t++) {
    const n0 = unit(t);
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k];
      let sx = 0, sy = 0, sz = 0;
      for (const f of byVertex.get(v)) {
        const n = unit(f);
        if (n[0] * n0[0] + n[1] * n0[1] + n[2] * n0[2] >= cos) { sx += faceN[f * 3]; sy += faceN[f * 3 + 1]; sz += faceN[f * 3 + 2]; }
      }
      const l = Math.hypot(sx, sy, sz) || 1;
      normals.set([sx / l, sy / l, sz / l], t * 9 + k * 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function addLayerLines(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWorldY;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldY = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWorldY;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float lh = vWorldY / 0.2;
        float lw = fwidth(lh);
        float fade = clamp(1.0 - lw * 1.4, 0.0, 1.0);
        diffuseColor.rgb *= 1.0 - 0.07 * fade * (0.5 + 0.5 * cos(lh * 6.28318));`);
  };
}

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2'));
  } catch { return false; }
}

export function createViewer(container, { theme = 'light', bed = { x: 256, y: 256, z: 256 }, autoRotate = true, interactive = true } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = theme === 'dark' ? 1.35 : 1.0;
  renderer.localClippingEnabled = true;
  const canvas = renderer.domElement;
  canvas.className = 'viewer';
  canvas.setAttribute('role', 'img');
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  container.append(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 1, 5000);
  scene.add(new THREE.HemisphereLight(theme === 'dark' ? 0xbfd2ff : 0xf4f7ff, theme === 'dark' ? 0x1a1410 : 0xb8a898, theme === 'dark' ? 1.6 : 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-1.2, 2.2, 1.6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(theme === 'dark' ? 0xff7ab0 : 0xffffff, theme === 'dark' ? 1.2 : 0.7);
  rim.position.set(1.5, 1.0, -2);
  scene.add(rim);

  // Print bed: a grid the size of a real build plate, so the model's size is easy to judge.
  const bedGroup = new THREE.Group();
  const grid = new THREE.GridHelper(Math.max(bed.x, bed.y), Math.round(Math.max(bed.x, bed.y) / 16), theme === 'dark' ? 0x4a5563 : 0xc3c9cf, theme === 'dark' ? 0x323a45 : 0xdadfe3);
  grid.material.transparent = true;
  grid.material.opacity = theme === 'dark' ? 0.9 : 0.8;
  bedGroup.add(grid);
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(bed.x, bed.y), new THREE.MeshBasicMaterial({ color: theme === 'dark' ? 0x242b34 : 0xe9ecee, transparent: true, opacity: theme === 'dark' ? 0.9 : 0.5 }));
  plate.rotation.x = -Math.PI / 2;
  plate.position.y = -0.3;
  bedGroup.add(plate);
  scene.add(bedGroup);

  const clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
  const material = new THREE.MeshPhysicalMaterial({ color: 0xd6246e, roughness: 0.55, metalness: 0, clearcoat: 0.1, side: THREE.DoubleSide, clippingPlanes: [clip] });
  addLayerLines(material);
  const mesh = new THREE.Mesh(undefined, material);
  scene.add(mesh);

  // Nozzle for the print animation.
  const nozzle = new THREE.Group();
  const brass = new THREE.MeshStandardMaterial({ color: 0xc9a34a, metalness: 0.9, roughness: 0.3 });
  const tip = new THREE.Mesh(new THREE.ConeGeometry(3.2, 7, 24), brass);
  tip.rotation.x = Math.PI;
  tip.position.y = 3.5;
  const block = new THREE.Mesh(new THREE.BoxGeometry(16, 10, 16), new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.4 }));
  block.position.y = 12;
  nozzle.add(tip, block);
  nozzle.visible = false;
  scene.add(nozzle);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.autoRotate = autoRotate;
  controls.autoRotateSpeed = 1.2;
  controls.enabled = interactive;
  controls.addEventListener('start', () => { controls.autoRotate = false; });

  let scale = 1;
  let disposed = false;
  let anim = null;

  function fit() {
    if (!mesh.geometry) return;
    const box = mesh.geometry.boundingBox.clone();
    box.min.multiplyScalar(scale); box.max.multiplyScalar(scale);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 20);
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.08;
    const dir = new THREE.Vector3(0.9, 0.55, 1.15).normalize();
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.near = dist / 100; camera.far = dist * 20;
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.minDistance = radius * 1.1;
    controls.maxDistance = dist * 3;
    controls.update();
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  renderer.setAnimationLoop((time) => {
    if (disposed) return;
    if (anim) anim(time);
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    async load(modelId, { color, material: mat } = {}) {
      const geometry = await fetchPreview(modelId);
      if (disposed) return;
      // Centre on the bed (the stored model already sits at z = 0).
      const g = geometry.clone();
      const bb = g.boundingBox;
      g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
      g.computeBoundingBox();
      g.computeBoundingSphere();
      mesh.geometry?.dispose?.();
      mesh.geometry = g;
      if (color) this.setColor(color);
      if (mat) this.setMaterial(mat);
      clip.constant = 1e6;
      fit();
    },
    setColor(hex) {
      material.color.set(hex);
      const clear = /^#(d8e4e8|dce6ea)$/i.test(hex);
      material.transparent = clear;
      material.opacity = clear ? 0.72 : 1;
      material.transmission = 0;
    },
    setMaterial(code) {
      const look = LOOKS[code] || LOOKS.PLA;
      material.roughness = look.roughness;
      material.clearcoat = look.clearcoat;
      material.metalness = look.metalness;
      material.needsUpdate = true;
    },
    setScale(s, refit = false) {
      scale = s;
      mesh.scale.setScalar(s);
      if (refit) fit();
    },
    refit: fit,
    // Show the model being printed layer by layer.
    printAnimation({ duration = 7000, onProgress } = {}) {
      return new Promise((resolve) => {
        if (!mesh.geometry) return resolve();
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        const h = mesh.geometry.boundingBox.max.y * scale;
        const r = Math.max(mesh.geometry.boundingSphere.radius * scale * 0.55, 10);
        if (reduce) { clip.constant = 1e6; onProgress?.(1, h); return resolve(); }
        nozzle.visible = true;
        let start = null;
        anim = (time) => {
          if (start === null) start = time;
          const p = Math.min(1, (time - start) / duration);
          const eased = p;
          const y = h * eased;
          clip.constant = y;
          const angle = time / 140;
          nozzle.position.set(Math.cos(angle) * r * (0.4 + 0.6 * Math.abs(Math.sin(time / 900))), y + 0.4, Math.sin(angle) * r * 0.8);
          onProgress?.(p, y);
          if (p >= 1) {
            clip.constant = 1e6;
            nozzle.visible = false;
            anim = null;
            resolve();
          }
        };
      });
    },
    setAutoRotate(on) { controls.autoRotate = on; },
    dispose() {
      disposed = true;
      ro.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      mesh.geometry?.dispose?.();
      material.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}


