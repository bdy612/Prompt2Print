// Prompt rules: no weapons, nothing for food or drink. English and Arabic.
import { bad } from './http.js';

const BLOCKED = [
  /\b(gun|guns|pistol|revolver|rifle|shotgun|firearm|handgun|ar-?15|ak-?47|glock|receiver|suppressor|silencer|ammo|ammunition|bullet|cartridge|grenade|bomb|explosive|switchblade|brass knuckles?|knuckle duster|taser|ghost gun)\b/i,
  /(مسدس|بندقية|سلاح|أسلحة|اسلحة|رصاص|ذخيرة|كاتم صوت|قنبلة|متفجر|كلاشنكوف|سكين قتال)/,
];
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
export const isFoodPrompt = (prompt) => FOOD.some((rx) => rx.test(prompt));
export function checkPromptPolicy(prompt, locale = 'en') {
  if (BLOCKED.some((rx) => rx.test(prompt))) {
    throw bad(locale === 'ar' ? 'لا نطبع الأسلحة أو أجزاءها أو أي شيء مصمم لإيذاء الناس. جرّب وصف شيء آخر.' : "We don't print weapons, weapon parts or anything designed to hurt people. Try describing a different object.", 'blocked_prompt');
  }
  if (isFoodPrompt(prompt)) throw bad(FOOD_MESSAGE[locale === 'ar' ? 'ar' : 'en'], 'food_prompt');
}
export const DURABILITY_HINT = 'single solid 3D-printable object, thick rounded walls at least 2 mm, rounded edges and corners, no thin spikes or long thin fragile parts, flat stable base, compact shape, no overhangs';
export function sizeHintMm(prompt) {
  const western = prompt.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const m = western.match(/(\d+(?:[.,]\d+)?)\s*(mm|cm|millimet(?:er|re)s?|centimet(?:er|re)s?|ملم|مم|سم|سنتيمتر)/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  const unit = m[2].toLowerCase();
  const mm = /^(cm|centi|سم|سنتي)/.test(unit) ? n * 10 : n;
  return mm >= 10 ? Math.min(mm, 250) : null;
}
