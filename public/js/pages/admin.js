// Admin panel: overview, orders, print queue, printers, products, pricing, taxes, shipping, users, reports, settings.
import { api, qs } from '../api.js';
import { getLocale, tr, t } from '../i18n.js';
import { state } from '../state.js';
import { html, raw, money, num, date, dateTime, dims, toast, modal, formData, statusPill, esc, countryName } from '../ui.js';
import { navigate, currentUrl } from '../app.js';

const L = {
  en: {
    overview: 'Overview', orders: 'Orders', queue: 'Print queue', printers: 'Printers', products: 'Products', pricing: 'Pricing',
    taxes: 'Tax rates', shipping: 'Shipping', users: 'Users', reports: 'Sales reports', settings: 'Settings', store: 'View shop',
    grpShop: 'Shop', grpPrint: 'Printing', grpMoney: 'Money', grpSystem: 'System',
    today: 'Revenue today', month: 'Net revenue, 30 days', inPrint: 'Orders printing', openJobs: 'Open print jobs', aiToday: 'AI designs today',
    recent: 'Recent orders', order: 'Order', customer: 'Customer', status: 'Status', total: 'Total', placed: 'Placed', items: 'Items', actions: 'Actions',
    all: 'All', search: 'Search orders, emails…', pack: 'Mark packed', ship: 'Mark shipped', deliver: 'Mark delivered', cancel: 'Cancel order',
    refund: 'Refund', refundAmount: 'Amount to refund (SAR)', reason: 'Reason', carrier: 'Carrier', tracking: 'Tracking number', confirm: 'Confirm',
    timeline: 'Timeline', jobs: 'Print jobs', address: 'Address', payment: 'Payment', refunded: 'Refunded',
    job: 'Job', item: 'Item', material: 'Material', printer: 'Printer', progress: 'Progress', position: 'Position',
    up: 'Move up', down: 'Move down', top: 'Move to top', pause: 'Pause', resume: 'Resume', reprint: 'Reprint', held: 'On hold',
    emptyQueue: 'The queue is empty. Paid orders appear here automatically.', printTime: 'Print time', grams: 'Filament',
    addPrinter: 'Add printer', editPrinter: 'Edit printer', clearBed: 'Bed is clear', clearError: 'Clear error', test: 'Test connection',
    edit: 'Edit', delete: 'Delete', name: 'Name', type: 'Type', url: 'Address (URL or IP)', apiKey: 'API key', serial: 'Serial number',
    accessCode: 'LAN access code', flavor: 'G-code flavour', bed: 'Build volume (mm)', materials: 'Materials', profile: 'PrusaSlicer profile (.ini path, optional)',
    active: 'Active', save: 'Save', current: 'Current job', idleNote: 'Waiting for the next job', awaitingNote: 'Remove the finished print, then confirm.',
    addProduct: 'Add product', editProduct: 'Edit product', fromPrompt: 'Generate a model from a description', upload: 'Or upload a model file (STL, OBJ, GLB)',
    generate: 'Generate', nameEn: 'Name (English)', nameAr: 'Name (Arabic)', descEn: 'Description (English)', descAr: 'Description (Arabic)',
    category: 'Category', defMaterial: 'Default material', defColor: 'Default colour', allowed: 'Allowed materials', defScale: 'Default size (×)',
    minScale: 'Smallest (×)', maxScale: 'Largest (×)', defInfill: 'Default infill %', tags: 'Search tags', featured: 'Featured', sold: 'Sold',
    rating: 'Rating', archived: 'Archived (it has past orders)', size: 'Size',
    perGram: 'Price per gram (SAR)', inStock: 'In stock', density: 'Density (g/cm³)', process: 'Process', colors: 'Colours', nozzle: 'Nozzle °C', bedTemp: 'Bed °C',
    feeTitle: 'Service fee', feeHelp: 'The first tier whose limit the order subtotal does not exceed is used. The last tier has no limit.',
    upTo: 'Subtotal up to (SAR)', andAbove: 'and above', percent: 'Fee %', addTier: 'Add tier', removeTier: 'Remove',
    calcTitle: 'Weight calculation', wall: 'Wall thickness (mm)', wallHelp: 'Solid shell used in the weight formula: shell = surface area × wall thickness.',
    storeTitle: 'Store', storeName: 'Store name', currency: 'Currency', defCountry: 'Default delivery country',
    country: 'Country (ISO code or *)', region: 'Region (or *)', rate: 'Rate %', label: 'Label', addTax: 'Add or update rate',
    zone: 'Zone', countries: 'Countries', base: 'Base (SAR)', perKg: 'Per kg (SAR)', divisor: 'Volumetric divisor (cm³/kg)', days: 'Days',
    minDays: 'Min days', maxDays: 'Max days', addZone: 'Add zone', editZone: 'Edit zone',
    role: 'Role', admin: 'Admin', customerRole: 'Customer', disabled: 'Disabled', enable: 'Enable', disable: 'Disable', makeAdmin: 'Make admin', removeAdmin: 'Remove admin',
    spent: 'Spent', joined: 'Joined', auditTitle: 'Security log (admin sign-ins and changes)',
    period: 'Period', last: 'Last {n} days', gross: 'Gross sales', net: 'Net (after refunds)', aov: 'Average order', ordersCount: 'Paid orders',
    revenueDay: 'Revenue by day', split: 'Where the money goes', topProducts: 'Top products', materialUse: 'Filament used by material',
    byCountry: 'Orders by country', aiShare: 'AI designs vs catalog', printHours: 'Printer hours', qty: 'Qty', fee: 'Service fees',
    aiTitle: 'AI model generation', provider: 'Provider', meshyKey: 'Meshy API key', tripoKey: 'Tripo API key', hourly: 'Designs per customer per hour',
    defaultSize: 'Default size for AI models (mm)', payTitle: 'Payments', payProvider: 'Payment provider', testMode: 'Test mode (test cards)',
    stripeKey: 'Stripe secret key', stripeHook: 'Stripe webhook secret', printTitle: 'Printing', slicerPath: 'External slicer (PrusaSlicer console .exe, optional)',
    tapKey: 'Tap secret key (sk_…)', tapPub: 'Tap publishable key (pk_…)', tapHelp: 'Tap Payments accepts Visa, Mastercard, Amex, Apple Pay and mada from customers anywhere. Sign up at tap.company.',
    bambuPath: 'Bambu Studio (bambu-studio.exe) for slicing', bambuFound: 'Bambu Studio was found on this PC and will be used automatically.', bambuMissing: 'Bambu Studio is not installed. Jobs are sliced with the built-in slicer until you install it from bambulab.com.',
    ams: 'AMS slots (what is loaded)', amsHelp: 'Jobs only start when their material and colour are loaded in a slot.', slot: 'Slot', empty: 'Empty',
    currencyTitle: 'Currencies', currencyHelp: 'Prices are kept in SAR and shown in the currency of the delivery country. Rate = units per 1 SAR.', code: 'Code', rateCol: 'Rate per 1 SAR', decimalsCol: 'Decimals', addCurrency: 'Add currency', fallbackCurrency: 'Currency for other countries',
    durability: 'Durability rules', minWall: 'Minimum wall thickness (mm)', infillRange: 'Infill range offered to customers (%)', maxModel: 'Largest model (mm, printer limit)', autoProvider: 'Automatic (first AI service with a key)',
    simSpeed: 'Simulated printer speed (× real time)', simFail: 'Simulated failure rate %', autoClear: 'Simulated printers clear their bed automatically',
    saved: 'Saved', notConfigured: 'needs a key', keyHint: 'Leave as is to keep the current key.',
    nozzleMm: 'Nozzle (mm)', enclosed: 'enclosed', needsApp: 'Helper app on the printer PC', downloadApp: 'download',
    keysCloud: 'API keys (Tripo, Meshy, Tap Payments) are stored in the cloud project, not in the app. The shop owner sets them in the Supabase dashboard (Edge Function secrets).',
    agentTitle: 'Print agent', agentHelp: 'Printing is driven by the Prompt2Print print agent running on the PC next to your printers. It picks jobs from the queue, slices them and sends them to the printer.',
  },
  ar: {
    overview: 'نظرة عامة', orders: 'الطلبات', queue: 'قائمة الطباعة', printers: 'الطابعات', products: 'المنتجات', pricing: 'التسعير',
    taxes: 'الضرائب', shipping: 'الشحن', users: 'المستخدمون', reports: 'تقارير المبيعات', settings: 'الإعدادات', store: 'عرض المتجر',
    grpShop: 'المتجر', grpPrint: 'الطباعة', grpMoney: 'المال', grpSystem: 'النظام',
    today: 'إيرادات اليوم', month: 'صافي الإيرادات، 30 يوماً', inPrint: 'طلبات قيد الطباعة', openJobs: 'مهام طباعة مفتوحة', aiToday: 'تصاميم الذكاء الاصطناعي اليوم',
    recent: 'أحدث الطلبات', order: 'الطلب', customer: 'العميل', status: 'الحالة', total: 'الإجمالي', placed: 'التاريخ', items: 'القطع', actions: 'الإجراءات',
    all: 'الكل', search: 'ابحث في الطلبات والبريد…', pack: 'تم التغليف', ship: 'تم الشحن', deliver: 'تم التوصيل', cancel: 'إلغاء الطلب',
    refund: 'استرداد', refundAmount: 'مبلغ الاسترداد (ريال)', reason: 'السبب', carrier: 'شركة الشحن', tracking: 'رقم التتبع', confirm: 'تأكيد',
    timeline: 'السجل', jobs: 'مهام الطباعة', address: 'العنوان', payment: 'الدفع', refunded: 'مسترد',
    job: 'المهمة', item: 'القطعة', material: 'الخامة', printer: 'الطابعة', progress: 'التقدم', position: 'الترتيب',
    up: 'للأعلى', down: 'للأسفل', top: 'إلى البداية', pause: 'إيقاف مؤقت', resume: 'استئناف', reprint: 'إعادة الطباعة', held: 'معلّق',
    emptyQueue: 'القائمة فارغة. تظهر الطلبات المدفوعة هنا تلقائياً.', printTime: 'مدة الطباعة', grams: 'الخيوط',
    addPrinter: 'إضافة طابعة', editPrinter: 'تعديل الطابعة', clearBed: 'السطح فارغ', clearError: 'مسح الخطأ', test: 'اختبار الاتصال',
    edit: 'تعديل', delete: 'حذف', name: 'الاسم', type: 'النوع', url: 'العنوان (رابط أو IP)', apiKey: 'مفتاح API', serial: 'الرقم التسلسلي',
    accessCode: 'رمز الوصول المحلي', flavor: 'نوع G-code', bed: 'مساحة الطباعة (مم)', materials: 'الخامات', profile: 'ملف إعدادات PrusaSlicer (اختياري)',
    active: 'نشط', save: 'حفظ', current: 'المهمة الحالية', idleNote: 'بانتظار المهمة التالية', awaitingNote: 'أزل القطعة المطبوعة ثم أكّد.',
    addProduct: 'إضافة منتج', editProduct: 'تعديل المنتج', fromPrompt: 'أنشئ نموذجاً من وصف', upload: 'أو ارفع ملف نموذج (STL أو OBJ أو GLB)',
    generate: 'إنشاء', nameEn: 'الاسم (إنجليزي)', nameAr: 'الاسم (عربي)', descEn: 'الوصف (إنجليزي)', descAr: 'الوصف (عربي)',
    category: 'الفئة', defMaterial: 'الخامة الافتراضية', defColor: 'اللون الافتراضي', allowed: 'الخامات المسموحة', defScale: 'الحجم الافتراضي (×)',
    minScale: 'أصغر حجم (×)', maxScale: 'أكبر حجم (×)', defInfill: 'نسبة الحشو الافتراضية %', tags: 'كلمات البحث', featured: 'مميز', sold: 'المبيعات',
    rating: 'التقييم', archived: 'مؤرشف (له طلبات سابقة)', size: 'الحجم',
    perGram: 'السعر لكل غرام (ريال)', inStock: 'متوفر', density: 'الكثافة (غ/سم³)', process: 'التقنية', colors: 'الألوان', nozzle: 'حرارة الفوهة', bedTemp: 'حرارة السطح',
    feeTitle: 'رسوم الخدمة', feeHelp: 'تُطبق أول شريحة لا يتجاوز المجموع الفرعي حدّها. الشريحة الأخيرة بلا حد.',
    upTo: 'المجموع الفرعي حتى (ريال)', andAbove: 'فما فوق', percent: 'الرسوم %', addTier: 'إضافة شريحة', removeTier: 'إزالة',
    calcTitle: 'حساب الوزن', wall: 'سماكة الجدار (مم)', wallHelp: 'الغلاف الصلب في معادلة الوزن: الغلاف = مساحة السطح × سماكة الجدار.',
    storeTitle: 'المتجر', storeName: 'اسم المتجر', currency: 'العملة', defCountry: 'دولة التوصيل الافتراضية',
    country: 'الدولة (رمز ISO أو *)', region: 'المنطقة (أو *)', rate: 'النسبة %', label: 'الوصف', addTax: 'إضافة أو تحديث نسبة',
    zone: 'المنطقة', countries: 'الدول', base: 'الأساس (ريال)', perKg: 'لكل كغ (ريال)', divisor: 'معامل الوزن الحجمي (سم³/كغ)', days: 'الأيام',
    minDays: 'أقل مدة', maxDays: 'أقصى مدة', addZone: 'إضافة منطقة', editZone: 'تعديل المنطقة',
    role: 'الدور', admin: 'مدير', customerRole: 'عميل', disabled: 'معطّل', enable: 'تفعيل', disable: 'تعطيل', makeAdmin: 'اجعله مديراً', removeAdmin: 'إزالة صلاحية المدير',
    spent: 'المشتريات', joined: 'تاريخ التسجيل', auditTitle: 'سجل الأمان (دخول الأدمن والتغييرات)',
    period: 'الفترة', last: 'آخر {n} يوماً', gross: 'إجمالي المبيعات', net: 'الصافي (بعد الاسترداد)', aov: 'متوسط الطلب', ordersCount: 'الطلبات المدفوعة',
    revenueDay: 'الإيرادات اليومية', split: 'توزيع الإيرادات', topProducts: 'أكثر المنتجات مبيعاً', materialUse: 'الخيوط المستخدمة حسب الخامة',
    byCountry: 'الطلبات حسب الدولة', aiShare: 'تصاميم الذكاء الاصطناعي مقابل المتجر', printHours: 'ساعات الطباعة', qty: 'الكمية', fee: 'رسوم الخدمة',
    aiTitle: 'توليد النماذج بالذكاء الاصطناعي', provider: 'المزوّد', meshyKey: 'مفتاح Meshy', tripoKey: 'مفتاح Tripo', hourly: 'عدد التصاميم لكل عميل في الساعة',
    defaultSize: 'الحجم الافتراضي لنماذج الذكاء الاصطناعي (مم)', payTitle: 'الدفع', payProvider: 'مزوّد الدفع', testMode: 'وضع التجربة (بطاقات تجريبية)',
    stripeKey: 'المفتاح السري لـ Stripe', stripeHook: 'سر Webhook لـ Stripe', printTitle: 'الطباعة', slicerPath: 'برنامج تقطيع خارجي (PrusaSlicer console .exe، اختياري)',
    tapKey: 'مفتاح Tap السري (sk_…)', tapPub: 'مفتاح Tap العام (pk_…)', tapHelp: 'Tap Payments تقبل فيزا وماستركارد وأمريكان إكسبريس وApple Pay ومدى من العملاء في أي مكان. سجّل في tap.company.',
    bambuPath: 'برنامج Bambu Studio (bambu-studio.exe) للتقطيع', bambuFound: 'تم العثور على Bambu Studio على هذا الجهاز وسيُستخدم تلقائياً.', bambuMissing: 'Bambu Studio غير مثبّت. تُقطّع المهام بالمقطّع المدمج حتى تثبّته من bambulab.com.',
    ams: 'خانات AMS (ما هو محمّل)', amsHelp: 'تبدأ المهمة فقط عندما تكون خامتها ولونها محمّلين في إحدى الخانات.', slot: 'الخانة', empty: 'فارغة',
    currencyTitle: 'العملات', currencyHelp: 'تُحفظ الأسعار بالريال وتُعرض بعملة دولة التوصيل. السعر = عدد الوحدات لكل 1 ريال.', code: 'الرمز', rateCol: 'السعر لكل 1 ريال', decimalsCol: 'الخانات العشرية', addCurrency: 'إضافة عملة', fallbackCurrency: 'عملة الدول الأخرى',
    durability: 'قواعد المتانة', minWall: 'أقل سماكة جدار (مم)', infillRange: 'نطاق الحشو المتاح للعملاء (%)', maxModel: 'أكبر حجم (مم، حد الطابعة)', autoProvider: 'تلقائي (أول خدمة ذكاء اصطناعي لها مفتاح)',
    simSpeed: 'سرعة الطابعات المحاكاة (× الوقت الحقيقي)', simFail: 'نسبة الأعطال المحاكاة %', autoClear: 'الطابعات المحاكاة تُفرغ السطح تلقائياً',
    saved: 'تم الحفظ', notConfigured: 'يحتاج مفتاحاً', keyHint: 'اتركه كما هو للإبقاء على المفتاح الحالي.',
    nozzleMm: 'الفوهة (مم)', enclosed: 'مغلقة', needsApp: 'البرنامج المساعد على جهاز الطابعة', downloadApp: 'تحميل',
    keysCloud: 'مفاتيح API (Tripo وMeshy وTap) محفوظة في المشروع السحابي وليس في التطبيق. يضعها صاحب المتجر في لوحة Supabase (أسرار Edge Functions).',
    agentTitle: 'وكيل الطباعة', agentHelp: 'الطباعة يديرها وكيل Prompt2Print الذي يعمل على الجهاز المجاور للطابعات: يأخذ المهام من القائمة ويقطّعها ويرسلها إلى الطابعة.',
  },
};
const a = (k, p = {}) => {
  let s = L[getLocale()][k] ?? L.en[k] ?? k;
  for (const [x, v] of Object.entries(p)) s = s.replaceAll(`{${x}}`, v);
  return s;
};

