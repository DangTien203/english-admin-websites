/**
 * The 30 learning topics used to tag dictionary entries (docs/lookup-spec.md §8.1, §9.4).
 *
 * TOPIC_NAMES and TOPIC_DESCRIPTIONS are copied VERBATIM from docs/reference/classify-topics.mjs
 * (generated, do not retype). tests/enrichment/topics.test.ts compares them with the reference file when it exists
 * and with docs/seed-topics.sql, the script that loads the same 30 names into the `tags` table.
 *
 * ONLY these 30 names are used for entry_tags. Every other row of `tags` (the 17 older ones: IELTS, TOEIC,
 * Beginner, ...) is ignored here and is never modified or deleted.
 */
import { EnrichmentConfigError } from './errors';

export const TOPIC_NAMES = [
  "core_language",
  "time_calendar",
  "colors_shapes",
  "greetings_social",
  "family_relationships",
  "body_appearance",
  "emotions_feelings",
  "character_values",
  "food_drink",
  "home_household",
  "clothes_fashion",
  "transport_travel",
  "animals_wildlife",
  "plants_nature",
  "weather_climate",
  "geography_places",
  "education_school",
  "work_career",
  "sports_recreation",
  "arts_entertainment",
  "media_communication",
  "shopping_commerce",
  "technology_digital",
  "science_research",
  "health_medicine",
  "business_economy",
  "politics_law",
  "environment_society",
  "psychology_mind",
  "academic_formal",
] as const;

export type TopicName = (typeof TOPIC_NAMES)[number];

export const TOPIC_DESCRIPTIONS: Record<TopicName, string> = {
  core_language: "grammar words: articles (a/an/the), pronouns, prepositions, conjunctions, auxiliaries, numbers, basic adverbs like \"very/just/also\"",
  time_calendar: "time: days of week, months, years, seasons, morning/afternoon/evening, before/after/during, always/never/sometimes",
  colors_shapes: "colors (red/blue/green), shapes (circle/square), sizes (big/small/tall), textures (smooth/rough), basic physical descriptors",
  greetings_social: "social phrases: hello/goodbye, please/thank you, sorry/excuse me, yes/no, okay/sure, conversation basics",
  family_relationships: "family: mother/father/sibling/aunt/uncle/cousin, relationships: friend/partner/neighbor/colleague",
  body_appearance: "body parts: head/arm/leg/heart/blood, physical appearance: height/weight/hair/skin, looking/feeling physically",
  emotions_feelings: "emotions: happy/sad/angry/afraid/excited/anxious/proud/lonely/jealous, mood, emotional states",
  character_values: "personality: kind/honest/brave/generous/patient/loyal, moral qualities: respect/trust/dignity/fairness/integrity",
  food_drink: "food: apple/bread/meat/fish/vegetable/fruit/cake, drinks: water/coffee/juice/wine, meals: breakfast/lunch/dinner, cooking, nutrition",
  home_household: "home: house/apartment/room/bedroom/kitchen, furniture: bed/chair/table, household: door/window/carpet/garden",
  clothes_fashion: "clothing: shirt/dress/coat/shoes/hat/jacket, fabrics: cotton/silk/wool, fashion: style/trend/outfit",
  transport_travel: "transport: car/bus/train/plane/boat, travel: journey/trip/airport/station/ticket/passport/tourist",
  animals_wildlife: "animals: dog/cat/horse/lion/bird/fish/insect/shark/whale, wildlife, habitat, creature, species, predator/prey",
  plants_nature: "plants: tree/flower/grass/leaf/root/seed/forest, agriculture: farm/crop/harvest/soil, garden, jungle",
  weather_climate: "weather: rain/snow/wind/cloud/sun/storm/fog/temperature, seasons: spring/summer/autumn/winter, climate, flood/drought",
  geography_places: "geography: mountain/river/ocean/desert/valley/island, places: city/country/region/coast, directions: north/south/east/west",
  education_school: "education: school/university/class/exam/grade/degree, learning: study/teach/lesson/textbook/homework/essay/research",
  work_career: "work: job/office/employee/salary/contract/career, professional: manager/engineer/lawyer/doctor/teacher/staff/colleague",
  sports_recreation: "sports: football/tennis/swim/run/gym/race/team/goal/medal, leisure: game/play/compete/champion/tournament",
  arts_entertainment: "arts: music/film/painting/literature/theatre/dance, entertainment: concert/gallery/museum/novel/poem/artist/musician",
  media_communication: "media: newspaper/television/radio/internet/social media, communication: message/email/broadcast/journalist/interview/report",
  shopping_commerce: "shopping: buy/sell/price/discount/market/store/product, money: pay/cost/afford/spend/earn/invoice/receipt",
  technology_digital: "technology: computer/phone/internet/software/app/data/digital, innovation: AI/robot/device/network/code/website/download",
  science_research: "science: biology/chemistry/physics/experiment/theory/research, concepts: atom/cell/molecule/energy/gravity/formula/data/discovery",
  health_medicine: "health: doctor/hospital/disease/treatment/medicine/surgery, medical: cancer/infection/blood pressure/therapy/symptom/diagnosis/vaccine",
  business_economy: "business: company/market/profit/revenue/investment/trade, economy: inflation/budget/debt/tax/stock/finance/industry/enterprise",
  politics_law: "politics: government/election/democracy/parliament/president/policy, law: court/judge/crime/legal/rights/justice/constitution/police",
  environment_society: "environment: pollution/climate change/conservation/recycling, society: poverty/inequality/immigration/racism/protest/welfare/rights",
  psychology_mind: "psychology: behavior/cognition/mental health/trauma/therapy/consciousness, thinking: logic/reason/memory/creativity/intelligence",
  academic_formal: "academic: analysis/theory/hypothesis/methodology/significant/subsequent, formal language: therefore/however/furthermore/establish/demonstrate",
};

export interface TopicDb {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>;
}

let cachedIds: ReadonlyMap<TopicName, string> | undefined;

/**
 * tags.id of each of the 30 topics. Throws EnrichmentConfigError (message starts with "topics_not_seeded")
 * listing the missing names when the table has not been seeded (run docs/seed-topics.sql). The ids are kept in
 * memory after the first success; a failure is NOT cached, so seeding the table fixes a running process.
 */
export async function loadTopicIds(db: TopicDb): Promise<ReadonlyMap<TopicName, string>> {
  if (cachedIds) return cachedIds;
  const { rows } = await db.query('SELECT id, name FROM tags WHERE name = ANY($1::text[])', [[...TOPIC_NAMES]]);
  const found = new Map<string, string>(rows.map((r: any) => [String(r.name), String(r.id)]));
  const missing = TOPIC_NAMES.filter((n) => !found.has(n));
  if (missing.length > 0) {
    throw new EnrichmentConfigError(
      'topics_not_seeded',
      `topics_not_seeded: ${missing.length} of ${TOPIC_NAMES.length} topic tags are missing from the "tags" table: ${missing.join(', ')}. Run docs/seed-topics.sql.`
    );
  }
  cachedIds = new Map(TOPIC_NAMES.map((n) => [n, found.get(n)!] as [TopicName, string]));
  return cachedIds;
}

/** Tests only. */
export function resetTopicCache(): void {
  cachedIds = undefined;
}

export const isTopicName = (value: unknown): value is TopicName => typeof value === 'string' && (TOPIC_NAMES as readonly string[]).includes(value);
