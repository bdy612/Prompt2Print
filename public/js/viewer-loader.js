// The 3D viewer (Three.js) is a separate bundle loaded the first time a page needs it, so the
// shop opens fast. In development (ES modules) it is simply imported.
export function webglAvailable() {
  try { return Boolean(document.createElement('canvas').getContext('webgl2')); } catch { return false; }
}

let loading = null;
export function loadViewer() {
  if (window.P2PViewer) return Promise.resolve(window.P2PViewer);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    if (document.querySelector('script[type="module"][src$="app.js"]')) {
      // dev mode (ES modules served by any static server): import the module directly
      new Function('return import("./viewer.js")')().then(resolve, reject);
      return;
    }
    const sc = document.createElement('script');
    sc.src = 'viewer.js';
    sc.async = true;
    sc.onload = () => (window.P2PViewer ? resolve(window.P2PViewer) : reject(new Error('Viewer failed to load')));
    sc.onerror = () => reject(new Error('Viewer failed to load'));
    document.head.append(sc);
  });
  loading.catch(() => { loading = null; });
  return loading;
}