const NAV = [
  ['grpShop', ['overview', 'orders', 'products', 'users']],
  ['grpPrint', ['queue', 'printers']],
  ['grpMoney', ['pricing', 'taxes', 'shipping', 'reports']],
  ['grpSystem', ['settings']],
];

let refreshTimer = null;

export default async function admin(view, { params, query }) {
  if (!state.user) { navigate(`/signin?next=${encodeURIComponent(currentUrl().pathname)}`, { replace: true }); return; }
  if (state.user.role !== 'admin') { navigate('/', { replace: true }); return; }
  const section = params.section || 'overview';
  view.innerHTML = String(html`<div class="admin">
    <nav class="admin-nav" aria-label="Admin">
      <a class="logo" href="/" data-link style="padding:4px 8px 16px"><img src="img/logo.svg" alt="" width="30" height="30"><span>Prompt<b>2</b>Print</span></a>
      ${NAV.map(([g, items]) => html`<span class="grp">${a(g)}</span>${items.map((s) => html`<a href="/admin${s === 'overview' ? '' : `/${s}`}" data-link ${s === section ? raw('aria-current="page"') : ''}>${a(s)}</a>`)}`)}
      <span class="grp"></span>
      <a href="/" data-link>${a('store')}</a>
      <a href="#" data-action="lang">${t('nav.lang')}</a>
    </nav>
    <div class="admin-main" data-main></div>
  </div>`);
  const main = view.querySelector('[data-main]');
  clearInterval(refreshTimer);
  const pages = { overview, orders, queue, printers, products, pricing, taxes, shipping, users, reports, settings };
  await (pages[section] || overview)(main, query);
  return () => clearInterval(refreshTimer);
}

