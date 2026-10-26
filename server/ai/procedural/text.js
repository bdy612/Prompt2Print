// Prompt parsing (English + Arabic) and natural titles/descriptions for the demo generator.

const AR_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(AR_MARKS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٫,](?=\d)/g, '.');
}

const AR_PREFIXES = ['وبال', 'وال', 'بال', 'كال', 'فال', 'لل', 'ال', 'و', 'ب', 'ك', 'ل', 'ف'];
const isArabic = (s) => /[؀-ۿ]/.test(s);

function tokenVariants(tok) {
  const out = new Set([tok]);
  if (isArabic(tok)) {
    for (const p of AR_PREFIXES) {
      if (tok.startsWith(p) && tok.length - p.length >= 2) {
        const rest = tok.slice(p.length);
        out.add(rest);
        // a second prefix layer, e.g. "وبال" handled above, "بال"+"..." etc.
        if (rest.startsWith('ال') && rest.length > 3) out.add(rest.slice(2));
      }
    }
  }
  return [...out];
}

// Keyword table. Arabic entries are written plainly and normalised at load time.
const KEYWORDS = {
  // objects
  chess: { en: ['chess', 'chessboard'], ar: ['شطرنج'] },
  pawn: { en: ['pawn'], ar: ['بيدق', 'بيادق'] },
  pawnAr: { en: [], ar: ['جندي'] },
  rook: { en: ['rook'], ar: ['طابية', 'رخ'] },
  knight: { en: ['knight', 'horse'], ar: ['حصان'] },
  bishop: { en: ['bishop'], ar: ['فيل'] },
  queen: { en: ['queen'], ar: ['وزير', 'ملكة'] },
  king: { en: ['king'], ar: ['ملك', 'شاه'] },
  set: { en: ['set', 'full set', 'pieces'], ar: ['طقم', 'مجموعة'] },
  piece: { en: ['piece'], ar: ['قطعة'] },
  keychain: { en: ['keychain', 'key chain', 'keyring', 'key ring', 'key tag', 'tag', 'charm', 'key fob'], ar: ['ميدالية', 'ميداليه', 'سلسلة مفاتيح', 'تعليقة مفاتيح'] },
  phoneStand: { en: ['phone stand', 'phone holder', 'mobile stand', 'tablet stand', 'phone dock'], ar: ['حامل جوال', 'حامل موبايل', 'حامل هاتف', 'ستاند جوال', 'حامل تلفون', 'حامل ايباد'] },
  headphoneStand: { en: ['headphone stand', 'headphones stand', 'headset stand', 'headphone holder', 'headset holder', 'headphone hanger'], ar: ['حامل سماعات', 'حامل سماعة', 'ستاند سماعات', 'حامل هيدفون'] },
  hook: { en: ['hook', 'hooks', 'key holder', 'key rack', 'wall holder', 'wall mount', 'coat hook', 'hanger'], ar: ['علاقة', 'علاقه', 'شماعة', 'شماعه', 'خطاف', 'حامل مفاتيح', 'معلاق'] },
  cable: { en: ['cable organizer', 'cable organiser', 'cable holder', 'cable clip', 'cable management', 'cord organizer', 'wire organizer', 'cable tidy'], ar: ['منظم كابلات', 'منظم اسلاك', 'حامل كابلات', 'منظم كوابل', 'مثبت كابلات'] },
  bookend: { en: ['bookend', 'bookends', 'book end', 'book stand', 'book holder'], ar: ['حامل كتب', 'مسند كتب', 'سند كتب', 'دعامة كتب'] },
  dice: { en: ['dice', 'die', 'd6', 'cube die'], ar: ['نرد', 'زهر', 'حجر نرد', 'زار'] },
  owl: { en: ['owl', 'owlet'], ar: ['بومة', 'بومه', 'بوم'] },
  cat: { en: ['cat', 'kitten', 'kitty'], ar: ['قطة', 'قطه', 'قط', 'بسة', 'بسه', 'هرة'] },
  figurine: { en: ['figurine', 'figure', 'statue', 'statuette', 'toy'], ar: ['مجسم', 'تمثال', 'دمية', 'لعبة'] },
  trinket: { en: ['trinket', 'jewellery', 'jewelry', 'ring box', 'gift box', 'keepsake'], ar: ['مجوهرات', 'حلي', 'علبة هدايا', 'علبة خواتم'] },
  penHolder: { en: ['pen holder', 'pencil holder', 'pencil cup', 'pen cup', 'desk tidy', 'pen pot', 'pencil pot', 'brush holder', 'pen stand'], ar: ['حامل اقلام', 'مقلمة', 'حامل الاقلام', 'حامل فرش', 'حافظة اقلام'] },
  organizer: { en: ['organizer', 'organiser', 'box', 'storage', 'container', 'tray', 'case', 'bin', 'caddy'], ar: ['صندوق', 'منظم', 'علبة', 'علبه', 'صينية', 'درج', 'حافظة'] },
  lid: { en: ['lid', 'cover'], ar: ['غطاء', 'بغطاء'] },
  lamp: { en: ['lamp', 'lampshade', 'lamp shade', 'shade', 'light', 'pendant'], ar: ['مصباح', 'اباجورة', 'ابجورة', 'ثريا', 'ابجوره', 'اباجوره', 'غطاء مصباح', 'اضاءة', 'لمبة', 'فانوس'] },
  trophy: { en: ['trophy', 'award', 'prize', 'medal stand'], ar: ['جائزة', 'درع', 'كاس البطولة', 'كأس بطولة', 'كاس بطولة'] },
  planter: { en: ['planter', 'plant pot', 'flower pot', 'flowerpot', 'pot', 'succulent', 'cactus'], ar: ['اصيص', 'اصص', 'حوض زرع', 'حوض زراعة', 'قصرية', 'مزروعات', 'نبتة', 'نبات', 'صبار', 'زرع'] },
  vase: { en: ['vase', 'jar', 'urn', 'amphora', 'vessel'], ar: ['مزهرية', 'مزهريات', 'فازة', 'فازه', 'جرة', 'زهرية', 'قارورة', 'مبخرة'] },
  ornament: { en: ['ornament', 'bauble', 'christmas', 'decoration', 'pendant ornament'], ar: ['زينة', 'زينه', 'تعليقة', 'كرة زينة'] },
  rocket: { en: ['rocket', 'spaceship', 'space ship'], ar: ['صاروخ', 'مركبة فضائية', 'سفينة فضاء'] },
  castle: { en: ['castle', 'fortress', 'fort', 'citadel', 'battlement', 'crenellated'], ar: ['قلعة', 'حصن', 'قلاع'] },
  tower: { en: ['tower', 'turret'], ar: ['برج', 'ابراج'] },
  dragon: { en: ['dragon', 'dragons', 'wyvern'], ar: ['تنين', 'التنين', 'تنانين'] },
  egg: { en: ['egg'], ar: ['بيضة', 'بيضه'] },
  sculpture: { en: ['sculpture', 'abstract', 'organic', 'art piece', 'art'], ar: ['منحوتة', 'تجريدي', 'عضوي', 'قطعة فنية'] },
  handle: { en: ['handle', 'handles'], ar: ['مقبض', 'يد', 'ايد', 'ممسك', 'عروة'] },
  // styles
  twisted: { en: ['twisted', 'twist', 'twisting', 'swirl', 'swirled'], ar: ['ملتوي', 'ملتو', 'ملفوف', 'مبروم', 'التواء'] },
  spiral: { en: ['spiral', 'helix', 'helical'], ar: ['حلزوني', 'حلزون', 'لولبي'] },
  faceted: { en: ['faceted', 'low poly', 'lowpoly', 'low-poly', 'geometric', 'polygon', 'polygonal', 'angular', 'crystal', 'gem'], ar: ['مضلع', 'هندسي', 'كريستال', 'زوايا'] },
  star: { en: ['star', 'starry', 'stars'], ar: ['نجمة', 'نجمه', 'نجوم', 'نجمي'] },
  flower: { en: ['flower', 'petal', 'petals', 'floral', 'lotus', 'tulip', 'rose'], ar: ['زهرة', 'زهره', 'وردة', 'ورده', 'بتلات', 'لوتس', 'زهري'] },
  wavy: { en: ['wavy', 'wave', 'waves', 'ripple', 'rippled', 'fluted', 'ribbed', 'ocean'], ar: ['موج', 'امواج', 'متموج', 'مموج', 'مضلع طولي', 'بحر'] },
  gear: { en: ['gear', 'cog', 'cogwheel', 'steampunk', 'mechanical'], ar: ['ترس', 'تروس', 'مسنن'] },
  hexagon: { en: ['hexagon', 'hexagonal', 'hex', 'honeycomb', 'beehive', 'bee'], ar: ['سداسي', 'خلية', 'خلايا', 'شمع العسل', 'نحل', 'مسدس'] },
  heart: { en: ['heart', 'love', 'hearts'], ar: ['قلب', 'حب', 'قلوب'] },
  circle: { en: ['circle', 'round', 'disc'], ar: ['دائرة', 'دائري', 'مدور'] },
  shield: { en: ['shield', 'badge', 'crest'], ar: ['شعار', 'ترس حماية', 'درع حماية'] },
  sitting: { en: ['sitting', 'seated'], ar: ['جالس', 'جالسة', 'قاعد'] },
  // sizes
  tall: { en: ['tall', 'taller', 'slender', 'slim'], ar: ['طويل', 'طويلة', 'عالي', 'عالية', 'رفيع', 'نحيف'] },
  short: { en: ['short', 'squat', 'stubby'], ar: ['قصير', 'قصيرة', 'منخفض'] },
  wide: { en: ['wide', 'broad', 'fat', 'chunky'], ar: ['عريض', 'عريضة', 'واسع', 'واسعة', 'سمين'] },
  small: { en: ['small', 'little', 'mini', 'tiny', 'miniature'], ar: ['صغير', 'صغيرة', 'ميني', 'مصغر', 'صغيره'] },
  large: { en: ['large', 'big', 'huge', 'giant', 'oversized', 'xl'], ar: ['كبير', 'كبيرة', 'ضخم', 'ضخمة', 'عملاق', 'كبيره'] },
};

