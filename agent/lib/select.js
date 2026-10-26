// Printer selection: which printer should print a job? Pure functions, unit-tested.
//
// Rules:
//  • only active printers whose type's bed fits the part (with a margin), whose `materials` include the
//    job's material, and that have the material + colour loaded in one of their slots;
//  • the SMALLEST bed that fits wins (small parts go to the small printer, big ones keep the big printer free);
//  • a printer runs one job at a time.

const MARGIN_MM = 5;

export function bedOf(printer) {
  const b = printer.type?.bed || printer.bed || {};
  return { x: Number(b.x) || 0, y: Number(b.y) || 0, z: Number(b.z) || 0 };
}

export function bedVolume(printer) { const b = bedOf(printer); return b.x * b.y * b.z; }

/** Does a part of size [x, y, z] mm fit the printer's bed (either rotation on the plate)? */
export function fitsBed(printer, sizeMm, margin = MARGIN_MM) {
  const b = bedOf(printer);
  const [x, y, z] = (sizeMm || []).map(Number);
  if (!(x > 0 && y > 0 && z > 0)) return false;
  const fitXY = (x + margin <= b.x && y + margin <= b.y) || (y + margin <= b.x && x + margin <= b.y);
  return fitXY && z + margin <= b.z;
}

export function hasMaterial(printer, material) {
  const list = Array.isArray(printer.materials) ? printer.materials : [];
  return list.map((m) => String(m).toUpperCase()).includes(String(material).toUpperCase());
}

/** Slot number (1-based) holding this material+colour, or null. */
export function loadedSlot(printer, material, color) {
  const slots = Array.isArray(printer.slots) ? printer.slots : [];
  const hit = slots.find((s) => s && String(s.material || '').toUpperCase() === String(material).toUpperCase()
    && String(s.color || '').toLowerCase() === String(color).toLowerCase());
  return hit ? Number(hit.slot) || slots.indexOf(hit) + 1 : null;
}

/**
 * Choose a printer for a job.
 * @param printers  rows with .type (printer_types row), .materials, .slots, .active
 * @param job       { material, color, sizeMm: [x,y,z] }
 * @param busyIds   Set of printer ids already printing
 * @returns { printer, slot } or { printer: null, reason }
 */
export function choosePrinter(printers, job, busyIds = new Set()) {
  const active = printers.filter((p) => p.active);
  if (!active.length) return { printer: null, reason: 'no active printer' };
  const fitting = active.filter((p) => fitsBed(p, job.sizeMm));
  if (!fitting.length) {
    const s = (job.sizeMm || []).map((v) => Math.round(Number(v) || 0)).join('×');
    return { printer: null, reason: `part ${s} mm is too large for every printer` };
  }
  const withMaterial = fitting.filter((p) => hasMaterial(p, job.material));
  if (!withMaterial.length) return { printer: null, reason: `no printer prints ${job.material}` };
  const loaded = withMaterial.map((p) => ({ p, slot: loadedSlot(p, job.material, job.color) })).filter((x) => x.slot !== null);
  if (!loaded.length) return { printer: null, reason: `no printer has ${job.material} ${job.color} loaded` };
  const free = loaded.filter((x) => !busyIds.has(x.p.id));
  if (!free.length) return { printer: null, reason: 'waiting for a free printer' };
  free.sort((a, b) => bedVolume(a.p) - bedVolume(b.p) || a.p.id - b.p.id);
  return { printer: free[0].p, slot: free[0].slot, reason: '' };
}
