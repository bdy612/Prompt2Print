// Print agent: printer selection, PostgREST query builder and the dispatch loop with fakes (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choosePrinter, fitsBed, loadedSlot } from '../agent/lib/select.js';
import { buildQuery, createRest } from '../agent/lib/rest.js';
import { Agent } from '../agent/index.js';

const type = (bed, driver = 'bambu') => ({ bed, driver, slots: 4 });
const printers = [
  { id: 1, name: 'P2S', active: true, type: type({ x: 256, y: 256, z: 256 }), materials: ['ABS', 'ASA'],
    slots: [{ slot: 1, material: 'ABS', color: 'black' }, { slot: 2, material: 'ABS', color: 'white' }, { slot: 4, material: 'ASA', color: 'white' }] },
  { id: 2, name: 'A1 mini', active: true, type: type({ x: 180, y: 180, z: 180 }), materials: ['ABS'],
    slots: [{ slot: 1, material: 'ABS', color: 'black' }] },
  { id: 3, name: 'K1 Max', active: true, type: type({ x: 300, y: 300, z: 300 }, 'moonraker'), materials: ['ABS', 'ASA'],
    slots: [{ slot: 1, material: 'ABS', color: 'black' }] },
  { id: 4, name: 'off', active: false, type: type({ x: 500, y: 500, z: 500 }), materials: ['ABS'], slots: [{ slot: 1, material: 'ABS', color: 'black' }] },
];

test('small parts go to the smallest printer that fits and has the colour loaded', () => {
  const r = choosePrinter(printers, { material: 'ABS', color: 'black', sizeMm: [60, 40, 50] });
  assert.equal(r.printer.id, 2);
  assert.equal(r.slot, 1);
  assert.equal(r.reason, '');
});

test('a part too big for the small printer goes to the next size up', () => {
  const r = choosePrinter(printers, { material: 'ABS', color: 'black', sizeMm: [200, 100, 50] });
  assert.equal(r.printer.id, 1);
  const big = choosePrinter(printers, { material: 'ABS', color: 'black', sizeMm: [280, 100, 50] });
  assert.equal(big.printer.id, 3);
});

test('rotating the part on the plate counts as fitting', () => {
  assert.equal(fitsBed(printers[1], [100, 170, 50]), true);
  assert.equal(fitsBed(printers[1], [176, 100, 50]), false); // 176 + 5 mm margin > 180
});

test('material and colour must be loaded; the reason explains what is missing', () => {
  assert.equal(choosePrinter(printers, { material: 'ASA', color: 'white', sizeMm: [50, 50, 50] }).printer.id, 1);
  const red = choosePrinter(printers, { material: 'ABS', color: 'red', sizeMm: [50, 50, 50] });
  assert.equal(red.printer, null);
  assert.match(red.reason, /no printer has ABS red loaded/);
  const petg = choosePrinter(printers, { material: 'PETG', color: 'black', sizeMm: [50, 50, 50] });
  assert.match(petg.reason, /no printer prints PETG/);
  const huge = choosePrinter(printers, { material: 'ABS', color: 'black', sizeMm: [400, 50, 50] });
  assert.match(huge.reason, /too large/);
  assert.equal(choosePrinter([printers[3]], { material: 'ABS', color: 'black', sizeMm: [10, 10, 10] }).reason, 'no active printer');
});

test('busy printers are skipped; everything busy → waiting', () => {
  const r = choosePrinter(printers, { material: 'ABS', color: 'black', sizeMm: [60, 40, 50] }, new Set([2]));
  assert.equal(r.printer.id, 1);
  const w = choosePrinter(printers, { material: 'ABS', color: 'black', sizeMm: [60, 40, 50] }, new Set([1, 2, 3]));
  assert.equal(w.printer, null);
  assert.equal(w.reason, 'waiting for a free printer');
});

test('slot lookup is case-insensitive and falls back to the position', () => {
  assert.equal(loadedSlot({ slots: [{ material: 'abs', color: 'Black' }, { material: 'ASA', color: 'white' }] }, 'ABS', 'black'), 1);
  assert.equal(loadedSlot({ slots: [{ slot: 3, material: 'ASA', color: 'white' }] }, 'ASA', 'WHITE'), 3);
  assert.equal(loadedSlot({ slots: [] }, 'ABS', 'black'), null);
});

test('PostgREST query builder', () => {
  assert.equal(buildQuery({ select: '*,type:printer_types(*)', order: 'id.asc' }), '?select=*%2Ctype%3Aprinter_types%28*%29&order=id.asc');
  const q = buildQuery({ filters: [['status', 'in', ['slicing', 'printing']], ['id', 'eq', 5], ['key', 'eq', 'agent:test_printer']], limit: 50 });
  assert.equal(decodeURIComponent(q), '?status=in.(slicing,printing)&id=eq.5&key=eq.agent:test_printer&limit=50');
  assert.equal(decodeURIComponent(buildQuery({ filters: [['name', 'in', ['a,b', 'c']]] })), '?name=in.("a,b",c)');
});

