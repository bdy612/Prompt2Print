// The cart lives on this device (localStorage). Prices are recomputed live and the `checkout`
// Edge Function re-prices every line on the server before an order is created.
const KEY = 'p2p_cart';

export function cartLines() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function saveCart(lines) {
  try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* storage unavailable */ }
  return lines;
}
export const cartCount = () => cartLines().reduce((s, l) => s + (Number(l.quantity) || 1), 0);

export function addLine(line) {
  const lines = cartLines();
  const same = (a, b) => a.kind === b.kind && a.productId === b.productId && a.designId === b.designId && a.material === b.material
    && a.color === b.color && Math.abs(a.scale - b.scale) < 1e-6 && a.infill === b.infill;
  const existing = lines.find((l) => same(l, line));
  if (existing) existing.quantity = Math.min(50, existing.quantity + (line.quantity || 1));
  else lines.push({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2), ...line, quantity: line.quantity || 1 });
  return saveCart(lines);
}
export function updateLine(id, patch) {
  const lines = cartLines().map((l) => (l.id === id ? { ...l, ...patch } : l));
  return saveCart(lines);
}
export function removeLine(id) {
  return saveCart(cartLines().filter((l) => l.id !== id));
}
export function clearCart() { return saveCart([]); }
