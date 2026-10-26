// AI Create: turning a customer's prompt into a private, printable model.

import crypto from 'node:crypto';
import { all, get, run, getSetting } from './db.js';
import { providers, activeProvider } from './ai/providers.js';
import { processModel, storeProcessedModel } from './models.js';
import { bad, HttpError } from './lib/http.js';
import { config } from './config.js';

// Things we will not print, in English and Arabic.
const BLOCKED = [
  /\b(gun|guns|pistol|revolver|rifle|shotgun|firearm|handgun|ar-?15|ak-?47|glock|receiver|suppressor|silencer|ammo|ammunition|bullet|cartridge|grenade|bomb|explosive|switchblade|brass knuckles?|knuckle duster|taser|ghost gun)\b/i,
  /(مسدس|بندقية|سلاح|أسلحة|اسلحة|رصاص|ذخيرة|كاتم صوت|قنبلة|متفجر|كلاشنكوف|سكين قتال)/,
];

// Nothing we print is food-safe: no cups, plates, bottles, utensils, lunch boxes…
const FOOD = [
  /\b(mugs?|cups?|tumblers?|glass(es)?|goblets?|bottles?|flasks?|thermos|canteens?|jugs?|pitchers?|teapots?|kettles?|carafes?|decanters?|shot ?glass|wine ?glass|beer ?stein|straws?)\b/i,
  /\b(plates?|dish(es)?|bowls?|saucers?|platters?|trays? for food|serving trays?|lunch ?box(es)?|bento|food containers?|tupperware|jars? for food|cookie jars?|candy dish|snack bowl|fruit bowl|salad bowl|cereal bowl)\b/i,
  /\b(spoons?|forks?|knives?|knife|chopsticks?|cutlery|utensils?|spatulas?|ladles?|whisks?|tongs|measuring (cups?|spoons?)|cookie cutters?|cake molds?|chocolate molds?|ice cube trays?|pop(sicle)? molds?|rolling pins?|pizza cutters?|cutting boards?|chopping boards?|egg cups?)\b/i,
  /\b(baby bottles?|pacifiers?|dummy|teethers?|sippy cups?|nipples?|feeding (bottles?|spoons?))\b/i,
  /\b(for (food|drinks?|drinking|eating|coffee|tea|juice|milk|water)|food[- ]safe|dishwasher|microwave|oven)\b/i,
  /(كوب|أكواب|اكواب|فنجان|فناجين|مج|كأس|كاس|زجاجة|قارورة|ترمس|إبريق|ابريق|براد|غلاية|شفاط)/,
  /(صحن|صحون|طبق|أطباق|اطباق|وعاء|أوعية|اوعية|سلطانية|زبدية|صينية طعام|علبة طعام|علبة غداء|لانش بوكس|حافظة طعام|برطمان|مرطبان)/,
  /(ملعقة|ملاعق|شوكة|شوك|سكين|سكاكين|عيدان|أدوات مائدة|ادوات مائدة|مغرفة|قالب كيك|قالب شوكولاتة|قالب ثلج|قطاعة بسكويت|لوح تقطيع)/,
  /(رضاعة|لهاية|عضاضة|للطعام|للأكل|للاكل|للشرب|للقهوة|للشاي|للعصير|للحليب|للماء|ميكروويف|مايكروويف|فرن|غسالة صحون|غسالة أطباق)/,
];

export const FOOD_MESSAGE = {
  en: "We can't make items for food or drink. Nothing we print is food-safe: printed plastic has tiny gaps that trap bacteria, and ABS/ASA must never touch food, go in the mouth, or be microwaved or dishwashed. Try a planter, pen holder, vase for dried flowers, organizer or a figurine instead.",
  ar: 'لا نصنع أي شيء للطعام أو الشراب. القطع المطبوعة ليست آمنة للطعام: البلاستيك المطبوع فيه فجوات دقيقة تحبس البكتيريا، وخامات ABS/ASA لا يجوز أن تلامس الطعام أو الفم أو تدخل الميكروويف أو غسالة الصحون. جرّب أصيصاً، حامل أقلام، مزهرية للزهور المجففة، منظّماً أو مجسّماً.',
};

export function isFoodPrompt(prompt) {
  return FOOD.some((rx) => rx.test(prompt));
}

export function checkPromptPolicy(prompt, locale = 'en') {
  if (BLOCKED.some((rx) => rx.test(prompt))) {
    throw bad("We don't print weapons, weapon parts or anything designed to hurt people. Try describing a different object.", 'blocked_prompt');
  }
  if (isFoodPrompt(prompt)) throw bad(FOOD_MESSAGE[locale === 'ar' ? 'ar' : 'en'], 'food_prompt');
}

// What every AI service is told, so generated shapes survive drops and print fast.
export const DURABILITY_HINT = 'single solid 3D-printable object, thick rounded walls at least 2 mm, rounded edges and corners, no thin spikes or long thin fragile parts, flat stable base, compact shape, no overhangs';

