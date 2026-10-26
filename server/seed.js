// Test data so the shop works on first start: materials, taxes, shipping, printers, a catalog
// built with the demo generator, demo accounts, reviews and order history for the reports.
// Runs once (when the database is empty).

import { db, all, get, run, tx, getSetting, setSetting, parseJson } from './db.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from './auth.js';
import { config } from './config.js';
import { generateFromPrompt } from './ai/procedural.js';
import { saveModel, renderPhotos, previewBuffer } from './models.js';
import { placeOnBed } from './mesh/core.js';
import { loadPricingContext, priceLine, quoteLines } from './pricing/quote.js';
import { DEFAULT_FEE_TIERS } from './pricing/engine.js';
import { encryptSecret } from './lib/secrets.js';

const SEED_VERSION = 2;

// Progress of the first-start setup, shown by the app while it runs.
export const seedState = { running: false, done: 0, total: 0 };
const tick = () => new Promise((r) => setImmediate(r));

// Prices are in Saudi riyals (SAR) per gram. Temperatures are the printer's limits for the material.
const MATERIALS = [
  {
    code: 'ABS', name_en: 'ABS', name_ar: 'ABS', price: 0.11, density: 1.04, process: 'fdm', nozzle: 270, bed: 90, sort: 1, maxTemp: 87,
    desc_en: 'Tough and impact-resistant with a matte finish. Handles heat up to about 87 °C. Our standard material.',
    desc_ar: 'متينة ومقاومة للصدمات بلمسة مطفية. تتحمل الحرارة حتى حوالي 87 درجة. خامتنا الأساسية.',
    colors: [
      ['black', 'Black', 'أسود', '#1E1F22'], ['white', 'White', 'أبيض', '#F2F2EE'], ['grey', 'Silver grey', 'رمادي', '#8A8F96'],
      ['red', 'Red', 'أحمر', '#C8232C'], ['blue', 'Blue', 'أزرق', '#2350B8'], ['yellow', 'Yellow', 'أصفر', '#F4C21B'],
    ],
  },
  {
    code: 'ASA', name_en: 'ASA (outdoor)', name_ar: 'ASA (للخارج)', price: 0.16, density: 1.07, process: 'fdm', nozzle: 270, bed: 90, sort: 2, maxTemp: 100,
    desc_en: 'Like ABS but resists sunlight and weather. Handles heat up to about 100 °C. Best for balconies, gardens and cars.',
    desc_ar: 'مثل ABS لكنها تقاوم الشمس والطقس. تتحمل الحرارة حتى حوالي 100 درجة. الأفضل للشرفات والحدائق والسيارات.',
    colors: [['white', 'White', 'أبيض', '#F2F2EE'], ['black', 'Black', 'أسود', '#1E1F22']],
  },
];

const TAXES = [
  ['SA', '*', 15, 'VAT'], ['AE', '*', 5, 'VAT'], ['BH', '*', 10, 'VAT'], ['OM', '*', 5, 'VAT'], ['KW', '*', 0, ''], ['QA', '*', 0, ''],
  ['EG', '*', 14, 'VAT'], ['JO', '*', 16, 'GST'], ['GB', '*', 20, 'VAT'], ['DE', '*', 19, 'MwSt'], ['FR', '*', 20, 'TVA'],
  ['US', 'CA', 7.25, 'Sales tax'], ['US', 'NY', 4, 'Sales tax'], ['US', 'TX', 6.25, 'Sales tax'], ['US', '*', 0, ''], ['*', '*', 0, ''],
];