const head = (title, actions = '') => html`<div class="admin-head"><h1 style="font-size:26px">${title}</h1><div class="row-actions">${actions}</div></div>`;
const usd = (cents) => money(cents, 'SAR');   // admin figures are always in the base currency (SAR)
const tryDo = async (fn, msg) => { try { const r = await fn(); if (msg) toast(msg); return r; } catch (err) { toast(err.message, 'err'); throw err; } };
const autoRefresh = (fn, ms = 3000) => { clearInterval(refreshTimer); refreshTimer = setInterval(fn, ms); };

// Overview ----------------------------------------------------------------------------------------
async function overview(main) {
  const draw = async () => {
    const d = await api('/api/admin/overview');
    main.innerHTML = String(html`${head(a('overview'))}
      <div class="kpis">
        <div class="kpi"><span>${a('today')}</span><b>${usd(d.today.cents)}</b><span class="tiny">${num(d.today.n)} ${a('orders')}</span></div>
        <div class="kpi"><span>${a('month')}</span><b>${usd(d.month.cents)}</b><span class="tiny">${num(d.month.n)} ${a('orders')}</span></div>
        <div class="kpi"><span>${a('inPrint')}</span><b>${num((d.orderCounts.printing || 0) + (d.orderCounts.in_queue || 0))}</b><span class="tiny">${num(d.orderCounts.printed || 0)} ${t('status.printed')}</span></div>
        <div class="kpi"><span>${a('openJobs')}</span><b>${num(Object.values(d.jobCounts).reduce((x, y) => x + y, 0))}</b><span class="tiny">${num(d.aiDesignsToday)} ${a('aiToday')}</span></div>
      </div>
      <div class="section-head"><h2 style="font-size:19px">${a('printers')}</h2><a href="/admin/printers" data-link>${a('printers')}</a></div>
      <div class="printers">${d.printers.map(printerCard)}</div>
      <div class="section-head" style="margin-top:24px"><h2 style="font-size:19px">${a('recent')}</h2><a href="/admin/orders" data-link>${a('orders')}</a></div>
      ${ordersTable(d.recentOrders)}`);
    bindPrinterButtons(main, draw);
    bindOrderRows(main);
  };
  await draw();
  autoRefresh(draw, 4000);
}

function ordersTable(list) {
  return html`<div class="table-wrap"><table class="t"><thead><tr><th>${a('order')}</th><th>${a('customer')}</th><th>${a('items')}</th><th>${a('status')}</th><th class="num">${a('total')}</th><th>${a('placed')}</th></tr></thead>
    <tbody>${list.map((o) => html`<tr data-order="${o.id}" style="cursor:pointer"><td><strong>${o.number}</strong></td><td>${o.customer?.name || '—'}<div class="tiny muted">${o.customer?.email || ''}</div></td>
      <td>${o.items.map((i) => html`<img class="th" src="${i.thumb || ''}" alt="" title="${tr(i.title)}" style="margin-inline-end:4px">`)}</td>
      <td>${statusPill(o.status)}</td><td class="num">${usd(o.totalCents)}</td><td class="small">${dateTime(o.createdAt)}</td></tr>`)}</tbody></table></div>`;
}

function bindOrderRows(root) {
  root.querySelectorAll('[data-order]').forEach((row) => row.addEventListener('click', () => openOrder(row.dataset.order, () => row.closest('.admin-main') && null)));
}