test('rest client sends service-role headers and parses responses', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 1 }]), arrayBuffer: async () => new Uint8Array([1, 2]).buffer };
  };
  const rest = createRest({ url: 'https://x.supabase.co/', serviceRoleKey: 'sk', fetchImpl });
  const rows = await rest.select('printers', { filters: [['active', 'eq', true]] });
  assert.deepEqual(rows, [{ id: 1 }]);
  assert.equal(calls[0].url, 'https://x.supabase.co/rest/v1/printers?active=eq.true');
  assert.equal(calls[0].init.headers.apikey, 'sk');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk');
  await rest.update('print_jobs', [['id', 'eq', 7]], { status: 'printing' });
  assert.equal(calls[1].init.method, 'PATCH');
  assert.equal(calls[1].url, 'https://x.supabase.co/rest/v1/print_jobs?id=eq.7');
  assert.equal(JSON.parse(calls[1].init.body).status, 'printing');
  assert.equal(calls[1].init.headers.Prefer, 'return=representation');
  const buf = await rest.download('models', 'models/abc.stl');
  assert.equal(calls[2].url, 'https://x.supabase.co/storage/v1/object/models/models/abc.stl');
  assert.equal(buf.length, 2);
});

// ---------------------------------------------------------------- dispatch loop with fakes
function fakeRest(state) {
  const log = [];
  const match = (row, filters = []) => filters.every(([col, op, v]) => (op === 'eq' ? String(row[col]) === String(v) : op === 'in' ? v.map(String).includes(String(row[col])) : true));
  return {
    log,
    async select(table, { filters = [], select = '' } = {}) {
      const rows = (state[table] || []).filter((r) => match(r, filters));
      if (table === 'print_jobs' && select.includes('item:')) {
        return rows.map((j) => ({ ...j, item: { ...state.order_items.find((i) => i.id === j.order_item_id), model: state.models[0] }, order: state.orders.find((o) => o.id === j.order_id) }));
      }
      if (table === 'printers') return rows.map((p) => ({ ...p, type: state.printer_types.find((t) => t.code === p.type_code) }));
      return rows;
    },
    async one(table, opts) { return (await this.select(table, opts))[0] ?? null; },
    async insert(table, rows) { log.push(['insert', table, rows]); (state[table] ||= []).push(...rows); return rows; },
    async update(table, filters, patch) {
      log.push(['update', table, filters, patch]);
      for (const r of state[table] || []) if (match(r, filters)) Object.assign(r, patch);
      return [];
    },
    async remove(table, filters) { state[table] = (state[table] || []).filter((r) => !match(r, filters)); },
    async download() { return Buffer.from('solid x\nendsolid x\n'); },
  };
}

function makeState() {
  return {
    printer_types: [{ code: 'bambu_p2s', driver: 'bambu', bed: { x: 256, y: 256, z: 256 } }, { code: 'bambu_a1mini', driver: 'bambu', bed: { x: 180, y: 180, z: 180 } }],
    printers: [
      { id: 1, name: 'P2S', type_code: 'bambu_p2s', active: true, address: '10.0.0.5', serial: 'S1', access_code: '1234', nozzle_mm: 0.4, materials: ['ABS', 'ASA'], slots: [{ slot: 2, material: 'ABS', color: 'white' }] },
      { id: 2, name: 'mini', type_code: 'bambu_a1mini', active: true, address: '10.0.0.6', serial: 'S2', access_code: '1234', nozzle_mm: 0.4, materials: ['ABS'], slots: [{ slot: 1, material: 'ABS', color: 'white' }] },
    ],
    materials: [{ code: 'ABS', nozzle_temp: 270, bed_temp: 90, density: 1.04 }],
    models: [{ id: 'm1', stl_path: 'models/m1.stl', analysis: {} }],
    orders: [{ id: 'o1', number: 'P2P-100001', status: 'in_queue' }],
    order_items: [{ id: 11, order_id: 'o1', model_id: 'm1', material: 'ABS', color: 'white', scale: 1, infill: 35, size_mm: [40, 40, 30], quantity: 2 }],
    print_jobs: [
      { id: 101, order_id: 'o1', order_item_id: 11, copy_index: 1, status: 'queued', attempts: 0, created_at: '2026-10-26T10:00:00Z', waiting_reason: '' },
      { id: 102, order_id: 'o1', order_item_id: 11, copy_index: 2, status: 'queued', attempts: 0, created_at: '2026-10-26T10:00:01Z', waiting_reason: '' },
    ],
    order_events: [], settings: [],
  };
}