// Shipping in SAR (halalas): base + per kg. Starting values; edit them in Admin → Shipping.
const ZONES = [
  ['Saudi Arabia', 'داخل السعودية', ['SA'], 2500, 1500, 2, 4],
  ['Gulf (GCC)', 'دول الخليج', ['AE', 'KW', 'BH', 'QA', 'OM'], 6000, 3500, 3, 6],
  ['Middle East & North Africa', 'الشرق الأوسط وشمال أفريقيا', ['EG', 'JO', 'LB', 'IQ', 'MA', 'TN', 'DZ', 'TR'], 9000, 4500, 5, 9],
  ['Europe', 'أوروبا', ['GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'SE'], 11000, 5500, 6, 10],
  ['North America', 'أمريكا الشمالية', ['US', 'CA'], 12000, 6000, 6, 12],
  ['Rest of the world', 'بقية العالم', ['*'], 14000, 7000, 8, 15],
];

const CATEGORIES = [
  ['desk', 'Desk & office', 'المكتب'],
  ['decor', 'Home decor', 'ديكور المنزل'],
  ['plants', 'Planters', 'أحواض الزرع'],
  ['organizers', 'Organizers & holders', 'منظّمات وحوامل'],
  ['chess', 'Chess & games', 'الشطرنج والألعاب'],
  ['figurines', 'Figurines & art', 'مجسمات وفنون'],
  ['gifts', 'Gifts & keychains', 'هدايا وميداليات'],
];

// [category, prompt, seed, name_en, name_ar, desc_en, desc_ar, material, color, featured, tags]
// Nothing here is for food or drink.
const PRODUCTS = [
  ['desk', 'a hexagonal pen holder shaped like a castle tower', 3, 'Castle tower pen holder', 'حامل أقلام برج القلعة',
    'A six-sided tower with battlements around the rim. Our most-requested AI design, now in the catalog.', 'برج سداسي بشرفات قلعة حول الحافة. أكثر تصميم طُلب بالذكاء الاصطناعي، والآن في المتجر.', 'ABS', 'grey', 1, 'pen holder castle tower desk'],
  ['desk', 'honeycomb pen holder', 2, 'Honeycomb pen cup', 'حامل أقلام سداسي',
    'Hexagonal pen holder with a weighted base so it does not tip over.', 'حامل أقلام سداسي بقاعدة ثقيلة حتى لا ينقلب.', 'ABS', 'yellow', 1, 'pen holder desk office'],
  ['desk', 'phone stand', 3, 'Angle phone stand', 'حامل الجوال المائل',
    'Holds a phone at a comfortable angle for calls and videos. Thick, rounded and stable.', 'يحمل الجوال بزاوية مريحة للمكالمات والفيديو. سميك ومستدير وثابت.', 'ABS', 'black', 1, 'phone stand desk mobile'],
  ['desk', 'desk organizer box', 4, 'Desk tidy box', 'صندوق ترتيب المكتب',
    'A rounded box for clips, chargers and small tools.', 'صندوق بزوايا دائرية للمشابك والشواحن والأدوات الصغيرة.', 'ABS', 'grey', 0, 'box organizer desk storage'],
  ['desk', 'headphone stand', 2, 'Headphone stand', 'حامل سماعات',
    'Keeps your headphones off the desk. Wide base, rounded arm.', 'يحفظ سماعاتك بعيداً عن سطح المكتب. قاعدة عريضة وذراع مستدير.', 'ABS', 'black', 1, 'headphone stand desk'],
  ['desk', 'cable organizer', 3, 'Cable organizer block', 'منظّم الكابلات',
    'Slots for charging cables so they never fall behind the desk.', 'فتحات لكابلات الشحن حتى لا تسقط خلف المكتب.', 'ABS', 'white', 0, 'cable organizer desk'],
  ['desk', 'bookend', 2, 'Bookend', 'سند الكتب',
    'A heavy L-shaped bookend that keeps shelves in order. Order two for a pair.', 'سند كتب ثقيل على شكل L يحافظ على ترتيب الرف. اطلب اثنين لزوج.', 'ABS', 'blue', 0, 'bookend shelf books'],
  ['decor', 'tall twisted vase', 3, 'Spiral vase', 'المزهرية الحلزونية',
    'A slender vase with a gentle twist, for dried flowers and decorative stems.', 'مزهرية نحيلة بالتواء لطيف للزهور المجففة والأغصان الزينية.', 'ABS', 'white', 1, 'vase twisted spiral dried flowers'],
  ['decor', 'faceted vase', 9, 'Prism vase', 'مزهرية المنشور',
    'Sharp facets that change with the light. For dried flowers and decorative stems.', 'أسطح حادة يتغير شكلها مع الضوء. للزهور المجففة والأغصان الزينية.', 'ABS', 'grey', 1, 'vase faceted geometric'],
  ['decor', 'wide wavy vase', 6, 'Ripple vase', 'المزهرية المموجة',
    'A rounded vase with soft vertical waves, for dried arrangements.', 'مزهرية دائرية بتموجات عمودية ناعمة للتنسيقات المجففة.', 'ABS', 'white', 0, 'vase wavy'],
  ['decor', 'star lamp shade', 2, 'Star lamp shade', 'أباجورة النجمة',
    'A star-section shade for LED bulbs that throws a starburst of light. LED bulbs only.', 'غطاء مصباح بمقطع نجمي لمصابيح LED يرسم ضوءاً على شكل نجمة. لمصابيح LED فقط.', 'ABS', 'white', 0, 'lamp shade star light'],
  ['decor', 'spiral ornament', 4, 'Spiral ornament', 'زينة حلزونية',
    'A twisting ornament for shelves and festive tables.', 'قطعة زينة ملتوية للرفوف وطاولات المناسبات.', 'ABS', 'yellow', 0, 'ornament spiral decor'],
  ['decor', 'wall key holder hook', 3, 'Wall key hook', 'علّاقة مفاتيح للحائط',
    'A rounded wall hook for keys and lanyards. Screws not included.', 'علّاقة حائط مستديرة للمفاتيح والحبال. البراغي غير مشمولة.', 'ABS', 'black', 0, 'hook wall keys'],
  ['plants', 'faceted planter pot', 3, 'Geo planter', 'أصيص هندسي',
    'A faceted planter for succulents and small plants. Choose ASA for a sunny balcony.', 'أصيص بأسطح هندسية للصباريات والنباتات الصغيرة. اختر ASA للشرفة المشمسة.', 'ASA', 'white', 1, 'planter pot plant succulent'],
  ['plants', 'hexagon honeycomb planter', 5, 'Hex planter', 'أصيص سداسي',
    'Six-sided planter that tiles neatly with others on a windowsill.', 'أصيص سداسي يتراص بشكل أنيق مع غيره على حافة النافذة.', 'ABS', 'grey', 0, 'planter hexagon honeycomb'],
  ['plants', 'small wavy succulent planter', 8, 'Mini succulent pot', 'أصيص صبار صغير',
    'A small wavy pot for a single succulent or cactus.', 'أصيص صغير مموج لنبتة صبار واحدة.', 'ABS', 'white', 0, 'planter small succulent cactus'],
  ['organizers', 'trinket box with lid', 4, 'Trinket box', 'علبة حُلي',
    'A rounded box with a fitted lid for rings, coins and small treasures.', 'علبة مستديرة بغطاء محكم للخواتم والعملات والأشياء الصغيرة.', 'ABS', 'red', 1, 'box lid jewellery trinket'],
  ['chess', 'chess pawn', 1, 'Chess pawn', 'جندي الشطرنج',
    'Tournament-proportion pawn. Order 8 in each colour for a full set.', 'جندي بمقاسات البطولات. اطلب 8 من كل لون لطقم كامل.', 'ABS', 'white', 0, 'chess pawn game'],
  ['chess', 'chess rook', 1, 'Chess rook', 'قلعة الشطرنج (الرخ)',
    'Castle-top rook with crisp battlements.', 'رخ بشرفات قلعة واضحة التفاصيل.', 'ABS', 'black', 0, 'chess rook castle game'],
  ['chess', 'chess knight', 1, 'Chess knight', 'حصان الشطرنج',
    'The knight, with a sculpted horse head and mane.', 'قطعة الحصان برأس حصان منحوت وعُرف.', 'ABS', 'white', 1, 'chess knight horse game'],
  ['chess', 'chess bishop', 1, 'Chess bishop', 'فيل الشطرنج',
    'Bishop with the classic mitre top.', 'الفيل بقمته الكلاسيكية.', 'ABS', 'black', 0, 'chess bishop game'],
  ['chess', 'chess queen', 1, 'Chess queen', 'وزير الشطرنج',
    'Crowned queen, the tallest piece after the king.', 'الوزير بتاجه، أطول قطعة بعد الملك.', 'ABS', 'white', 0, 'chess queen game'],
  ['chess', 'chess king', 1, 'Chess king', 'ملك الشطرنج',
    'The king with a rounded cross. Pair with the queen for a gift set.', 'الملك بصليب مستدير في القمة. اجمعه مع الوزير كهدية.', 'ABS', 'black', 1, 'chess king game'],
  ['chess', 'dice', 2, 'Rounded dice', 'نرد مستدير',
    'A chunky six-sided die with recessed pips and rounded corners.', 'نرد سداسي سميك بنقاط غائرة وزوايا مستديرة.', 'ABS', 'red', 0, 'dice game'],
  ['gifts', 'star keychain', 2, 'Star keychain', 'ميدالية النجمة',
    'A thick star key tag with rounded points and a strong ring loop.', 'ميدالية نجمة سميكة بأطراف مستديرة وحلقة قوية.', 'ABS', 'red', 0, 'keychain gift star'],
  ['gifts', 'heart keychain', 6, 'Heart keychain', 'ميدالية القلب',
    'A heart key tag with a strong loop. A small gift that ships cheaply.', 'ميدالية على شكل قلب بحلقة قوية. هدية صغيرة بتكلفة شحن منخفضة.', 'ABS', 'red', 0, 'keychain heart gift'],
  ['gifts', 'trophy', 3, 'Mini trophy', 'كأس صغير',
    'A small trophy for family tournaments and office jokes.', 'كأس صغير لبطولات العائلة ومزاح المكتب.', 'ABS', 'yellow', 0, 'trophy award gift'],
  ['figurines', 'castle', 3, 'Little castle', 'قلعة صغيرة',
    'Towers, battlements and a gatehouse in one print. Great for desks and tabletop games.', 'أبراج وشرفات وبوابة في قطعة واحدة. رائعة للمكتب وألعاب الطاولة.', 'ABS', 'grey', 1, 'castle tower figurine game'],
  ['figurines', 'abstract organic sculpture', 11, 'Pebble sculpture', 'منحوتة الحصاة',
    'A smooth, organic form inspired by river stones.', 'شكل عضوي ناعم مستوحى من حجارة الأنهار.', 'ABS', 'grey', 0, 'sculpture abstract art'],
  ['figurines', 'dragon egg sculpture', 5, 'Dragon egg', 'بيضة التنين',
    'A scaled egg that looks ready to hatch. A favourite with kids.', 'بيضة بحراشف تبدو وكأنها ستفقس. محبوبة لدى الأطفال.', 'ABS', 'blue', 0, 'dragon egg sculpture kids'],
  ['figurines', 'owl figurine', 4, 'Owl figurine', 'مجسم بومة',
    'A round little owl with big eyes. Sits on a shelf or a desk.', 'بومة صغيرة مستديرة بعينين كبيرتين. تجلس على الرف أو المكتب.', 'ABS', 'white', 1, 'owl figurine bird'],
  ['figurines', 'sitting cat figurine', 6, 'Sitting cat', 'قطة جالسة',
    'A calm sitting cat with a curled tail.', 'قطة جالسة هادئة بذيل ملتف.', 'ABS', 'black', 0, 'cat figurine'],
  ['figurines', 'rocket', 5, 'Toy rocket', 'صاروخ',
    'A chunky rocket with rounded fins. Stands on its own.', 'صاروخ سميك بزعانف مستديرة يقف بمفرده.', 'ABS', 'red', 0, 'rocket toy space'],
];

// Smallest size that keeps walls ≥ 2 mm, and largest size that fits the printer (250 mm).
const minScaleFor = (a) => {
  const t = a.thickness?.quantiles?.[1] || 0; // thinnest 2.5% of the surface
  return Math.max(0.5, Math.min(1, t > 0 ? Math.ceil(((2 * 0.95) / t) * 100) / 100 : 1));
};
const maxScaleFor = (a) => Math.max(1, Math.min(2, Math.floor((250 / Math.max(...a.bbox.size)) * 100) / 100));

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

// If the very first setup was interrupted (the app was closed while it ran), nothing in the
// database is real shop data yet: clear the half-finished setup and start again.
function clearIncompleteSetup() {
  const tables = ['print_jobs', 'order_events', 'payments', 'refunds', 'order_items', 'orders', 'cart_items', 'designs', 'wishlist',
    'reviews', 'products', 'models', 'addresses', 'sessions', 'users', 'printers', 'shipping_zones', 'tax_rates', 'materials', 'categories', 'settings'];
  db.exec('PRAGMA foreign_keys = OFF');
  try { for (const t of tables) db.exec(`DELETE FROM ${t}`); } finally { db.exec('PRAGMA foreign_keys = ON'); }
  for (const dir of [config.modelsDir, path.join(config.dataDir, 'private', 'previews'), config.mediaDir]) {
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) fs.rmSync(path.join(dir, f), { force: true });
  }
}

export async function ensureSeeded() {
  if (getSetting('seed_version', 0) >= SEED_VERSION) return;
  if (getSetting('seed_version', 0) === 0 && get('SELECT 1 FROM materials LIMIT 1')) {
    console.log('[seed] The first setup was interrupted last time; starting it again.');
    clearIncompleteSetup();
  }
  const upgrade = getSetting('seed_version', 0) > 0;
  seedState.running = true;
  seedState.total = PRODUCTS.length;
  const started = Date.now();
  console.log(upgrade ? '[seed] Updating the catalog to the new rules…' : '[seed] Creating the catalog (first start)…');
  if (upgrade) {
    // A shop from an earlier version: keep customers and orders, replace the catalog rules.
    // Old materials/colours that are no longer offered are switched off, old catalog items are
    // hidden (orders still reference them), and the single P2S printer is added if missing.
    const keepMaterials = MATERIALS.map((m) => m.code);
    run(`UPDATE materials SET active = 0 WHERE code NOT IN (${keepMaterials.map(() => '?').join(',')})`, keepMaterials);
    for (const m of MATERIALS) {
      run('UPDATE materials SET price_per_gram = ?, density = ?, nozzle_temp = ?, bed_temp = ?, colors = ?, active = 1 WHERE code = ?',
        [m.price, m.density, m.nozzle, m.bed, JSON.stringify(m.colors.map(([code, en, ar, hex]) => ({ code, name_en: en, name_ar: ar, hex, in_stock: true }))), m.code]);
    }
    run("UPDATE products SET active = 0 WHERE model_id IN (SELECT id FROM models WHERE source = 'catalog')");
    // Sample accounts and their sample orders from the old demo mode.
    const demoIds = all("SELECT id FROM users WHERE email LIKE '%@prompt2print.local' OR email LIKE '%@example.com'").map((u) => u.id);
    if (demoIds.length) {
      const q = demoIds.map(() => '?').join(',');
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        for (const t of ['print_jobs', 'order_events', 'payments', 'refunds', 'order_items']) {
          run(`DELETE FROM ${t} WHERE order_id IN (SELECT id FROM orders WHERE user_id IN (${q}))`, demoIds);
        }
        for (const t of ['orders', 'cart_items', 'designs', 'wishlist', 'reviews', 'addresses', 'sessions']) run(`DELETE FROM ${t} WHERE user_id IN (${q})`, demoIds);
        run(`DELETE FROM users WHERE id IN (${q})`, demoIds);
      } finally { db.exec('PRAGMA foreign_keys = ON'); }
    }
    run("UPDATE printers SET active = 0 WHERE driver = 'simulator'");
  }

  tx(() => {
    setSetting('store_name', 'Prompt2Print');
    setSetting('currency', 'SAR');
    setSetting('default_country', 'SA');
    setSetting('wall_thickness_mm', 2.1);        // 5 walls × 0.42 mm line width
    setSetting('min_wall_mm', 2);
    setSetting('infill_range', [30, 40]);
    setSetting('fee_tiers', [{ maxCents: 37500, percent: 15 }, { maxCents: null, percent: 5 }]); // 15% up to 375 SAR (≈ $100), 5% above
    setSetting('ai_provider', 'auto');
    setSetting('ai_hourly_limit', 30);
    setSetting('ai_default_size_mm', 100);
    setSetting('payment_provider', 'tap');
    setSetting('simulator_speed', 400);
    setSetting('simulator_failure_rate', 0);
    setSetting('simulator_auto_clear', true);
    // Keys given through the environment (or a .env file) are moved into the encrypted vault.
    for (const [setting, env] of [['tripo_api_key', 'TRIPO_API_KEY'], ['meshy_api_key', 'MESHY_API_KEY'], ['tap_secret_key', 'TAP_SECRET_KEY'], ['tap_publishable_key', 'TAP_PUBLISHABLE_KEY']]) {
      if (process.env[env]) setSetting(setting, encryptSecret(process.env[env].trim()));
    }

    for (const m of MATERIALS) {
      run(`INSERT OR IGNORE INTO materials(code, name_en, name_ar, desc_en, desc_ar, price_per_gram, density, process, nozzle_temp, bed_temp, colors, sort)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [m.code, m.name_en, m.name_ar, m.desc_en, m.desc_ar, m.price, m.density, m.process, m.nozzle, m.bed,
        JSON.stringify(m.colors.map(([code, en, ar, hex]) => ({ code, name_en: en, name_ar: ar, hex, in_stock: true }))), m.sort]);
    }
    for (const [country, region, rate, label] of TAXES) run('INSERT OR IGNORE INTO tax_rates(country, region, rate, label) VALUES(?, ?, ?, ?)', [country, region, rate, label]);
    ZONES.forEach(([en, ar, countries, base, perKg, min, max], i) => {
      run('INSERT INTO shipping_zones(name_en, name_ar, countries, base_cents, per_kg_cents, min_days, max_days, sort) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
        [en, ar, JSON.stringify(countries), base, perKg, min, max, i]);
    });
    // The shop's printer. Enter its IP address, serial number and LAN access code in Admin → Printers, then switch it on.
    run(`INSERT INTO printers(name, driver, flavor, bed, materials, ams, active, status, status_detail)
         VALUES('Bambu Lab P2S Combo', 'bambu', 'bambu', ?, ?, ?, 0, 'offline', 'Enter the printer IP, serial number and access code, then activate it')`,
    [JSON.stringify({ x: 256, y: 256, z: 256 }), JSON.stringify(['ABS', 'ASA']),
      JSON.stringify([{ slot: 1, material: 'ABS', color: 'black' }, { slot: 2, material: 'ABS', color: 'white' }, { slot: 3, material: 'ABS', color: 'grey' }, { slot: 4, material: 'ASA', color: 'white' }])]);
    if (config.demo) {
      for (const [name, flavor, bed, materials] of [['Simulated printer', 'bambu', { x: 256, y: 256, z: 256 }, ['ABS', 'ASA']]]) {
        run("INSERT INTO printers(name, driver, flavor, bed, materials, active) VALUES(?, 'simulator', ?, ?, ?, 1)", [name, flavor, JSON.stringify(bed), JSON.stringify(materials)]);
      }
    }
    CATEGORIES.forEach(([slug, en, ar], i) => run('INSERT OR IGNORE INTO categories(slug, name_en, name_ar, sort) VALUES(?, ?, ?, ?)', [slug, en, ar, i]));

    // The one admin account. No demo accounts.
    // Without a password the account can't sign in until it is set at the first start (see
    // /api/auth/setup-admin, accepted from this computer only).
    const hash = process.env.P2P_ADMIN_PASSWORD ? hashPassword(process.env.P2P_ADMIN_PASSWORD) : config.adminPasswordHash;
    run("INSERT OR IGNORE INTO users(email, name, password_hash, role, locale) VALUES(?, 'Shop admin', ?, 'admin', 'en')", [config.adminEmail, hash]);
    if (config.demo) {
      run("INSERT OR IGNORE INTO users(email, name, password_hash, role, locale) VALUES('demo@prompt2print.local', 'Demo customer', ?, 'customer', 'en')", hashPassword('Demo#2026'));
      const demo = get("SELECT id FROM users WHERE email = 'demo@prompt2print.local'");
      run(`INSERT INTO addresses(user_id, label, full_name, phone, line1, city, region, postal_code, country, is_default)
           VALUES(?, 'Home', 'Demo customer', '+966 50 000 0000', 'King Fahd Road, Building 12', 'Jubail', 'Eastern Province', '35514', 'SA', 1)`, demo.id);
      for (const [name, email, locale] of CUSTOMERS) {
        run('INSERT OR IGNORE INTO users(email, name, password_hash, locale) VALUES(?, ?, ?, ?)', [email, name, hashPassword(crypto.randomBytes(16).toString('hex')), locale]);
      }
    }
  });

  // Catalog: build each model with the demo generator and render product photos.
  const ctx = loadPricingContext();
  const cats = Object.fromEntries(all('SELECT id, slug FROM categories').map((c) => [c.slug, c.id]));
  const pending = [];
  for (const [cat, prompt, seed, en, ar, dEn, dAr, material, color, featured, tags] of PRODUCTS) {
    const { mesh } = generateFromPrompt(prompt, { seed });
    const placed = placeOnBed(mesh);
    const model = saveModel(placed, { source: 'catalog', preview: false });
    const hex = ctx.materials[material].colors.find((c) => c.code === color).hex;
    const [hero] = renderPhotos(model.id, { mesh: placed, color: hex, views: ['hero'] });
    const allowed = ['ABS', 'ASA'];
    const slug = en.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    run(`INSERT INTO products(slug, category_id, model_id, name_en, name_ar, desc_en, desc_ar, default_material, default_color, allowed_materials,
                     default_scale, min_scale, max_scale, default_infill, images, tags, featured)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 35, ?, ?, ?)
                   ON CONFLICT(slug) DO UPDATE SET category_id = excluded.category_id, model_id = excluded.model_id, name_en = excluded.name_en,
                     name_ar = excluded.name_ar, desc_en = excluded.desc_en, desc_ar = excluded.desc_ar, default_material = excluded.default_material,
                     default_color = excluded.default_color, allowed_materials = excluded.allowed_materials, default_scale = 1, min_scale = excluded.min_scale,
                     max_scale = excluded.max_scale, default_infill = 35, images = excluded.images, tags = excluded.tags, featured = excluded.featured, active = 1`,
    [slug, cats[cat], model.id, en, ar, dEn, dAr, material, color, JSON.stringify(allowed),
      minScaleFor(model.analysis), maxScaleFor(model.analysis),
      JSON.stringify([hero]), tags, featured]);
    const productId = Number(get('SELECT id FROM products WHERE slug = ?', slug).id);
    pending.push({ id: productId, modelId: model.id, mesh: placed, hex });
    seedState.done += 1;
    await tick(); // keep the server responsive while seeding
  }

  if (upgrade) run('DELETE FROM categories WHERE id NOT IN (SELECT category_id FROM products WHERE active = 1)');
  if (config.demo) seedReviewsAndOrders(ctx); // sample reviews and orders only in demo mode
  setSetting('seed_version', SEED_VERSION);
  seedState.running = false;
  console.log(`[seed] Done in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  // The other product photo angles render in the background so the shop opens quickly.
  const renderRest = () => {
    const next = pending.shift();
    if (!next) return;
    try {
      const images = renderPhotos(next.modelId, { mesh: next.mesh, color: next.hex, views: ['hero', 'iso', 'front', 'top'] });
      run('UPDATE products SET images = ? WHERE id = ?', [JSON.stringify(images), next.id]);
      previewBuffer(next.modelId); // build the 3D preview ahead of the first visit
    } catch (err) {
      console.error('[seed] render failed', err.message);
    }
    setTimeout(renderRest, 200);
  };
  setTimeout(renderRest, 500);
}

function seedReviewsAndOrders(ctx) {
  const rand = rng(2026);
  const products = all('SELECT * FROM products');
  const customers = all("SELECT * FROM users WHERE role = 'customer' AND email LIKE '%@example.com'");
  const custInfo = Object.fromEntries(CUSTOMERS.map(([name, email, , country, city]) => [email, { name, country, city }]));

  tx(() => {
    // Reviews
    for (const p of products) {
      const n = 1 + Math.floor(rand() * 5);
      for (let i = 0; i < n; i++) {
        const [locale, rating, title, body] = REVIEW_TEXT[Math.floor(rand() * REVIEW_TEXT.length)];
        const c = customers[Math.floor(rand() * customers.length)];
        const when = new Date(Date.now() - Math.floor(rand() * 50 + 2) * 86400e3);
        run('INSERT INTO reviews(product_id, user_id, author_name, rating, title, body, locale, verified, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?)',
          [p.id, c.id, c.name, rating, title, body, locale, sqlTime(when)]);
      }
      run('UPDATE products SET rating_avg = (SELECT AVG(rating) FROM reviews WHERE product_id = ?), rating_count = (SELECT COUNT(*) FROM reviews WHERE product_id = ?) WHERE id = ?', [p.id, p.id, p.id]);
    }

    // Order history over the last 45 days (already printed and shipped, so no print jobs are created).
    const flow = ['paid', 'in_queue', 'printing', 'printed', 'packed', 'shipped', 'delivered'];
    for (let k = 0; k < 46; k++) {
      const c = customers[Math.floor(rand() * customers.length)];
      const info = custInfo[c.email];
      const daysAgo = Math.floor(rand() * 45);
      const paidAt = new Date(Date.now() - daysAgo * 86400e3 - Math.floor(rand() * 10) * 3600e3);
      const count = 1 + Math.floor(rand() * 2);
      const lines = [];
      for (let j = 0; j < count; j++) {
        const p = products[Math.floor(rand() * products.length)];
        const analysis = parseJson(get('SELECT analysis FROM models WHERE id = ?', p.model_id).analysis);
        const priced = priceLine(ctx, {
          analysis, material: p.default_material, color: p.default_color, scale: [0.8, 1, 1, 1.2][Math.floor(rand() * 4)],
          infill: p.default_infill, quantity: 1 + Math.floor(rand() * 2),
        });
        lines.push({ p, priced });
      }
      const quote = quoteLines(ctx, lines.map((l) => l.priced), { country: info.country, region: info.country === 'US' ? 'CA' : '' });
      const reached = daysAgo > 9 ? 6 : daysAgo > 5 ? 5 : daysAgo > 2 ? 4 : 3; // index in flow
      const status = flow[reached];
      const number = `P2P-${String(100000 + Math.floor(rand() * 899999))}`;
      if (get('SELECT 1 FROM orders WHERE number = ?', number)) continue;
      const address = { fullName: info.name, line1: '12 Example Street', city: info.city, region: '', postalCode: '00000', country: info.country };
      const pricing = { ...quote.breakdown, taxRate: quote.taxRate, shipping: quote.shipping, currency: 'USD' };
      const o = run(`INSERT INTO orders(number, user_id, status, address, pricing, total_cents, payment_provider, payment_ref, paid_at, carrier, tracking_number, created_at, updated_at)
                     VALUES(?, ?, ?, ?, ?, ?, 'test', ?, ?, ?, ?, ?, ?)`,
      [number, c.id, status, JSON.stringify(address), JSON.stringify(pricing), quote.breakdown.totalCents, `test_seed_${k}`, sqlTime(paidAt),
        reached >= 5 ? 'Aramex' : null, reached >= 5 ? `AX${100000000 + Math.floor(rand() * 899999999)}` : null, sqlTime(paidAt), sqlTime(paidAt)]);
      const orderId = Number(o.lastInsertRowid);
      for (const { p, priced } of lines) {
        run(`INSERT INTO order_items(order_id, kind, product_id, model_id, title_en, title_ar, thumb, material, color, color_hex, scale, infill, quantity, size_mm, weight_g, filament_cents, tax_cents)
             VALUES(?, 'product', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, p.id, p.model_id, p.name_en, p.name_ar, parseJson(p.images, [])[0], priced.material, priced.color, priced.colorHex, priced.scale, priced.infill,
          priced.quantity, JSON.stringify(priced.sizeMm), priced.weightGrams, priced.filamentCents, Math.round(priced.filamentCents * quote.taxRate.rate / 100)]);
        run('UPDATE products SET sold_count = sold_count + ? WHERE id = ?', [priced.quantity, p.id]);
      }
      run("INSERT INTO payments(order_id, provider, provider_ref, amount_cents, status, created_at) VALUES(?, 'test', ?, ?, 'succeeded', ?)", [orderId, `test_seed_${k}`, quote.breakdown.totalCents, sqlTime(paidAt)]);
      const hoursPerStep = [0, 0.1, 2, 9, 20, 30, 80];
      for (let s = 0; s <= reached; s++) {
        run('INSERT INTO order_events(order_id, status, created_at) VALUES(?, ?, ?)', [orderId, flow[s], sqlTime(new Date(paidAt.getTime() + hoursPerStep[s] * 3600e3))]);
      }
    }
  });
}