// "10 cm", "120mm", "١٠ سم" → largest dimension in mm.
export function sizeHintMm(prompt) {
  const western = prompt.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const m = western.match(/(\d+(?:[.,]\d+)?)\s*(mm|cm|millimet(?:er|re)s?|centimet(?:er|re)s?|ملم|مم|سم|سنتيمتر)/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  const unit = m[2].toLowerCase();
  const mm = /^(cm|centi|سم|سنتي)/.test(unit) ? n * 10 : n;
  return mm >= 10 ? Math.min(mm, 250) : null; // never bigger than the printer allows
}

export const clientIp = (req) => String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');

// Limits per account/visitor and per network address (a new guest cookie doesn't reset it).
function rateLimit(req) {
  const limit = Number(getSetting('ai_hourly_limit', 30));
  const ipLimit = Number(getSetting('ai_ip_hourly_limit', limit * 3));
  const row = req.user
    ? get("SELECT COUNT(*) AS n FROM designs WHERE user_id = ? AND created_at > datetime('now', '-1 hour')", req.user.id)
    : get("SELECT COUNT(*) AS n FROM designs WHERE guest_key = ? AND created_at > datetime('now', '-1 hour')", req.guestKey);
  const byIp = get("SELECT COUNT(*) AS n FROM designs WHERE ip = ? AND created_at > datetime('now', '-1 hour')", clientIp(req));
  if (row.n >= limit || byIp.n >= ipLimit) {
    throw new HttpError(429, `You can create up to ${limit} designs per hour. Please try again a bit later.`, 'rate_limited');
  }
  const waiting = get("SELECT COUNT(*) AS n FROM designs WHERE status = 'generating'").n;
  if (waiting >= Number(getSetting('ai_max_waiting', 40))) {
    throw new HttpError(429, 'AI Create is very busy right now. Please try again in a few minutes.', 'busy');
  }
}

// At most a few generations at a time; the rest wait their turn.
let active = 0;
const waitingQueue = [];
async function withSlot(fn) {
  const max = Math.max(1, Number(getSetting('ai_concurrency', 2)));
  if (active >= max) await new Promise((resolve) => waitingQueue.push(resolve));
  active++;
  try { return await fn(); } finally {
    active--;
    waitingQueue.shift()?.();
  }
}

export function createDesign(req, { prompt, parentId = null, seed = null, locale = 'en' }) {
  if (typeof prompt !== 'string') throw bad('Describe the object you want in a few words.', 'prompt_too_short');
  prompt = prompt.trim().replace(/\s+/g, ' ');
  if (prompt.length < 3) throw bad('Describe the object you want in a few words.', 'prompt_too_short');
  if (prompt.length > 600) throw bad('Please keep the description under 600 characters.', 'prompt_too_long');
  checkPromptPolicy(prompt, locale);
  rateLimit(req);
  const provider = activeProvider();
  const id = crypto.randomUUID();
  const s = Number.isInteger(seed) ? seed : crypto.randomInt(1, 1e9);
  run(`INSERT INTO designs(id, user_id, guest_key, parent_id, prompt, seed, provider, status, progress, ip)
       VALUES(?, ?, ?, ?, ?, ?, ?, 'generating', 5, ?)`,
  [id, req.user?.id ?? null, req.user ? null : req.guestKey, parentId, prompt, s, provider.id, clientIp(req)]);
  runGeneration(id);
  return id;
}

export function runGeneration(id) {
  return withSlot(() => generate(id));
}

async function generate(id) {
  const d = get('SELECT * FROM designs WHERE id = ?', id);
  if (!d) return;
  const provider = providers[d.provider] || providers.demo;
  const update = (fields) => {
    const keys = Object.keys(fields);
    run(`UPDATE designs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...keys.map((k) => fields[k]), id]);
  };
  try {
    const call = (prov) => prov.generate({
      prompt: prov.id === 'demo' ? d.prompt : `${d.prompt}. ${DURABILITY_HINT}`,
      seed: d.seed,
      onProgress: (p) => update({ progress: Math.max(5, Math.round(p)) }),
      onTask: (taskId) => update({ provider_task_id: String(taskId) }),
    });
    let result;
    try {
      result = await call(provider);
    } catch (err) {
      // Account problems at the AI service (no credits, bad key, service down) shouldn't leave the
      // customer with nothing: the built-in generator makes the model instead and the reason is
      // logged for the shop owner (Admin → Overview shows failed AI calls).
      if (provider.id === 'demo' || !/credit|API key|refused|took too long|fetch failed|ENOTFOUND|ECONN/i.test(err.message)) throw err;
      console.error(`[ai] ${provider.label} unavailable (${err.message}); using the built-in generator for design ${id}`);
      update({ provider: 'demo', error: `${provider.label}: ${err.message.slice(0, 300)}` });
      result = await call(providers.demo);
    }
    // The demo generator already produces clean, closed parts; AI provider meshes get repaired and
    // scaled (to the size in the prompt, or the default size). Done in a background thread.
    const hint = sizeHintMm(d.prompt);
    const processed = await processModel(result.mesh, {
      repair: !result.realSize,
      sizeMm: hint || (result.realSize ? null : Number(getSetting('ai_default_size_mm', 100))),
      maxMm: config.maxModelMm,
      thumb: { width: 480, height: 480, color: '#1E1F22', view: 'hero' },
    });
    const model = storeProcessedModel(processed, { source: 'ai', ownerUserId: d.user_id });
    const thumb = model.thumbUrl;
    const title = d.prompt.length > 60 ? `${d.prompt.slice(0, 57)}…` : d.prompt;
    update({
      status: 'ready',
      progress: 100,
      model_id: model.id,
      thumb,
      title_en: result.titleEn || title.charAt(0).toUpperCase() + title.slice(1),
      title_ar: result.titleAr || title,
      error: null,
    });
  } catch (err) {
    console.error(`[ai] design ${id} failed:`, err.message);
    update({ status: 'failed', error: err.message.slice(0, 400) });
  }
}

// Resume designs that were generating when the app was closed.
export function resumePendingDesigns() {
  for (const d of all("SELECT id FROM designs WHERE status = 'generating'")) runGeneration(d.id);
}