function fakeDriverFactory(behaviour) {
  const started = [];
  const factory = (printer) => ({
    started,
    async status() { return behaviour.status(printer); },
    async start(args) { started.push({ printer: printer.id, ...args }); if (behaviour.startFails) throw new Error('printer refused'); },
    async test() { return { ok: true, message: `ok ${printer.name}` }; },
  });
  factory.started = started;
  return factory;
}

test('dispatch: small part goes to the small printer first, second copy to the other printer; order → printing → printed', async () => {
  const state = makeState();
  const rest = fakeRest(state);
  const printing = new Set();
  const drivers = fakeDriverFactory({ status: (p) => (printing.has(p.id) ? { state: 'printing', progress: 50 } : { state: 'finished', progress: 100 }) });
  const slicer = async ({ jobId, printer, outDir }) => ({ file: `${outDir}/j${jobId}.3mf`, fileName: `j${jobId}.3mf`, stats: { printTimeSec: 600, printer: printer.name } });
  let t = 1000;
  const agent = new Agent({ rest, config: { DATA_DIR: '/tmp/claude-0/-home-claude/7dbd70bb-f476-5293-9da8-42c9996cf4b9/scratchpad/agent-test' }, log: () => {}, drivers, slicer, now: () => t });
  printing.add(1); printing.add(2);
  await agent.tick();
  const jobs = state.print_jobs;
  assert.equal(jobs[0].status, 'printing');
  assert.equal(jobs[0].printer_id, 2, 'first copy on the small printer');
  assert.equal(jobs[0].slot, 1);
  assert.equal(jobs[1].status, 'printing');
  assert.equal(jobs[1].printer_id, 1, 'second copy on the P2S because the mini is busy');
  assert.equal(jobs[1].slot, 2);
  assert.equal(drivers.started.length, 2);
  assert.equal(drivers.started[0].amsSlot, 1);
  assert.equal(state.orders[0].status, 'printing');
  assert.ok(state.order_events.some((e) => e.status === 'printing'));
  // both printers report finished
  printing.clear(); t += 120000;
  await agent.tick();
  assert.deepEqual(jobs.map((j) => j.status), ['done', 'done']);
  assert.equal(state.orders[0].status, 'printed');
  assert.equal(agent.running.size, 0);
});

test('dispatch: nothing fits → waiting reason written, job stays queued', async () => {
  const state = makeState();
  state.order_items[0].color = 'red';
  const rest = fakeRest(state);
  const agent = new Agent({ rest, config: { DATA_DIR: '/tmp/claude-0/-home-claude/7dbd70bb-f476-5293-9da8-42c9996cf4b9/scratchpad/agent-test' }, log: () => {}, drivers: fakeDriverFactory({ status: () => ({ state: 'idle' }) }), slicer: async () => { throw new Error('should not slice'); } });
  await agent.tick();
  assert.equal(state.print_jobs[0].status, 'queued');
  assert.equal(state.print_jobs[0].waiting_reason, 'no printer has ABS red loaded');
});

test('a failed start goes back to the queue and gives up after 3 attempts', async () => {
  const state = makeState();
  state.print_jobs.splice(1);
  const rest = fakeRest(state);
  const logs = [];
  const agent = new Agent({ rest, config: { DATA_DIR: '/tmp/claude-0/-home-claude/7dbd70bb-f476-5293-9da8-42c9996cf4b9/scratchpad/agent-test' }, log: (l, m) => logs.push(m),
    drivers: fakeDriverFactory({ status: () => ({ state: 'idle' }), startFails: true }), slicer: async ({ jobId }) => ({ file: `/tmp/j${jobId}`, fileName: `j${jobId}.3mf`, stats: {} }) });
  await agent.tick();
  assert.equal(state.print_jobs[0].status, 'queued');
  assert.equal(state.print_jobs[0].attempts, 1);
  assert.match(state.print_jobs[0].error, /printer refused/);
  await agent.tick(); await agent.tick();
  assert.equal(state.print_jobs[0].status, 'failed');
  assert.equal(state.print_jobs[0].attempts, 3);
  assert.equal(state.orders[0].status, 'failed');
});

test('test-connection request is consumed and the result written to the printer', async () => {
  const state = makeState();
  state.print_jobs = [];
  state.settings = [{ key: 'agent:test_printer', value: { id: 1 } }];
  const rest = fakeRest(state);
  const agent = new Agent({ rest, config: { DATA_DIR: '/tmp/claude-0/-home-claude/7dbd70bb-f476-5293-9da8-42c9996cf4b9/scratchpad/agent-test' }, log: () => {}, drivers: fakeDriverFactory({ status: () => ({ state: 'idle' }) }), slicer: async () => ({}) });
  await agent.tick();
  assert.equal(state.settings.length, 0);
  assert.equal(state.printers[0].status_detail, 'ok P2S');
  assert.equal(state.printers[0].status, 'idle');
});