// Orders ------------------------------------------------------------------------------------------
async function orders(main, query) {
  const statuses = ['pending_payment', 'paid', 'in_queue', 'printing', 'printed', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded'];
  const list = await api(`/api/admin/orders${qs({ status: query.status, q: query.q })}`);
  main.innerHTML = String(html`${head(a('orders'))}
    <form class="filters" data-filter>
      <input class="input" name="q" placeholder="${a('search')}" value="${query.q || ''}" style="max-width:280px">
      <select class="input" name="status" style="width:auto"><option value="">${a('all')}</option>${statuses.map((s) => html`<option value="${s}" ${query.status === s ? raw('selected') : ''}>${t(`status.${s}`)}</option>`)}</select>
      <button class="btn">${t('search.button')}</button>
    </form>
    ${ordersTable(list)}`);
  main.querySelector('[data-filter]').addEventListener('submit', (e) => { e.preventDefault(); navigate(`/admin/orders${qs(formData(e.target))}`); });
  bindOrderRows(main);
}

async function openOrder(id) {
  const o = await api(`/api/admin/orders/${id}`);
  const next = { printed: 'packed', packed: 'shipped', shipped: 'delivered' }[o.status];
  const m = modal(String(html`<h2>${a('order')} ${o.number} ${statusPill(o.status)}</h2>
    <p class="small muted">${o.customer?.name} · ${o.customer?.email} · ${dateTime(o.createdAt)}</p>
    ${o.items.map((i) => html`<div class="line-item" style="grid-template-columns:56px 1fr auto;padding:10px 0"><img src="${i.thumb || ''}" alt="" style="width:56px;height:56px">
      <div><strong>${tr(i.title)}</strong> × ${i.quantity}<div class="tiny muted">${i.material} · <i class="dot" style="background:${i.colorHex}"></i>${i.color} · ${dims(i.sizeMm)} · ${i.infill}% · ${num(i.weightGrams, 1)} g${i.needsSupports ? ' · supports' : ''}</div></div>
      <div class="num">${usd(i.filamentCents)}</div></div>`)}
    <div class="cols-2" style="margin-top:12px">
      <div class="receipt" style="padding:12px">
        <div class="row"><span class="k">${t('price.filament')}</span><span class="v">${usd(o.pricing.filamentCents)}</span></div>
        <div class="row"><span class="k">${t('price.tax')} (${o.pricing.taxRate?.rate || 0}%)</span><span class="v">${usd(o.pricing.taxCents)}</span></div>
        <div class="row"><span class="k">${t('price.shipping')}</span><span class="v">${usd(o.pricing.shippingCents)}</span></div>
        <div class="row"><span class="k">${t('price.fee')} (${o.pricing.feePercent}%)</span><span class="v">${usd(o.pricing.feeCents)}</span></div>
        <div class="row total"><span class="k">${t('price.total')}</span><span class="v">${usd(o.totalCents)}</span></div>
        ${o.refundedCents ? html`<div class="row"><span class="k">${a('refunded')}</span><span class="v">−${usd(o.refundedCents)}</span></div>` : ''}
      </div>
      <div class="small"><strong>${a('address')}</strong><p>${o.address.fullName}<br>${o.address.line1}${o.address.line2 ? `, ${o.address.line2}` : ''}<br>${o.address.city} ${o.address.region || ''} ${o.address.postalCode || ''}<br>${countryName(o.address.country)}</p>
        <strong>${a('payment')}</strong><p>${o.paymentProvider || '—'} ${o.paymentRef ? html`<span class="tiny muted">${o.paymentRef}</span>` : ''}</p>
        ${o.trackingNumber ? html`<strong>${a('tracking')}</strong><p dir="ltr" style="text-align:start">${o.carrier || ''} ${o.trackingNumber}</p>` : ''}</div>
    </div>
    <h3 style="font-size:15px;margin:12px 0 6px">${a('jobs')}</h3>
    <div class="small">${o.jobs.length ? o.jobs.map((j) => html`<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0"><span>#${j.id} · ${t(`job.${j.status}`)}</span><span class="num">${Math.round(j.progress)}%</span></div>`) : '—'}</div>
    <h3 style="font-size:15px;margin:12px 0 6px">${a('timeline')}</h3>
    <div class="small">${o.events.map((e) => html`<div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0"><span>${t(`status.${e.status}`)}${e.note ? ` · ${e.note}` : ''}</span><span class="muted">${dateTime(e.created_at)}</span></div>`)}</div>
    ${next === 'shipped' ? html`<div class="form-grid" style="margin-top:14px"><label class="field">${a('carrier')}<input class="input" data-carrier value="Aramex"></label><label class="field">${a('tracking')}<input class="input" data-tracking dir="ltr"></label></div>` : ''}
    <div class="modal-actions" style="flex-wrap:wrap">
      ${o.paidAt && o.totalCents > o.refundedCents ? html`<button class="btn btn-danger" data-refund>${a('refund')}</button>` : ''}
      ${!['shipped', 'delivered', 'cancelled', 'refunded'].includes(o.status) ? html`<button class="btn btn-danger" data-cancel>${a('cancel')}</button>` : ''}
      ${next ? html`<button class="btn btn-primary" data-advance="${next}">${a(next === 'packed' ? 'pack' : next === 'shipped' ? 'ship' : 'deliver')}</button>` : ''}
      <button class="btn" data-close>${t('common.close')}</button>
    </div>`));
  const reload = () => { m.close(); openOrder(id); };
  m.el.querySelector('[data-advance]')?.addEventListener('click', (e) => tryDo(() => api(`/api/admin/orders/${id}/advance`, {
    method: 'POST', body: { to: e.target.dataset.advance, carrier: m.el.querySelector('[data-carrier]')?.value, trackingNumber: m.el.querySelector('[data-tracking]')?.value },
  }), a('saved')).then(reload));
  m.el.querySelector('[data-cancel]')?.addEventListener('click', () => tryDo(() => api(`/api/admin/orders/${id}/cancel`, { method: 'POST', body: {} }), a('saved')).then(reload));
  m.el.querySelector('[data-refund]')?.addEventListener('click', () => {
    m.close();
    const r = modal(String(html`<h2>${a('refund')} ${o.number}</h2><form class="form-grid" data-f>
      <label class="field">${a('refundAmount')}<input class="input" name="amount" type="number" step="0.01" min="0.01" max="${(o.totalCents - o.refundedCents) / 100}" value="${((o.totalCents - o.refundedCents) / 100).toFixed(2)}"></label>
      <label class="field">${a('reason')}<input class="input" name="reason"></label>
      <div class="modal-actions full"><button type="button" class="btn" data-close>${t('common.cancel')}</button><button class="btn btn-primary">${a('confirm')}</button></div></form>`));
    r.el.querySelector('[data-f]').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = formData(e.target);
      tryDo(() => api(`/api/admin/orders/${id}/refund`, { method: 'POST', body: { amountCents: Math.round(Number(f.amount) * 100), reason: f.reason } }), a('saved')).then(() => { r.close(); openOrder(id); });
    });
  });
}

// Print queue ----------------------------------------------------------------------------------------
async function queue(main) {
  const draw = async () => {
    const jobs = await api('/api/admin/queue');
    main.innerHTML = String(html`${head(a('queue'))}
      ${jobs.length ? html`<div class="table-wrap"><table class="t"><thead><tr><th>${a('job')}</th><th>${a('item')}</th><th>${a('material')}</th><th>${a('status')}</th><th>${a('printer')}</th><th>${a('progress')}</th><th>${a('printTime')}</th><th>${a('actions')}</th></tr></thead>
        <tbody>${jobs.map((j) => html`<tr>
          <td><strong>#${j.id}</strong><div class="tiny muted">${j.order_number}</div></td>
          <td style="display:flex;gap:8px;align-items:center"><img class="th" src="${j.thumb || ''}" alt=""><div>${tr({ en: j.title_en, ar: j.title_ar })}<div class="tiny muted">${num(j.scale * 100)}% · ${j.infill}%</div></div></td>
          <td><i class="dot" style="background:${j.color_hex}"></i>${j.material}</td>
          <td>${statusPill(j.status, 'job')}${j.held ? html` <span class="badge">${a('held')}</span>` : ''}${j.error ? html`<div class="tiny" style="color:var(--bad);max-width:220px">${j.error}</div>` : ''}</td>
          <td>${j.printer_name || '—'}</td>
          <td style="min-width:110px"><div class="progress"><i style="width:${j.status === 'printed' ? 100 : j.progress}%"></i></div><span class="tiny num">${Math.round(j.status === 'printed' ? 100 : j.progress)}%</span></td>
          <td class="small num">${j.stats?.printTimeSec ? `${Math.floor(j.stats.printTimeSec / 3600)}h ${Math.round((j.stats.printTimeSec % 3600) / 60)}m` : '—'}${j.stats?.filamentGrams ? html`<div class="tiny muted">${num(j.stats.filamentGrams, 1)} g</div>` : ''}</td>
          <td><div class="row-actions">${jobActions(j)}</div></td></tr>`)}</tbody></table></div>`
        : html`<div class="panel empty"><p class="muted">${a('emptyQueue')}</p></div>`}`);
    main.querySelectorAll('[data-job]').forEach((b) => b.addEventListener('click', () => tryDo(() => api(`/api/admin/jobs/${b.dataset.job}/${b.dataset.act}`, { method: 'POST' })).then(draw)));
  };
  await draw();
  autoRefresh(draw, 3000);
}

function jobActions(j) {
  const btn = (act, label, cls = '') => html`<button class="btn btn-sm ${cls}" data-job="${j.id}" data-act="${act}" title="${label}">${label}</button>`;
  const out = [];
  if (['queued', 'ready', 'slicing'].includes(j.status)) out.push(btn('top', '⤒'), btn('up', '↑'), btn('down', '↓'));
  if (j.status === 'printing' || (['queued', 'ready'].includes(j.status) && !j.held)) out.push(btn('pause', a('pause')));
  if (j.status === 'paused' || j.held) out.push(btn('resume', a('resume')));
  if (['failed', 'cancelled', 'printed'].includes(j.status)) out.push(btn('reprint', a('reprint')));
  if (!['printed', 'cancelled'].includes(j.status)) out.push(btn('cancel', t('common.cancel'), 'btn-danger'));
  return out;
}

// Printers ----------------------------------------------------------------------------------------------
function printerCard(p) {
  return html`<div class="printer">
    <div class="printer-head"><div><h3>${p.name}</h3><span class="tiny muted">${p.driverLabel} · ${p.bed.x}×${p.bed.y}×${p.bed.z} · ${p.materials.join(', ')}</span></div>${statusPill(p.status === 'idle' ? 'idle' : p.status, 'pstatus')}</div>
    ${p.job ? html`<div class="job"><img src="${p.job.thumb || ''}" alt=""><div><strong>${tr(p.job.title)}</strong><div class="tiny muted">${p.job.orderNumber} · #${p.job.id}</div>
      <div class="progress" style="margin-top:6px"><i style="width:${p.progress}%"></i></div><span class="tiny num">${num(p.progress, 1)}%</span></div></div>`
      : html`<p class="small muted" style="margin:0">${p.status === 'awaiting_clear' ? a('awaitingNote') : p.status === 'idle' ? a('idleNote') : p.detail || ''}</p>`}
    <div class="row-actions">
      ${p.status === 'awaiting_clear' ? html`<button class="btn btn-sm btn-primary" data-clear="${p.id}">${a('clearBed')}</button>` : ''}
      ${['error', 'offline'].includes(p.status) ? html`<button class="btn btn-sm" data-clear="${p.id}">${a('clearError')}</button>` : ''}
      <button class="btn btn-sm" data-test="${p.id}">${a('test')}</button>
      <button class="btn btn-sm" data-edit-printer="${p.id}">${a('edit')}</button>
    </div></div>`;
}

let printerCache = null;
function bindPrinterButtons(root, redraw) {
  root.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => tryDo(() => api(`/api/admin/printers/${b.dataset.clear}/clear`, { method: 'POST' })).then(redraw)));
  root.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', async () => {
    const r = await api(`/api/admin/printers/${b.dataset.test}/test`, { method: 'POST' });
    toast(r.message, r.ok ? 'ok' : 'err');
  }));
  root.querySelectorAll('[data-edit-printer]').forEach((b) => b.addEventListener('click', async () => {
    printerCache = printerCache || await api('/api/admin/printers');
    const fresh = await api('/api/admin/printers');
    printerForm(fresh, fresh.printers.find((p) => p.id === Number(b.dataset.editPrinter)), redraw);
  }));
}

async function printers(main) {
  const draw = async () => {
    const d = await api('/api/admin/printers');
    main.innerHTML = String(html`${head(a('printers'), html`<button class="btn btn-primary" data-add>${a('addPrinter')}</button>`)}
      <div class="printers">${d.printers.map(printerCard)}</div>`);
    bindPrinterButtons(main, draw);
    main.querySelector('[data-add]').addEventListener('click', () => printerForm(d, null, draw));
  };
  await draw();
  autoRefresh(draw, 3000);
}

function printerForm(d, p, done) {
  const mats = state.boot.materials.map((m) => m.code);
  const types = d.types || [];
  const v = p || { name: '', typeCode: types[0]?.code, address: '', serial: '', access_code: '', nozzleMm: 0.4, materials: mats, active: false, ams: [] };
  const colorsOf = (code) => state.boot.materials.find((m) => m.code === code)?.colors || [];
  const typeOf = (code) => types.find((x) => x.code === code) || types[0];
  const t0 = typeOf(v.typeCode);
  const slotCount = Math.max(1, t0?.slots || 1);
  const slots = Array.from({ length: 8 }, (_, i) => v.ams?.[i] || null);
  const m = modal(String(html`<h2>${p ? a('editPrinter') : a('addPrinter')}</h2><form class="form-grid" data-f>
    <label class="field">${a('name')}<input class="input" name="name" value="${v.name}" required placeholder="${t0?.name || ''}"></label>
    <label class="field">${a('type')}<select class="input" name="typeCode">${types.map((x) => html`<option value="${x.code}" ${x.code === v.typeCode ? raw('selected') : ''}>${x.vendor} ${x.name}</option>`)}</select></label>
    <div class="field full panel" data-typeinfo style="padding:12px 14px;gap:6px"></div>
    <label class="field full" data-f-address>${a('url')}<input class="input" name="address" value="${v.address || ''}" dir="ltr" placeholder="192.168.1.50"></label>
    <label class="field" data-f-serial>${a('serial')}<input class="input" name="serial" value="${v.serial || ''}" dir="ltr"></label>
    <label class="field" data-f-access_code>${a('accessCode')}<input class="input" name="access_code" value="${v.access_code || ''}" dir="ltr"></label>
    <label class="field">${a('nozzleMm')}<select class="input" name="nozzleMm">${[0.2, 0.4, 0.6, 0.8].map((n) => html`<option ${Number(v.nozzleMm) === n ? raw('selected') : ''}>${n}</option>`)}</select></label>
    <div class="field">${a('bed')}<div class="small muted" data-bed></div></div>
    <div class="field full">${a('materials')}<div class="seg">${mats.map((code) => html`<label class="btn btn-sm"><input type="checkbox" name="mat" value="${code}" ${v.materials.includes(code) ? raw('checked') : ''}> ${code}</label>`)}</div></div>
    <div class="field full">${a('ams')}<span class="hint" style="display:block;margin-top:4px">${a('amsHelp')}</span>
      <div style="display:grid;gap:8px" data-slots>${slots.map((s, i) => html`<div data-slot="${i}" style="display:grid;grid-template-columns:60px 1fr 1fr;gap:8px;align-items:center" ${i < slotCount ? '' : raw('hidden')}><span class="small muted">${a('slot')} ${i + 1}</span>
        <select class="input" name="ams_mat_${i}"><option value="">${a('empty')}</option>${mats.map((c) => html`<option ${s?.material === c ? raw('selected') : ''}>${c}</option>`)}</select>
        <select class="input" name="ams_col_${i}">${(s ? colorsOf(s.material) : colorsOf(mats[0])).map((c) => html`<option value="${c.code}" ${s?.color === c.code ? raw('selected') : ''}>${tr(c.name)}</option>`)}</select></div>`)}</div></div>
    <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${v.active ? raw('checked') : ''}> ${a('active')}</label>
    <div class="modal-actions full">${p ? html`<button type="button" class="btn btn-danger" data-del>${a('delete')}</button>` : ''}<button type="button" class="btn" data-close>${t('common.cancel')}</button><button class="btn btn-primary">${a('save')}</button></div>
  </form>`));
  const form = m.el.querySelector('[data-f]');
  const syncType = () => {
    const ty = typeOf(form.typeCode.value);
    if (!ty) return;
    const fields = { bambu: ['address', 'serial', 'access_code'], prusalink: ['address', 'access_code'], moonraker: ['address'], octoprint: ['address', 'access_code'] }[ty.driver] || ['address'];
    for (const f of ['address', 'serial', 'access_code']) form.querySelector(`[data-f-${f}]`).hidden = !fields.includes(f);
    form.querySelector('[data-f-access_code] input').placeholder = ty.driver === 'bambu' ? a('accessCode') : a('apiKey');
    m.el.querySelector('[data-bed]').textContent = `${ty.bed.x} × ${ty.bed.y} × ${ty.bed.z} mm · ${a('nozzle')} ≤ ${ty.max_nozzle_c} °C · ${a('bedTemp')} ≤ ${ty.max_bed_c} °C${ty.enclosed ? ` · ${a('enclosed')}` : ''}`;
    m.el.querySelector('[data-typeinfo]').innerHTML = String(html`<div class="small"><strong>${a('needsApp')}:</strong> ${ty.slicer_app} — <a href="${ty.slicer_url}" target="_blank" rel="noopener">${a('downloadApp')}</a></div>
      ${(getLocale() === 'ar' ? ty.notes_ar : ty.notes_en) ? html`<div class="small muted">${getLocale() === 'ar' ? ty.notes_ar : ty.notes_en}</div>` : ''}`);
    const n = Math.max(1, ty.slots || 1);
    m.el.querySelectorAll('[data-slot]').forEach((row) => { row.hidden = Number(row.dataset.slot) >= n; });
    if (!p && !form.name.value) form.name.value = `${ty.vendor} ${ty.name}`;
  };
  form.typeCode.addEventListener('change', syncType);
  syncType();
  for (let i = 0; i < 8; i++) {
    form[`ams_mat_${i}`].addEventListener('change', (e) => {
      form[`ams_col_${i}`].innerHTML = String(html`${colorsOf(e.target.value).map((c) => html`<option value="${c.code}">${tr(c.name)}</option>`)}`);
    });
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const ty = typeOf(f.get('typeCode'));
    const n = Math.max(1, ty?.slots || 1);
    const body = {
      name: f.get('name'), typeCode: f.get('typeCode'), address: f.get('address'), serial: f.get('serial'), accessCode: f.get('access_code'), nozzleMm: Number(f.get('nozzleMm')),
      materials: f.getAll('mat'), active: f.get('active') === 'on',
      slots: Array.from({ length: n }, (_, i) => ({ slot: i + 1, material: f.get(`ams_mat_${i}`) || null, color: f.get(`ams_mat_${i}`) ? f.get(`ams_col_${i}`) : null })),
    };
    tryDo(() => api(p ? `/api/admin/printers/${p.id}` : '/api/admin/printers', { method: p ? 'PUT' : 'POST', body }), a('saved')).then(() => { m.close(); done(); });
  });
  m.el.querySelector('[data-del]')?.addEventListener('click', () => tryDo(() => api(`/api/admin/printers/${p.id}`, { method: 'DELETE' }), a('saved')).then(() => { m.close(); done(); }));
}

// Products ------------------------------------------------------------------------------------------------
async function products(main) {
  const [list, cats] = await Promise.all([api('/api/admin/products'), api('/api/admin/categories')]);
  const catName = (id) => { const c = cats.find((x) => x.id === id); return c ? tr({ en: c.name_en, ar: c.name_ar }) : '—'; };
  main.innerHTML = String(html`${head(a('products'), html`<button class="btn btn-primary" data-add>${a('addProduct')}</button>`)}
    <div class="table-wrap"><table class="t"><thead><tr><th></th><th>${a('name')}</th><th>${a('category')}</th><th>${a('defMaterial')}</th><th>${a('size')}</th><th class="num">${a('sold')}</th><th class="num">${a('rating')}</th><th>${a('featured')}</th><th>${a('active')}</th><th></th></tr></thead>
    <tbody>${list.map((p) => html`<tr><td><img class="th" src="${p.images[0] || ''}" alt=""></td><td><strong>${tr(p.name)}</strong><div class="tiny muted">/p/${p.slug}</div></td>
      <td>${catName(p.categoryId)}</td><td>${p.defaultMaterial} · ${p.defaultColor}</td><td class="small">${p.analysis ? dims(p.analysis.sizeMm) : ''}</td>
      <td class="num">${num(p.soldCount)}</td><td class="num">${num(p.rating, 1)}</td><td>${p.featured ? '★' : ''}</td><td>${p.active ? t('common.yes') : t('common.no')}</td>
      <td><button class="btn btn-sm" data-edit="${p.id}">${a('edit')}</button></td></tr>`)}</tbody></table></div>`);
  main.querySelector('[data-add]').addEventListener('click', () => productForm(null, cats, () => products(main)));
  main.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => productForm(list.find((p) => p.id === Number(b.dataset.edit)), cats, () => products(main))));
}

function productForm(p, cats, done) {
  const mats = state.boot.materials;
  const v = p || { name: { en: '', ar: '' }, description: { en: '', ar: '' }, defaultMaterial: 'ABS', defaultColor: 'black', allowedMaterials: ['ABS', 'ASA'], defaultScale: 1, minScale: 0.5, maxScale: 2, defaultInfill: 35, featured: false, active: true, categoryId: cats[0]?.id };
  let modelId = p?.modelId || null;
  const colorOpts = (code, sel) => (mats.find((m) => m.code === code)?.colors || []).map((c) => html`<option value="${c.code}" ${c.code === sel ? raw('selected') : ''}>${tr(c.name)}</option>`);
  const m = modal(String(html`<h2>${p ? a('editProduct') : a('addProduct')}</h2>
    ${!p ? html`<div class="panel" style="margin-bottom:14px;display:grid;gap:10px">
      <label class="field">${a('fromPrompt')}<div style="display:flex;gap:8px"><input class="input" data-prompt placeholder="a tall twisted vase"><button type="button" class="btn btn-dark" data-gen>${a('generate')}</button></div></label>
      <div data-model-preview class="small muted"></div></div>` : html`<img src="${p.images[0] || ''}" alt="" style="width:120px;border-radius:10px;margin-bottom:10px">`}
    <form class="form-grid" data-f>
      <label class="field">${a('nameEn')}<input class="input" name="name_en" value="${v.name.en}" required></label>
      <label class="field">${a('nameAr')}<input class="input" name="name_ar" value="${v.name.ar}" dir="rtl"></label>
      <label class="field full">${a('descEn')}<textarea class="input" name="desc_en">${v.description.en}</textarea></label>
      <label class="field full">${a('descAr')}<textarea class="input" name="desc_ar" dir="rtl">${v.description.ar}</textarea></label>
      <label class="field">${a('category')}<select class="input" name="categoryId">${cats.map((c) => html`<option value="${c.id}" ${c.id === v.categoryId ? raw('selected') : ''}>${tr({ en: c.name_en, ar: c.name_ar })}</option>`)}</select></label>
      <label class="field">${a('tags')}<input class="input" name="tags" value="${v.tags || ''}"></label>
      <label class="field">${a('defMaterial')}<select class="input" name="defaultMaterial">${mats.map((x) => html`<option ${x.code === v.defaultMaterial ? raw('selected') : ''}>${x.code}</option>`)}</select></label>
      <label class="field">${a('defColor')}<select class="input" name="defaultColor">${colorOpts(v.defaultMaterial, v.defaultColor)}</select></label>
      <div class="field full">${a('allowed')}<div class="seg">${mats.map((x) => html`<label class="btn btn-sm"><input type="checkbox" name="allowed" value="${x.code}" ${v.allowedMaterials.includes(x.code) ? raw('checked') : ''}> ${x.code}</label>`)}</div></div>
      <label class="field">${a('minScale')}<input class="input" type="number" step="0.05" name="minScale" value="${v.minScale}"></label>
      <label class="field">${a('maxScale')}<input class="input" type="number" step="0.05" name="maxScale" value="${v.maxScale}"></label>
      <label class="field">${a('defScale')}<input class="input" type="number" step="0.05" name="defaultScale" value="${v.defaultScale}"></label>
      <label class="field">${a('defInfill')}<input class="input" type="number" min="5" max="100" name="defaultInfill" value="${v.defaultInfill}"></label>
      <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="featured" ${v.featured ? raw('checked') : ''}> ${a('featured')}</label>
      <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${v.active ? raw('checked') : ''}> ${a('active')}</label>
      <div class="modal-actions full">${p ? html`<button type="button" class="btn btn-danger" data-del>${a('delete')}</button>` : ''}<button type="button" class="btn" data-close>${t('common.cancel')}</button><button class="btn btn-primary">${a('save')}</button></div>
    </form>`));
  const form = m.el.querySelector('[data-f]');
  form.defaultMaterial.addEventListener('change', () => { form.defaultColor.innerHTML = String(html`${colorOpts(form.defaultMaterial.value)}`); });
  const showModel = (r) => {
    modelId = r.modelId;
    m.el.querySelector('[data-model-preview]').innerHTML = String(html`<div style="display:flex;gap:12px;align-items:center"><img src="${r.preview}" alt="" style="width:96px;border-radius:8px"><span>${dims(r.analysis.sizeMm)} · ${r.analysis.watertight ? t('check.watertight') : '⚠'}</span></div>`);
    if (r.suggested && !form.name_en.value) { form.name_en.value = r.suggested.name_en; form.name_ar.value = r.suggested.name_ar; form.desc_en.value = r.suggested.desc_en; form.desc_ar.value = r.suggested.desc_ar; }
  };
  m.el.querySelector('[data-gen]')?.addEventListener('click', () => {
    const prompt = m.el.querySelector('[data-prompt]').value.trim();
    if (prompt) tryDo(() => api('/api/admin/models/generate', { method: 'POST', body: { prompt, seed: Math.floor(Math.random() * 1000) } })).then(showModel);
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const body = {
      modelId, categoryId: Number(f.get('categoryId')), name: { en: f.get('name_en'), ar: f.get('name_ar') }, description: { en: f.get('desc_en'), ar: f.get('desc_ar') },
      defaultMaterial: f.get('defaultMaterial'), defaultColor: f.get('defaultColor'), allowedMaterials: f.getAll('allowed'), minScale: Number(f.get('minScale')),
      maxScale: Number(f.get('maxScale')), defaultScale: Number(f.get('defaultScale')), defaultInfill: Number(f.get('defaultInfill')), tags: f.get('tags'),
      featured: f.get('featured') === 'on', active: f.get('active') === 'on',
    };
    tryDo(() => api(p ? `/api/admin/products/${p.id}` : '/api/admin/products', { method: p ? 'PUT' : 'POST', body }), a('saved')).then(() => { m.close(); done(); });
  });
  m.el.querySelector('[data-del]')?.addEventListener('click', () => tryDo(() => api(`/api/admin/products/${p.id}`, { method: 'DELETE' })).then((r) => { toast(r.archived ? a('archived') : a('saved')); m.close(); done(); }));
}

// Pricing: materials, fee tiers, weight settings ----------------------------------------------------------
async function pricing(main) {
  const [mats, s] = await Promise.all([api('/api/admin/materials'), api('/api/admin/settings')]);
  main.innerHTML = String(html`${head(a('pricing'))}
    <div class="table-wrap" style="margin-bottom:20px"><table class="t"><thead><tr><th>${a('material')}</th><th>${a('perGram')}</th><th>${a('density')}</th><th>${a('process')}</th><th>${a('colors')}</th><th>${a('active')}</th><th></th></tr></thead>
    <tbody>${mats.map((m) => html`<tr><td><strong>${m.code}</strong><div class="tiny muted">${tr({ en: m.name_en, ar: m.name_ar })}</div></td>
      <td><input class="input" type="number" step="0.001" min="0.001" data-price="${m.code}" value="${m.price_per_gram}" style="width:110px"></td>
      <td><input class="input" type="number" step="0.01" data-density="${m.code}" value="${m.density}" style="width:90px"></td>
      <td>${m.process}</td><td>${m.colors.map((c) => html`<i class="dot" style="background:${c.hex};${c.in_stock === false ? 'opacity:.25' : ''}" title="${c.name_en}${c.in_stock === false ? ' (out of stock)' : ''}"></i>`)}</td>
      <td><input type="checkbox" data-active="${m.code}" ${m.active ? raw('checked') : ''}></td>
      <td><button class="btn btn-sm" data-save-mat="${m.code}">${a('save')}</button> <button class="btn btn-sm" data-colors="${m.code}">${a('colors')}</button></td></tr>`)}</tbody></table></div>
    <div class="cols-2">
      <form class="panel" data-fees style="display:grid;gap:12px;align-content:start">
        <h2 style="font-size:19px">${a('feeTitle')}</h2><p class="small muted" style="margin:0">${a('feeHelp')}</p>
        <div data-tiers style="display:grid;gap:8px"></div>
        <div class="row-actions"><button type="button" class="btn btn-sm" data-add-tier>${a('addTier')}</button><button class="btn btn-primary btn-sm">${a('save')}</button></div>
      </form>
      <form class="panel" data-calc style="display:grid;gap:12px;align-content:start">
        <h2 style="font-size:19px">${a('calcTitle')}</h2>
        <label class="field">${a('wall')}<input class="input" type="number" step="0.1" name="wall_thickness_mm" value="${s.wall_thickness_mm}"><span class="hint">${a('wallHelp')}</span></label>
        <h2 style="font-size:19px;margin-top:8px">${a('storeTitle')}</h2>
        <label class="field">${a('storeName')}<input class="input" name="store_name" value="${s.store_name}"></label>
        <div class="form-grid"><label class="field">${a('currency')}<input class="input" name="currency" value="${s.currency}" maxlength="3"></label>
        <label class="field">${a('defCountry')}<input class="input" name="default_country" value="${s.default_country}" maxlength="2"></label></div>
        <div><button class="btn btn-primary btn-sm">${a('save')}</button></div>
      </form>
    </div>`);

  let tiers = s.fee_tiers.map((x) => ({ ...x }));
  const drawTiers = () => {
    main.querySelector('[data-tiers]').innerHTML = String(html`${tiers.map((x, i) => html`<div class="tier-row">
      <label class="field">${a('upTo')}${x.maxCents === null ? html`<input class="input" value="${a('andAbove')}" disabled>` : html`<input class="input" type="number" step="0.01" data-max="${i}" value="${(x.maxCents / 100).toFixed(2)}">`}</label>
      <label class="field">${a('percent')}<input class="input" type="number" step="0.1" data-pct="${i}" value="${x.percent}"></label>
      ${x.maxCents !== null && tiers.length > 2 ? html`<button type="button" class="btn btn-sm" data-rm="${i}">${a('removeTier')}</button>` : html`<span></span>`}</div>`)}`);
    main.querySelectorAll('[data-max]').forEach((el) => el.addEventListener('input', () => { tiers[el.dataset.max].maxCents = Math.round(Number(el.value) * 100); }));
    main.querySelectorAll('[data-pct]').forEach((el) => el.addEventListener('input', () => { tiers[el.dataset.pct].percent = Number(el.value); }));
    main.querySelectorAll('[data-rm]').forEach((el) => el.addEventListener('click', () => { tiers.splice(Number(el.dataset.rm), 1); drawTiers(); }));
  };
  drawTiers();
  main.querySelector('[data-add-tier]').addEventListener('click', () => {
    const finite = tiers.filter((x) => x.maxCents !== null);
    const last = finite[finite.length - 1]?.maxCents ?? 0;
    tiers.splice(finite.length, 0, { maxCents: last + 10000, percent: 10 });
    drawTiers();
  });
  main.querySelector('[data-fees]').addEventListener('submit', (e) => { e.preventDefault(); tryDo(() => api('/api/admin/settings', { method: 'PUT', body: { fee_tiers: tiers } }), a('saved')); });
  main.querySelector('[data-calc]').addEventListener('submit', (e) => { e.preventDefault(); tryDo(() => api('/api/admin/settings', { method: 'PUT', body: formData(e.target) }), a('saved')); });
  main.querySelectorAll('[data-save-mat]').forEach((b) => b.addEventListener('click', () => {
    const code = b.dataset.saveMat;
    const m = mats.find((x) => x.code === code);
    tryDo(() => api(`/api/admin/materials/${code}`, { method: 'PUT', body: { ...m, price_per_gram: Number(main.querySelector(`[data-price="${code}"]`).value), density: Number(main.querySelector(`[data-density="${code}"]`).value), active: main.querySelector(`[data-active="${code}"]`).checked } }), a('saved'));
  }));
  main.querySelectorAll('[data-colors]').forEach((b) => b.addEventListener('click', () => {
    const m = mats.find((x) => x.code === b.dataset.colors);
    const row = (c = {}) => `<div class="tier-row" style="grid-template-columns:1fr 1fr 1fr 60px auto auto"><input class="input" data-c="code" value="${esc(c.code || '')}" placeholder="code"><input class="input" data-c="name_en" value="${esc(c.name_en || '')}" placeholder="English"><input class="input" data-c="name_ar" value="${esc(c.name_ar || '')}" placeholder="عربي" dir="rtl"><input class="input" type="color" data-c="hex" value="${esc(c.hex || '#888888')}" style="padding:2px"><label class="small" style="display:flex;gap:6px;align-items:center;white-space:nowrap"><input type="checkbox" data-stock ${c.in_stock === false ? '' : 'checked'}> ${esc(a('inStock'))}</label><button type="button" class="btn btn-sm" data-rmc>×</button></div>`;
    const dlg = modal(`<h2>${esc(m.code)} · ${esc(a('colors'))}</h2><div data-rows style="display:grid;gap:8px">${m.colors.map(row).join('')}</div>
      <div class="modal-actions"><button type="button" class="btn" data-addc>+</button><button type="button" class="btn" data-close>${esc(t('common.cancel'))}</button><button type="button" class="btn btn-primary" data-savec>${esc(a('save'))}</button></div>`);
    const bindRm = () => dlg.el.querySelectorAll('[data-rmc]').forEach((x) => { x.onclick = () => x.parentElement.remove(); });
    bindRm();
    dlg.el.querySelector('[data-addc]').addEventListener('click', () => { dlg.el.querySelector('[data-rows]').insertAdjacentHTML('beforeend', row()); bindRm(); });
    dlg.el.querySelector('[data-savec]').addEventListener('click', () => {
      const colors = [...dlg.el.querySelectorAll('[data-rows] > div')].map((r) => ({ ...Object.fromEntries([...r.querySelectorAll('[data-c]')].map((i) => [i.dataset.c, i.value])), in_stock: r.querySelector('[data-stock]').checked }));
      tryDo(() => api(`/api/admin/materials/${m.code}`, { method: 'PUT', body: { ...m, colors } }), a('saved')).then(() => { dlg.close(); pricing(main); });
    });
  }));
}

// Taxes -------------------------------------------------------------------------------------------------
async function taxes(main) {
  const list = await api('/api/admin/taxes');
  main.innerHTML = String(html`${head(a('taxes'))}
    <form class="panel form-grid" data-f style="grid-template-columns:repeat(4,minmax(0,1fr)) auto;align-items:end;margin-bottom:16px">
      <label class="field">${a('country')}<input class="input" name="country" required maxlength="2" placeholder="SA"></label>
      <label class="field">${a('region')}<input class="input" name="region" placeholder="*"></label>
      <label class="field">${a('rate')}<input class="input" name="rate" type="number" step="0.01" min="0" required></label>
      <label class="field">${a('label')}<input class="input" name="label" placeholder="VAT"></label>
      <button class="btn btn-primary">${a('addTax')}</button>
    </form>
    <div class="table-wrap"><table class="t"><thead><tr><th>${a('country')}</th><th>${a('region')}</th><th class="num">${a('rate')}</th><th>${a('label')}</th><th></th></tr></thead>
    <tbody>${list.map((x) => html`<tr><td>${x.country === '*' ? '* (everywhere else)' : `${x.country} · ${countryName(x.country)}`}</td><td>${x.region}</td><td class="num">${num(x.rate, 2)}%</td><td>${x.label || ''}</td>
      <td><button class="btn btn-sm btn-danger" data-del="${x.id}">${a('delete')}</button></td></tr>`)}</tbody></table></div>`);
  main.querySelector('[data-f]').addEventListener('submit', (e) => { e.preventDefault(); tryDo(() => api('/api/admin/taxes', { method: 'POST', body: formData(e.target) }), a('saved')).then(() => taxes(main)); });
  main.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => tryDo(() => api(`/api/admin/taxes/${b.dataset.del}`, { method: 'DELETE' })).then(() => taxes(main))));
}

// Shipping zones -----------------------------------------------------------------------------------------
async function shipping(main) {
  const list = await api('/api/admin/shipping');
  main.innerHTML = String(html`${head(a('shipping'), html`<button class="btn btn-primary" data-add>${a('addZone')}</button>`)}
    <div class="table-wrap"><table class="t"><thead><tr><th>${a('zone')}</th><th>${a('countries')}</th><th class="num">${a('base')}</th><th class="num">${a('perKg')}</th><th class="num">${a('divisor')}</th><th>${a('days')}</th><th>${a('active')}</th><th></th></tr></thead>
    <tbody>${list.map((z) => html`<tr><td><strong>${tr({ en: z.name_en, ar: z.name_ar })}</strong></td><td class="small">${z.countries.join(', ')}</td>
      <td class="num">${usd(z.base_cents)}</td><td class="num">${usd(z.per_kg_cents)}</td><td class="num">${num(z.volumetric_divisor)}</td><td>${z.min_days}–${z.max_days}</td><td>${z.active ? t('common.yes') : t('common.no')}</td>
      <td><button class="btn btn-sm" data-edit="${z.id}">${a('edit')}</button></td></tr>`)}</tbody></table></div>
    <p class="small muted" style="margin-top:10px">Shipping = base + per-kg × billable weight. Billable weight = the larger of the real package weight and (L × W × H cm ÷ divisor), rounded up to 0.5 kg.</p>`);
  const open = (z) => {
    const v = z || { name_en: '', name_ar: '', countries: [], base_cents: 1000, per_kg_cents: 800, volumetric_divisor: 5000, min_days: 3, max_days: 7, active: true };
    const m = modal(String(html`<h2>${z ? a('editZone') : a('addZone')}</h2><form class="form-grid" data-f>
      <label class="field">${a('nameEn')}<input class="input" name="name_en" value="${v.name_en}" required></label>
      <label class="field">${a('nameAr')}<input class="input" name="name_ar" value="${v.name_ar}" dir="rtl"></label>
      <label class="field full">${a('countries')}<input class="input" name="countries" value="${v.countries.join(', ')}" placeholder="SA, AE, KW  or  *"></label>
      <label class="field">${a('base')}<input class="input" type="number" step="0.01" name="base" value="${(v.base_cents / 100).toFixed(2)}"></label>
      <label class="field">${a('perKg')}<input class="input" type="number" step="0.01" name="perKg" value="${(v.per_kg_cents / 100).toFixed(2)}"></label>
      <label class="field">${a('divisor')}<input class="input" type="number" name="volumetric_divisor" value="${v.volumetric_divisor}"></label>
      <label class="field">${a('minDays')}<input class="input" type="number" name="min_days" value="${v.min_days}"></label>
      <label class="field">${a('maxDays')}<input class="input" type="number" name="max_days" value="${v.max_days}"></label>
      <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${v.active ? raw('checked') : ''}> ${a('active')}</label>
      <div class="modal-actions full">${z ? html`<button type="button" class="btn btn-danger" data-del>${a('delete')}</button>` : ''}<button type="button" class="btn" data-close>${t('common.cancel')}</button><button class="btn btn-primary">${a('save')}</button></div></form>`));
    m.el.querySelector('[data-f]').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = formData(e.target);
      const body = { ...f, base_cents: Math.round(Number(f.base) * 100), per_kg_cents: Math.round(Number(f.perKg) * 100), active: f.active === 'on' };
      tryDo(() => api(z ? `/api/admin/shipping/${z.id}` : '/api/admin/shipping', { method: z ? 'PUT' : 'POST', body }), a('saved')).then(() => { m.close(); shipping(main); });
    });
    m.el.querySelector('[data-del]')?.addEventListener('click', () => tryDo(() => api(`/api/admin/shipping/${z.id}`, { method: 'DELETE' })).then(() => { m.close(); shipping(main); }));
  };
  main.querySelector('[data-add]').addEventListener('click', () => open(null));
  main.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => open(list.find((z) => z.id === Number(b.dataset.edit)))));
}

// Users -------------------------------------------------------------------------------------------------
async function users(main, query) {
  const list = await api(`/api/admin/users${qs({ q: query.q })}`);
  main.innerHTML = String(html`${head(a('users'))}
    <form class="filters" data-filter><input class="input" name="q" value="${query.q || ''}" placeholder="${a('search')}" style="max-width:280px"><button class="btn">${t('search.button')}</button></form>
    <div class="table-wrap"><table class="t"><thead><tr><th>${a('name')}</th><th>${t('account.email')}</th><th>${a('role')}</th><th class="num">${a('orders')}</th><th class="num">${a('spent')}</th><th>${a('joined')}</th><th>${a('actions')}</th></tr></thead>
    <tbody>${list.map((u) => html`<tr><td>${u.name}${u.disabled ? html` <span class="badge">${a('disabled')}</span>` : ''}</td><td dir="ltr" style="text-align:start">${u.email}</td>
      <td>${u.role === 'admin' ? a('admin') : a('customerRole')}</td><td class="num">${num(u.orders)}</td><td class="num">${usd(u.spent_cents)}</td><td class="small">${date(u.created_at)}</td>
      <td><div class="row-actions"><button class="btn btn-sm" data-role="${u.id}" data-val="${u.role === 'admin' ? 'customer' : 'admin'}">${u.role === 'admin' ? a('removeAdmin') : a('makeAdmin')}</button>
        <button class="btn btn-sm ${u.disabled ? '' : 'btn-danger'}" data-dis="${u.id}" data-val="${u.disabled ? 0 : 1}">${u.disabled ? a('enable') : a('disable')}</button></div></td></tr>`)}</tbody></table></div>`);
  main.querySelector('[data-filter]').addEventListener('submit', (e) => { e.preventDefault(); navigate(`/admin/users${qs(formData(e.target))}`); });
  const audit = await api('/api/admin/audit');
  main.insertAdjacentHTML('beforeend', String(html`<h2 style="font-size:19px;margin:24px 0 10px">${a('auditTitle')}</h2>
    <div class="table-wrap"><table class="t"><thead><tr><th>${a('placed')}</th><th>${t('account.email')}</th><th>${a('actions')}</th><th>IP</th></tr></thead>
    <tbody>${audit.map((x) => html`<tr><td class="small">${dateTime(x.created_at)}</td><td dir="ltr" style="text-align:start">${x.email || '—'}</td><td>${x.action}${x.detail ? html` <span class="tiny muted">${x.detail}</span>` : ''}</td><td class="small" dir="ltr">${x.ip}</td></tr>`)}</tbody></table></div>`));
  main.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => tryDo(() => api(`/api/admin/users/${b.dataset.role}`, { method: 'PUT', body: { role: b.dataset.val } }), a('saved')).then(() => users(main, query))));
  main.querySelectorAll('[data-dis]').forEach((b) => b.addEventListener('click', () => tryDo(() => api(`/api/admin/users/${b.dataset.dis}`, { method: 'PUT', body: { disabled: b.dataset.val === '1' } }), a('saved')).then(() => users(main, query))));
}

// Reports -----------------------------------------------------------------------------------------------
const SPLIT_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100']; // validated categorical slots 1–4

function revenueChart(byDay) {
  const W = 900, H = 260, padL = 56, padR = 12, padT = 12, padB = 28;
  const max = Math.max(1, ...byDay.map((d) => d.revenueCents));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const bw = (W - padL - padR) / byDay.length;
  const barW = Math.min(24, Math.max(2, bw - 2));
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  const labelEvery = Math.ceil(byDay.length / 8);
  const rtl = document.documentElement.dir === 'rtl';
  const x = (i) => (rtl ? W - padR - (i + 1) * bw : padL + i * bw);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(a('revenueDay'))}">
    ${ticks.map((v) => `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="#E9ECEE"/><text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#56606B">${esc(usd(v).replace(/\.00$/, ''))}</text>`).join('')}
    ${byDay.map((d, i) => {
      const h = Math.max(0, y(0) - y(d.revenueCents));
      const bx = x(i) + (bw - barW) / 2;
      const r = Math.min(4, h, barW / 2);
      const path = h > 0 ? `M${bx},${y(0)} V${y(0) - h + r} Q${bx},${y(0) - h} ${bx + r},${y(0) - h} H${bx + barW - r} Q${bx + barW},${y(0) - h} ${bx + barW},${y(0) - h + r} V${y(0)} Z` : '';
      return `<g class="bar" data-tip="${esc(`${date(d.date)} · ${usd(d.revenueCents)} · ${d.orders} ${a('orders')}`)}"><rect x="${x(i)}" y="${padT}" width="${bw}" height="${H - padT - padB}" fill="transparent"/>${path ? `<path d="${path}" fill="#2a78d6"/>` : ''}
        ${i % labelEvery === 0 ? `<text x="${x(i) + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#56606B">${esc(date(d.date, { month: 'short', day: 'numeric' }))}</text>` : ''}</g>`;
    }).join('')}
    <line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="#8B939C"/>
  </svg>`;
}

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

async function reports(main, query) {
  const days = Number(query.days) || 30;
  const r = await api(`/api/admin/reports${qs({ days })}`);
  const parts = [['filamentCents', t('price.filament')], ['taxCents', t('price.tax')], ['shippingCents', t('price.shipping')], ['feeCents', a('fee')]];
  const splitTotal = parts.reduce((s, [k]) => s + r.split[k], 0) || 1;
  const matMax = Math.max(1, ...r.materials.map((m) => m.grams));
  main.innerHTML = String(html`${head(a('reports'), html`<select class="input" data-days style="width:auto" aria-label="${a('period')}">${[7, 30, 90, 365].map((n) => html`<option value="${n}" ${n === days ? raw('selected') : ''}>${a('last', { n })}</option>`)}</select>`)}
    <div class="kpis">
      <div class="kpi"><span>${a('gross')}</span><b>${usd(r.totals.grossCents)}</b></div>
      <div class="kpi"><span>${a('net')}</span><b>${usd(r.totals.netCents)}</b></div>
      <div class="kpi"><span>${a('ordersCount')}</span><b>${num(r.totals.orders)}</b></div>
      <div class="kpi"><span>${a('aov')}</span><b>${usd(r.totals.avgOrderCents)}</b><span class="tiny">${num(r.printHours, 1)} ${a('printHours')}</span></div>
    </div>
    <section class="panel"><h2 style="font-size:17px;margin-bottom:10px">${a('revenueDay')}</h2><div style="position:relative" data-chart>${raw(revenueChart(r.byDay))}<div class="toast" data-tip hidden style="position:absolute;pointer-events:none;animation:none;padding:6px 10px;font-size:13px"></div></div></section>
    <div class="cols-2" style="margin-top:16px">
      <section class="panel"><h2 style="font-size:17px;margin-bottom:12px">${a('split')}</h2>
        <div class="split-bar" role="img" aria-label="${a('split')}">${parts.map(([k], i) => html`<i style="width:${(r.split[k] / splitTotal) * 100}%;background:${SPLIT_COLORS[i]}" title="${usd(r.split[k])}"></i>`)}</div>
        <table class="t" style="margin-top:12px"><tbody>${parts.map(([k, label], i) => html`<tr><td><i class="dot" style="background:${SPLIT_COLORS[i]};border-radius:2px"></i>${label}</td><td class="num">${usd(r.split[k])}</td><td class="num muted">${num((r.split[k] / splitTotal) * 100, 1)}%</td></tr>`)}
          ${r.split.refundedCents ? html`<tr><td>${a('refunded')}</td><td class="num">−${usd(r.split.refundedCents)}</td><td></td></tr>` : ''}</tbody></table>
      </section>
      <section class="panel"><h2 style="font-size:17px;margin-bottom:12px">${a('materialUse')}</h2>
        <div style="display:grid;gap:10px">${r.materials.map((m) => html`<div><div style="display:flex;justify-content:space-between;font-size:14px"><span>${m.material}</span><span class="num">${num(m.grams / 1000, 2)} kg</span></div>
          <div style="height:10px;background:#F2F3F1;border-radius:4px;margin-top:4px"><div style="height:100%;width:${(m.grams / matMax) * 100}%;background:#2a78d6;border-start-end-radius:4px;border-end-end-radius:4px"></div></div></div>`)}</div>
        <h3 style="font-size:15px;margin:16px 0 8px">${a('aiShare')}</h3>
        <table class="t"><tbody>${r.kinds.map((k) => html`<tr><td>${k.kind === 'design' ? t('cart.aiDesign') : a('products')}</td><td class="num">${num(k.qty)}</td><td class="num">${usd(k.filament_cents)}</td></tr>`)}</tbody></table>
      </section>
    </div>
    <div class="cols-2" style="margin-top:16px">
      <section class="panel"><h2 style="font-size:17px;margin-bottom:10px">${a('topProducts')}</h2>
        <table class="t"><thead><tr><th>${a('name')}</th><th class="num">${a('qty')}</th><th class="num">${t('price.filament')}</th></tr></thead><tbody>${r.topProducts.map((p) => html`<tr><td>${tr({ en: p.title_en, ar: p.title_ar })}</td><td class="num">${num(p.qty)}</td><td class="num">${usd(p.filament_cents)}</td></tr>`)}</tbody></table></section>
      <section class="panel"><h2 style="font-size:17px;margin-bottom:10px">${a('byCountry')}</h2>
        <table class="t"><thead><tr><th>${t('addr.country')}</th><th class="num">${a('orders')}</th><th class="num">${a('total')}</th></tr></thead><tbody>${r.countries.map((c) => html`<tr><td>${countryName(c.country)}</td><td class="num">${num(c.orders)}</td><td class="num">${usd(c.cents)}</td></tr>`)}</tbody></table></section>
    </div>`);
  main.querySelector('[data-days]').addEventListener('change', (e) => navigate(`/admin/reports${qs({ days: e.target.value })}`));
  const chart = main.querySelector('[data-chart]');
  const tip = chart.querySelector('[data-tip]');
  chart.querySelectorAll('.bar').forEach((g) => {
    g.addEventListener('mouseenter', () => { tip.textContent = g.dataset.tip; tip.hidden = false; });
    g.addEventListener('mousemove', (e) => {
      const box = chart.getBoundingClientRect();
      tip.style.left = `${Math.min(box.width - 220, Math.max(0, e.clientX - box.left - 100))}px`;
      tip.style.top = `${e.clientY - box.top - 44}px`;
    });
    g.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
}

// Settings -----------------------------------------------------------------------------------------------
async function settings(main) {
  const s = await api('/api/admin/settings');
  main.innerHTML = String(html`${head(a('settings'))}
    <form data-f style="display:grid;gap:16px;max-width:760px">
      <section class="panel form-grid"><h2 class="full" style="font-size:19px">${a('aiTitle')}</h2>
        <p class="small muted full" style="margin:0">${a('keysCloud')}</p>
        <label class="field">${a('provider')}<select class="input" name="ai_provider"><option value="auto" ${s.ai_provider === 'auto' ? raw('selected') : ''}>${a('autoProvider')}</option>${['tripo', 'meshy'].map((p) => html`<option value="${p}" ${p === s.ai_provider ? raw('selected') : ''}>${p === 'tripo' ? 'Tripo' : 'Meshy'}</option>`)}</select></label>
        <label class="field">${a('hourly')}<input class="input" type="number" name="ai_hourly_limit" value="${s.ai_hourly_limit}"></label>
        <label class="field">${a('defaultSize')}<input class="input" type="number" name="ai_default_size_mm" value="${s.ai_default_size_mm}"></label>
      </section>
      <section class="panel form-grid"><h2 class="full" style="font-size:19px">${a('payTitle')}</h2>
        <label class="field full">${a('payProvider')}<select class="input" name="payment_provider"><option value="tap" ${s.payment_provider === 'tap' ? raw('selected') : ''}>Tap Payments (international cards)</option></select></label>
        <p class="small muted full" style="margin:0">${a('tapHelp')}</p>
      </section>
      <section class="panel form-grid"><h2 class="full" style="font-size:19px">${a('currencyTitle')}</h2>
        <p class="small muted full" style="margin:0">${a('currencyHelp')}</p>
        <div class="full table-wrap"><table class="t"><thead><tr><th>${a('code')}</th><th>${a('rateCol')}</th><th>${a('decimalsCol')}</th><th></th></tr></thead><tbody data-cur>
          ${s.currencies.map((c) => html`<tr><td><input class="input" data-cc value="${c.code}" maxlength="3" style="width:80px" ${c.code === 'SAR' ? raw('readonly') : ''}></td><td><input class="input" data-cr type="number" step="0.0001" value="${c.rate}" ${c.code === 'SAR' ? raw('readonly') : ''}></td><td><input class="input" data-cd type="number" min="0" max="3" value="${c.decimals}" style="width:70px"></td><td>${c.code === 'SAR' ? '' : html`<button type="button" class="btn btn-sm" data-rmcur>×</button>`}</td></tr>`)}
        </tbody></table></div>
        <div class="full row-actions"><button type="button" class="btn btn-sm" data-addcur>${a('addCurrency')}</button></div>
        <label class="field">${a('fallbackCurrency')}<input class="input" name="fallback_currency" value="${s.fallback_currency}" maxlength="3"></label>
      </section>
      <section class="panel form-grid"><h2 class="full" style="font-size:19px">${a('durability')}</h2>
        <label class="field">${a('minWall')}<input class="input" type="number" step="0.1" name="min_wall_mm" value="${s.min_wall_mm}"></label>
        <label class="field">${a('maxModel')}<input class="input" type="number" name="max_model_mm" value="${s.max_model_mm}"></label>
        <div class="field full">${a('infillRange')}<div style="display:flex;gap:8px"><input class="input" type="number" name="infill_lo" value="${s.infill_range[0]}"><input class="input" type="number" name="infill_hi" value="${s.infill_range[1]}"></div></div>
      </section>
      <section class="panel form-grid"><h2 class="full" style="font-size:19px">${a('agentTitle')}</h2>
        <p class="small muted full" style="margin:0">${a('agentHelp')}</p>
      </section>
      <div><button class="btn btn-primary">${a('save')}</button></div>
    </form>`);
  main.querySelector('[data-addcur]').addEventListener('click', () => {
    main.querySelector('[data-cur]').insertAdjacentHTML('beforeend', String(html`<tr><td><input class="input" data-cc value="" maxlength="3" style="width:80px" placeholder="USD"></td><td><input class="input" data-cr type="number" step="0.0001" value="0.2667"></td><td><input class="input" data-cd type="number" min="0" max="3" value="2" style="width:70px"></td><td><button type="button" class="btn btn-sm" data-rmcur>×</button></td></tr>`));
  });
  main.querySelector('[data-cur]').addEventListener('click', (e) => { if (e.target.closest('[data-rmcur]')) e.target.closest('tr').remove(); });
  main.querySelector('[data-f]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = formData(e.target);
    f.infill_range = [Number(f.infill_lo), Number(f.infill_hi)]; delete f.infill_lo; delete f.infill_hi;
    f.currencies = [...main.querySelectorAll('[data-cur] tr')].map((tr) => ({ code: tr.querySelector('[data-cc]').value, rate: Number(tr.querySelector('[data-cr]').value), decimals: Number(tr.querySelector('[data-cd]').value) }));
    await tryDo(() => api('/api/admin/settings', { method: 'PUT', body: f }), a('saved'));
    settings(main);
  });
}