const NORMALIZED = Object.fromEntries(
  Object.entries(KEYWORDS).map(([k, v]) => [k, [...v.en.map(normalize), ...v.ar.map(normalize)]]),
);

function matchKeyword(text, tokens, kw) {
  if (kw.includes(' ')) return text.includes(kw);
  if (isArabic(kw)) {
    for (const tok of tokens) {
      for (const v of tokenVariants(tok)) {
        if (v === kw) return true;
        if (kw.length >= 3 && v.startsWith(kw) && v.length <= kw.length + 2) return true;
      }
    }
    return false;
  }
  for (const tok of tokens) {
    if (tok === kw || tok === kw + 's' || tok === kw + 'es') return true;
    if (kw.length >= 5 && tok.startsWith(kw) && tok.length <= kw.length + 3) return true;
  }
  return false;
}

export function parsePrompt(prompt) {
  const text = normalize(prompt).replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = text.split(/[^a-z0-9؀-ۿ]+/).filter(Boolean);
  const found = new Set();
  for (const [key, list] of Object.entries(NORMALIZED)) {
    if (list.some((kw) => matchKeyword(text, tokens, kw))) found.add(key);
  }
  // Size in the prompt: "15 cm tall", "120mm", "١٥ سم"
  let targetMm = null;
  const m = text.match(/(\d+(?:\.\d+)?)\s*(mm|millimet\w*|cm|centimet\w*|ملم|مم|مليمتر|ملليمتر|سم|سنتيمتر|سنتي|inch|inches|in\b|")/);
  if (m) {
    const v = parseFloat(m[1]);
    const unit = m[2];
    if (/^(cm|centimet|سم|سنتي)/.test(unit)) targetMm = v * 10;
    else if (/^(inch|in|")/.test(unit)) targetMm = v * 25.4;
    else targetMm = v;
    if (!(targetMm >= 15 && targetMm <= 300)) targetMm = targetMm ? Math.min(300, Math.max(15, targetMm)) : null;
  }
  return { text, tokens, found, has: (k) => found.has(k), targetMm, arabic: isArabic(text) };
}

// ---------- titles & descriptions ----------

export const NOUNS = {
  vase: { en: 'vase', ar: 'مزهرية', g: 'f' },
  planter: { en: 'planter', ar: 'أصيص زرع', g: 'm' },
  pen_holder: { en: 'pen holder', ar: 'حامل أقلام', g: 'm' },
  lamp: { en: 'lamp shade', ar: 'غطاء مصباح', g: 'm' },
  trophy: { en: 'trophy', ar: 'كأس جائزة', g: 'm' },
  keychain: { en: 'keychain', ar: 'ميدالية مفاتيح', g: 'f' },
  phone_stand: { en: 'phone stand', ar: 'حامل جوال', g: 'm' },
  headphone_stand: { en: 'headphone stand', ar: 'حامل سماعات', g: 'm' },
  hook: { en: 'wall key holder', ar: 'علاقة مفاتيح جدارية', g: 'f' },
  cable: { en: 'cable organizer', ar: 'منظم كابلات', g: 'm' },
  bookend: { en: 'bookend', ar: 'مسند كتب', g: 'm' },
  dice: { en: 'six-sided die', ar: 'حجر نرد', g: 'm' },
  owl: { en: 'owl figurine', ar: 'مجسم بومة', g: 'm' },
  cat: { en: 'cat figurine', ar: 'مجسم قطة', g: 'm' },
  organizer: { en: 'desk organizer', ar: 'منظم مكتب', g: 'm' },
  box_lid: { en: 'trinket box with lid', ar: 'علبة بغطاء', g: 'f' },
  ornament: { en: 'ornament', ar: 'زينة معلقة', g: 'f' },
  rocket: { en: 'rocket', ar: 'صاروخ', g: 'm' },
  castle: { en: 'castle', ar: 'قلعة', g: 'f' },
  tower: { en: 'castle tower', ar: 'برج قلعة', g: 'm' },
  dragon_egg: { en: 'dragon egg', ar: 'بيضة تنين', g: 'f' },
  sculpture: { en: 'abstract sculpture', ar: 'منحوتة تجريدية', g: 'f' },
  pawn: { en: 'chess pawn', ar: 'بيدق شطرنج', g: 'm' },
  rook: { en: 'chess rook', ar: 'طابية شطرنج', g: 'f' },
  knight: { en: 'chess knight', ar: 'حصان شطرنج', g: 'm' },
  bishop: { en: 'chess bishop', ar: 'فيل شطرنج', g: 'm' },
  queen: { en: 'chess queen', ar: 'وزير شطرنج', g: 'm' },
  king: { en: 'chess king', ar: 'ملك شطرنج', g: 'm' },
  chess_set: { en: 'chess set', ar: 'طقم شطرنج', g: 'm' },
};

const SIZE_WORDS = {
  tall: { en: 'Tall', ar: { m: 'طويل', f: 'طويلة' } },
  short: { en: 'Short', ar: { m: 'قصير', f: 'قصيرة' } },
  wide: { en: 'Wide', ar: { m: 'عريض', f: 'عريضة' } },
  small: { en: 'Mini', ar: { m: 'صغير', f: 'صغيرة' } },
  large: { en: 'Large', ar: { m: 'كبير', f: 'كبيرة' } },
};

const STYLE_WORDS = {
  twisted: { en: 'Twisted', ar: 'ملتوٍ', feat: ['a twisted body', 'جسم ملتوٍ'] },
  spiral: { en: 'Spiral', ar: 'حلزوني', feat: ['a spiral twist', 'التفاف حلزوني'] },
  faceted: { en: 'Faceted', ar: 'مضلع', feat: ['crisp low-poly facets', 'أوجه هندسية حادة'] },
  star: { en: 'Star', ar: 'نجمي', feat: ['a star-shaped outline', 'مقطع على شكل نجمة'] },
  flower: { en: 'Petal', ar: 'زهري', feat: ['soft petal-like lobes', 'بتلات ناعمة'] },
  wavy: { en: 'Wavy', ar: 'متموج', feat: ['flowing ribs', 'تموجات انسيابية'] },
  gear: { en: 'Gear', ar: 'ترسي', feat: ['gear-tooth ridges', 'حواف مسننة كالتروس'] },
  hexagon: { en: 'Hexagonal', ar: 'سداسي', feat: ['a hexagonal honeycomb form', 'شكل سداسي كخلية النحل'] },
  castle: { en: 'Castle', ar: 'قلعة', feat: ['a rounded crenellated rim', 'حافة بشرفات قلعة مستديرة'] },
  tower: { en: 'Tower', ar: 'برج', feat: ['a stone-tower silhouette', 'هيئة برج حجري'] },
  dragon: { en: 'Dragon', ar: 'تنين', feat: ['a dragon-scale texture', 'ملمس حراشف التنين'] },
};

export function composeTitle(nounKey, sizes, styles, extra = {}) {
  const noun = NOUNS[nounKey];
  const sizeKey = sizes[0];
  const enParts = [];
  if (sizeKey) enParts.push(SIZE_WORDS[sizeKey].en);
  for (const s of styles) enParts.push(STYLE_WORDS[s].en);
  let en = [...enParts, noun.en].join(' ');
  if (extra.dragonHandle) en += ' with dragon handle';
  else if (extra.handle) en += ' with handle';
  en = en.charAt(0).toUpperCase() + en.slice(1).toLowerCase();

  let ar = noun.ar;
  if (sizeKey) ar += ' ' + SIZE_WORDS[sizeKey].ar[noun.g];
  if (extra.castleShape) ar += ' على شكل قلعة';
  const arStyles = styles.filter((s) => !(extra.castleShape && s === 'castle'));
  if (arStyles.length) ar += ' بتصميم ' + arStyles.map((s) => STYLE_WORDS[s].ar).join('، ');
  if (extra.dragonHandle) ar += ' بمقبض تنين';
  else if (extra.handle) ar += ' بمقبض';
  return { en, ar };
}

export function featureList(styles, extra = {}) {
  const en = [], ar = [];
  for (const s of styles) {
    if (s === 'dragon' && extra.dragonHandle) continue;
    en.push(STYLE_WORDS[s].feat[0]); ar.push(STYLE_WORDS[s].feat[1]);
  }
  if (extra.dragonHandle) { en.push('a sturdy dragon handle with rounded scales'); ar.push('مقبض تنين متين بحراشف مستديرة'); }
  if (extra.features) for (const [e, a] of extra.features) { en.push(e); ar.push(a); }
  return { en, ar };
}

export function joinList(items, lang) {
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  if (lang === 'ar') return items.slice(0, -1).join('، ') + ' و' + items[items.length - 1];
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}
