/**
 * Fills the definition gaps that `scripts/dev/audit-definitions.ts` reports. One transaction, no API calls, no tokens.
 *
 *   npx tsx scripts/dev/fill-definitions.ts             # DRY RUN (default): does all the work, prints it, ROLLS BACK
 *   npx tsx scripts/dev/fill-definitions.ts --confirm   # the same work, COMMITTED
 *
 * Both fixes only ever FILL something that is missing; text that is already there is never overwritten, so a second run changes
 * nothing.
 *
 *  1. dictionary_entries.meaning_en blank -> the definition_en of the sense that carries the entry's headline Vietnamese meaning
 *     (the first meaning of meaning_vi), preferring the first listed part of speech and then the lowest sense_order; when no sense
 *     carries it, the first sense of the first listed part of speech. This is the rule the enrichment pipeline already follows
 *     (docs/lookup-spec.md §10.6: meaning_en = definition_en of the first sense; all 3,914 [auto] entries match it), adapted to the
 *     older hand-built entries whose sense_order restarts for every part of speech.
 *  2. a part of speech listed in dictionary_entries.pos that has no sense -> the senses in NEW_SENSES below: an English definition,
 *     a Vietnamese definition and one example pair each, so that part of speech is defined in both languages.
 *
 * Every change is written to entry_edit_history (admin_id NULL): field_name 'meaning_en' or 'sense_added'.
 * The dry run runs the very same statements and then rolls back, so what it prints is what --confirm will save.
 */
import 'dotenv/config';
import type { PoolClient } from 'pg';
import pool from '../../config/db';
import { readArg } from '../enrichment/args';

// ── the senses to add ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Style of the older entries: lower-case English definition without a final full stop; Vietnamese definition as comma-separated
// meanings, optionally with a short clarification in brackets; grammar_note in the same [bracket] form the older senses use
// (nouns and verbs only); sense_order restarts at 0 for every part of speech.

interface NewSense {
  headword: string;
  pos: string;
  definition_en: string;
  definition_vi: string;
  grammar_note?: string;
  example_en: string;
  example_vi: string;
}

const NEW_SENSES: NewSense[] = [
  { headword: 'all right', pos: 'adverb', definition_en: 'in a satisfactory way; without problems', definition_vi: 'ổn thỏa, suôn sẻ, tạm ổn', example_en: 'Everything went all right at the interview.', example_vi: 'Mọi việc ở buổi phỏng vấn đều suôn sẻ.' },
  { headword: 'alongside', pos: 'adverb', definition_en: 'close to the side of something; next to it', definition_vi: 'sát bên, dọc theo bên cạnh', example_en: 'A police car drove up alongside.', example_vi: 'Một chiếc xe cảnh sát chạy đến sát bên.' },
  { headword: 'another', pos: 'pronoun', definition_en: 'one more person or thing of the same kind; a different one', definition_vi: 'một cái nữa, một người nữa, một cái khác', example_en: "This pen doesn't work. Can I have another?", example_vi: 'Cây bút này không viết được. Cho tôi cây khác được không?' },
  { headword: 'any', pos: 'pronoun', definition_en: 'used instead of a noun to mean one or some of a thing, especially in questions and negative sentences', definition_vi: 'cái nào, chút nào, người nào (thay cho danh từ)', example_en: 'We need milk. Is there any in the fridge?', example_vi: 'Chúng ta cần sữa. Trong tủ lạnh còn chút nào không?' },
  { headword: 'any', pos: 'adverb', definition_en: "used with a comparative to mean 'at all' or 'even a little', especially in questions and negative sentences", definition_vi: 'chút nào, một chút nào (đứng trước dạng so sánh hơn)', example_en: 'Are you feeling any better today?', example_vi: 'Hôm nay bạn có thấy khá hơn chút nào không?' },
  { headword: 'assistant', pos: 'adjective', definition_en: 'having a rank just below the person in charge', definition_vi: 'phó, trợ lý (chức vụ dưới người đứng đầu)', example_en: 'She is the assistant manager of a hotel.', example_vi: 'Cô ấy là phó quản lý của một khách sạn.' },
  { headword: 'average', pos: 'verb', definition_en: 'to reach a certain amount as an average over a period of time', definition_vi: 'đạt mức trung bình là, tính trung bình', grammar_note: '[transitive]', example_en: 'The team averages two goals a match.', example_vi: 'Đội bóng ghi trung bình hai bàn mỗi trận.' },
  { headword: 'back', pos: 'adjective', definition_en: 'at or near the rear of something; furthest from the front', definition_vi: 'sau, ở phía sau (ví dụ: cửa sau, ghế sau)', example_en: 'The children sat in the back seat of the car.', example_vi: 'Bọn trẻ ngồi ở ghế sau của chiếc xe.' },
  { headword: 'backup', pos: 'adjective', definition_en: 'kept ready to use if the main one fails or is not available', definition_vi: 'dự phòng, sao lưu', example_en: 'The hospital has a backup generator in case of a power cut.', example_vi: 'Bệnh viện có máy phát điện dự phòng phòng khi mất điện.' },
  { headword: 'bail', pos: 'verb', definition_en: 'to release an accused person from custody until their trial in return for money paid to the court', definition_vi: 'cho tại ngoại, bảo lãnh', grammar_note: '[transitive]', example_en: 'The judge agreed to bail him until his trial next month.', example_vi: 'Thẩm phán đồng ý cho anh ta tại ngoại cho đến phiên xét xử vào tháng sau.' },
  { headword: 'beneath', pos: 'adverb', definition_en: 'in or to a lower place; underneath', definition_vi: 'bên dưới, ở phía dưới', example_en: 'We looked down from the bridge at the river flowing beneath.', example_vi: 'Từ trên cầu, chúng tôi nhìn xuống dòng sông đang chảy bên dưới.' },
  { headword: 'better', pos: 'verb', definition_en: 'to do or be better than something; to improve on it', definition_vi: 'vượt qua, làm tốt hơn, cải thiện', grammar_note: '[transitive]', example_en: 'She hopes to better her own record this year.', example_vi: 'Cô ấy hy vọng năm nay sẽ vượt qua kỷ lục của chính mình.' },
  { headword: 'between', pos: 'adverb', definition_en: 'in the space or time that separates two things or events', definition_vi: 'ở giữa, xen giữa', example_en: 'The two houses are close together, with a narrow path in between.', example_vi: 'Hai ngôi nhà nằm sát nhau, ở giữa là một lối đi hẹp.' },
  { headword: 'beyond', pos: 'adverb', definition_en: 'at or to a point further away; on the far side', definition_vi: 'xa hơn, ở bên kia, phía xa', example_en: 'We could see the village and the mountains beyond.', example_vi: 'Chúng tôi nhìn thấy ngôi làng và những dãy núi ở phía xa.' },
  { headword: 'bill', pos: 'verb', definition_en: 'to send someone a written statement of the money they owe', definition_vi: 'gửi hóa đơn, lập hóa đơn thu tiền', grammar_note: '[transitive]', example_en: 'The garage billed me $200 for the repairs.', example_vi: 'Xưởng sửa xe gửi hóa đơn 200 đô la cho tôi về việc sửa chữa.' },
  { headword: 'billion', pos: 'noun', definition_en: 'a very large number or amount of people or things', definition_vi: 'hàng tỷ, số lượng rất lớn', grammar_note: '[countable, usually plural]', example_en: 'Billions of dollars are spent on advertising every year.', example_vi: 'Hàng tỷ đô la được chi cho quảng cáo mỗi năm.' },
  { headword: 'blind', pos: 'verb', definition_en: 'to make someone unable to see, for a short time or permanently', definition_vi: 'làm mù, làm lóa mắt', grammar_note: '[transitive]', example_en: 'The bright headlights blinded me for a moment.', example_vi: 'Ánh đèn pha chói lòa làm tôi lóa mắt trong giây lát.' },
  { headword: 'boast', pos: 'noun', definition_en: 'something you say that shows too much pride in what you have or can do', definition_vi: 'lời khoe khoang, lời khoác lác', grammar_note: '[countable]', example_en: 'His boast that he could run a marathon turned out to be empty talk.', example_vi: 'Lời khoe của anh ấy rằng có thể chạy marathon hóa ra chỉ là nói suông.' },
  { headword: 'boil', pos: 'noun', definition_en: 'the point or state at which a liquid starts to bubble and turn to gas', definition_vi: 'điểm sôi, trạng thái sôi', grammar_note: '[singular]', example_en: 'Bring the water to a boil, then add the pasta.', example_vi: 'Đun nước đến khi sôi, rồi cho mì vào.' },
  { headword: 'boil', pos: 'noun', definition_en: 'a painful red swelling under the skin that contains pus', definition_vi: 'nhọt, mụn nhọt', grammar_note: '[countable]', example_en: 'He had a painful boil on the back of his neck.', example_vi: 'Anh ấy bị một cái nhọt đau ở gáy.' },
  { headword: 'born', pos: 'verb', definition_en: 'to come into the world by birth', definition_vi: 'được sinh ra, ra đời', grammar_note: '[passive: be born]', example_en: 'My grandmother was born in a small village.', example_vi: 'Bà tôi sinh ra ở một ngôi làng nhỏ.' },
  { headword: 'boss', pos: 'verb', definition_en: 'to give orders to someone in an annoying way (usually boss somebody around)', definition_vi: 'sai bảo, ra lệnh hách dịch', grammar_note: '[transitive]', example_en: 'Stop bossing me around!', example_vi: 'Đừng có sai bảo tôi nữa!' },
  { headword: 'both', pos: 'pronoun', definition_en: 'the two people or things that have been mentioned; not only one', definition_vi: 'cả hai (người, vật)', example_en: 'I have two sisters, and both live in Hanoi.', example_vi: 'Tôi có hai chị gái, và cả hai đều sống ở Hà Nội.' },
  { headword: 'bother', pos: 'noun', definition_en: 'trouble, effort or inconvenience; something that is slightly annoying', definition_vi: 'sự phiền phức, sự phiền toái, điều rắc rối nhỏ', grammar_note: '[uncountable]', example_en: "It's no bother at all; I'm going that way anyway.", example_vi: 'Không phiền gì đâu, dù sao tôi cũng đi đường đó.' },
  { headword: 'bound', pos: 'noun', definition_en: 'a long or high jump; a leap', definition_vi: 'bước nhảy, cú nhảy vọt', grammar_note: '[countable]', example_en: 'The dog crossed the garden in three bounds.', example_vi: 'Con chó băng qua khu vườn chỉ trong ba bước nhảy.' },
  { headword: 'bound', pos: 'noun', definition_en: 'a limit that something cannot or should not go beyond (usually bounds)', definition_vi: 'giới hạn, ranh giới', grammar_note: '[plural]', example_en: 'His joy knew no bounds.', example_vi: 'Niềm vui của anh ấy không có giới hạn.' },
  { headword: 'branch', pos: 'verb', definition_en: 'to divide into two or more parts that go in different directions', definition_vi: 'rẽ nhánh, phân nhánh, chia nhánh', grammar_note: '[intransitive]', example_en: 'The road branches into two just after the village.', example_vi: 'Con đường chia thành hai nhánh ngay sau ngôi làng.' },
  { headword: 'brief', pos: 'noun', definition_en: 'a set of instructions or information given to someone about a job or task', definition_vi: 'bản chỉ dẫn, nhiệm vụ được giao, bản yêu cầu công việc', grammar_note: '[countable]', example_en: "The architect's brief was to design a low-cost family home.", example_vi: 'Nhiệm vụ được giao cho kiến trúc sư là thiết kế một ngôi nhà gia đình giá rẻ.' },
  { headword: 'button', pos: 'verb', definition_en: 'to fasten a piece of clothing with buttons', definition_vi: 'cài cúc, cài khuy', grammar_note: '[transitive, intransitive]', example_en: "It's cold outside, so button your coat.", example_vi: 'Bên ngoài trời lạnh, nên hãy cài cúc áo khoác vào.' },
  { headword: 'by', pos: 'adverb', definition_en: 'going past a person or place', definition_vi: 'ngang qua, đi qua', example_en: 'A police car drove by without stopping.', example_vi: 'Một chiếc xe cảnh sát chạy ngang qua mà không dừng lại.' },
  { headword: 'calm', pos: 'noun', definition_en: 'a peaceful, quiet state in which there is no worry, trouble or strong movement', definition_vi: 'sự bình tĩnh, sự yên tĩnh, cảnh yên ả', grammar_note: '[uncountable]', example_en: 'After the storm, a period of calm followed.', example_vi: 'Sau cơn bão là một khoảng thời gian yên ả.' },
  { headword: 'capital', pos: 'adjective', definition_en: '(of a letter) written in its large form, as at the start of a name or sentence', definition_vi: 'viết hoa, in hoa (chữ cái)', example_en: 'Write your name in capital letters.', example_vi: 'Hãy viết tên của bạn bằng chữ in hoa.' },
  { headword: 'capital', pos: 'adjective', definition_en: '(of a crime or punishment) serious enough to be punished by death', definition_vi: 'tử hình, có thể bị xử tử', example_en: 'Murder is a capital offence in some countries.', example_vi: 'Giết người là tội có thể bị xử tử ở một số quốc gia.' },
  { headword: 'clear', pos: 'adverb', definition_en: 'so as to be away from something; at a distance from it', definition_vi: 'tránh xa, cách xa', example_en: 'Please stand clear of the doors.', example_vi: 'Xin hãy đứng tránh xa cửa.' },
  { headword: 'close', pos: 'adverb', definition_en: 'at a short distance or time from something; near', definition_vi: 'gần, sát, ở gần', example_en: "Don't stand too close to the fire.", example_vi: 'Đừng đứng quá gần lửa.' },
  { headword: 'club', pos: 'verb', definition_en: 'to hit a person or animal hard with a heavy stick or similar object', definition_vi: 'dùng gậy đánh, đánh bằng dùi cui', grammar_note: '[transitive]', example_en: 'The attackers clubbed him to the ground.', example_vi: 'Những kẻ tấn công dùng gậy đánh anh ta ngã xuống đất.' },
];

// ── checks on the text before anything touches the database ─────────────────────────────────────────────────────────────────

/** Letters only Vietnamese uses (é è ê à â ô … are shared with French/Spanish loanwords such as "café"; same list as audit-definitions.ts). */
const VI_ONLY = /[ạảãấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹơưăđ]/i;
/** Any letter that carries a Vietnamese tone or vowel mark. */
const VI_ANY = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const POS_ALLOWED = new Set(['noun', 'verb', 'adjective', 'adverb', 'preposition', 'conjunction', 'pronoun', 'determiner', 'exclamation', 'modal verb', 'number', 'article']);

function problemsOf(s: NewSense): string[] {
  const p: string[] = [];
  const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
  if (!POS_ALLOWED.has(s.pos)) p.push(`unknown pos "${s.pos}"`);
  if (s.definition_en.length < 3 || s.definition_en.length > 300) p.push('definition_en length');
  if (words(s.definition_en) > 25) p.push('definition_en over 25 words');
  if (VI_ONLY.test(s.definition_en)) p.push('definition_en holds Vietnamese letters');
  if (/\.\s*$/.test(s.definition_en)) p.push('definition_en ends with a full stop (older senses have none)');
  if (s.definition_vi.length < 2 || s.definition_vi.length > 300) p.push('definition_vi length');
  if (!VI_ANY.test(s.definition_vi)) p.push('definition_vi has no Vietnamese letter');
  if (s.definition_vi.trim().toLowerCase() === s.definition_en.trim().toLowerCase()) p.push('definition_vi equals definition_en');
  if (!s.example_en.toLowerCase().includes(s.headword.toLowerCase())) p.push('example_en does not contain the headword');
  if (!/[.!?]$/.test(s.example_en.trim())) p.push('example_en has no final punctuation');
  if (VI_ONLY.test(s.example_en)) p.push('example_en holds Vietnamese letters');
  if (!VI_ANY.test(s.example_vi) || !/[.!?]$/.test(s.example_vi.trim())) p.push('example_vi: no Vietnamese letter or no final punctuation');
  if (s.grammar_note !== undefined && (s.grammar_note.length > 100 || !s.grammar_note.startsWith('['))) p.push('grammar_note format');
  return p;
}

// ── SQL ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// (backslashes are doubled because this is a JS template literal)

/** Fix 1. DISTINCT ON picks one sense per entry; `plain` is the first sense of the first listed part of speech, kept only to report how often the headline rule differs. */
const FILL_MEANING_EN_SQL = `
  WITH cand AS (
    SELECT e.id, e.pos,
           lower(btrim((regexp_split_to_array(regexp_replace(COALESCE(e.meaning_vi, ''), '\\([^)]*\\)', '', 'g'), '\\s*[;,]\\s*'))[1])) AS gloss
      FROM dictionary_entries e
     WHERE NULLIF(btrim(e.meaning_en), '') IS NULL
  ),
  pick AS (
    SELECT DISTINCT ON (c.id) c.id, s.definition_en AS new_en, s.pos AS sense_pos, s.sense_order,
           COALESCE(c.gloss <> '' AND position(c.gloss IN lower(s.definition_vi)) > 0, false) AS gloss_hit
      FROM cand c
      JOIN entry_senses s ON s.entry_id = c.id AND NULLIF(btrim(s.definition_en), '') IS NOT NULL
     ORDER BY c.id,
              COALESCE(c.gloss <> '' AND position(c.gloss IN lower(s.definition_vi)) > 0, false) DESC,
              COALESCE(s.pos = c.pos[1], false) DESC, s.sense_order, s.pos
  ),
  plain AS (
    SELECT DISTINCT ON (c.id) c.id, s.definition_en AS plain_en
      FROM cand c
      JOIN entry_senses s ON s.entry_id = c.id AND NULLIF(btrim(s.definition_en), '') IS NOT NULL
     ORDER BY c.id, COALESCE(s.pos = c.pos[1], false) DESC, s.sense_order, s.pos
  ),
  upd AS (
    UPDATE dictionary_entries e SET meaning_en = p.new_en
      FROM pick p
     WHERE e.id = p.id AND NULLIF(btrim(e.meaning_en), '') IS NULL
    RETURNING e.id, e.headword, e.meaning_vi, p.new_en, p.sense_pos, p.sense_order, p.gloss_hit
  ),
  hist AS (
    INSERT INTO entry_edit_history (entry_id, admin_id, field_name, old_value, new_value)
    SELECT id, NULL, 'meaning_en', NULL, new_en FROM upd
    RETURNING entry_id
  )
  SELECT u.id, u.headword, u.meaning_vi, u.new_en, u.sense_pos, u.sense_order, u.gloss_hit,
         (pl.plain_en IS DISTINCT FROM u.new_en) AS differs_from_plain, (SELECT count(*) FROM hist)::int AS history_rows
    FROM upd u LEFT JOIN plain pl ON pl.id = u.id
   ORDER BY lower(u.headword)`;

/** Fix 2. A sense is inserted only for a part of speech that has none yet, so a second run inserts nothing. */
const ADD_SENSES_SQL = `
  WITH src AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb)
      AS x(entry_id uuid, pos text, sense_order int, definition_en text, definition_vi text, grammar_note text, example_en text, example_vi text)
  ),
  ins AS (
    INSERT INTO entry_senses (entry_id, pos, sense_order, definition_en, definition_vi, grammar_note)
    SELECT s.entry_id, s.pos, s.sense_order, s.definition_en, s.definition_vi, s.grammar_note
      FROM src s
     WHERE NOT EXISTS (SELECT 1 FROM entry_senses t WHERE t.entry_id = s.entry_id AND t.pos = s.pos)
    RETURNING id, entry_id, pos, sense_order, definition_en, definition_vi
  ),
  ex AS (
    INSERT INTO sense_examples (sense_id, example_en, example_vi, sort_order, source)
    SELECT i.id, s.example_en, s.example_vi, 0, 'ai_enrichment'
      FROM ins i JOIN src s ON s.entry_id = i.entry_id AND s.pos = i.pos AND s.sense_order = i.sense_order
    RETURNING sense_id
  ),
  hist AS (
    INSERT INTO entry_edit_history (entry_id, admin_id, field_name, old_value, new_value)
    SELECT entry_id, NULL, 'sense_added', NULL,
           json_build_object('pos', pos, 'sense_order', sense_order, 'definition_en', definition_en, 'definition_vi', definition_vi)::text
      FROM ins
    RETURNING entry_id
  )
  SELECT (SELECT count(*) FROM ins)::int AS senses, (SELECT count(*) FROM ex)::int AS examples, (SELECT count(*) FROM hist)::int AS history_rows`;

/** What must be zero afterwards (the same predicates as scripts/dev/audit-definitions.ts). */
const REMAINING_SQL = `
  SELECT
    (SELECT count(*) FROM dictionary_entries WHERE NULLIF(btrim(meaning_en), '') IS NULL)::int AS blank_meaning_en,
    (SELECT count(*) FROM dictionary_entries WHERE NULLIF(btrim(meaning_vi), '') IS NULL)::int AS blank_meaning_vi,
    (SELECT count(*) FROM entry_senses WHERE NULLIF(btrim(definition_en), '') IS NULL OR NULLIF(btrim(definition_vi), '') IS NULL)::int AS blank_sense_definition,
    (SELECT count(*) FROM dictionary_entries e WHERE NOT EXISTS (SELECT 1 FROM entry_senses s WHERE s.entry_id = e.id))::int AS entries_without_senses,
    (SELECT count(*) FROM dictionary_entries e, unnest(COALESCE(e.pos, '{}'::varchar[])) AS p(pos)
      WHERE NOT EXISTS (SELECT 1 FROM entry_senses s WHERE s.entry_id = e.id AND s.pos = p.pos
                          AND NULLIF(btrim(s.definition_en), '') IS NOT NULL AND NULLIF(btrim(s.definition_vi), '') IS NOT NULL))::int AS pos_without_definition`;

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const KNOWN_FLAGS = new Set(['--confirm', '--dry-run', '--sample']);
const unknown = argv.filter((a, i) => a.startsWith('--') && !KNOWN_FLAGS.has(a));
const CONFIRM = argv.includes('--confirm');
const SAMPLE = Math.max(parseInt(readArg(argv, 'sample') ?? '12', 10) || 12, 0);
/** A dictionary of this app has ~5,000 entries; far more blanks than that means the wrong database is selected. */
const MAX_MEANING_EN_ROWS = 6000;

const clip = (s: string, n = 90): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function run(client: PoolClient): Promise<number> {
  const db = (await client.query('SELECT current_database() AS db')).rows[0].db;
  console.log(`database: ${db}   mode: ${CONFIRM ? 'CONFIRM (will COMMIT)' : 'DRY RUN (will ROLL BACK)'}\n`);

  // 0. the data we are about to write must be sound
  const bad = NEW_SENSES.map((s) => ({ s, p: problemsOf(s) })).filter((x) => x.p.length > 0);
  if (bad.length > 0) {
    for (const b of bad) console.error(`  ${b.s.headword}/${b.s.pos}: ${b.p.join('; ')}`);
    throw new Error(`${bad.length} new sense(s) failed validation`);
  }

  await client.query('BEGIN');

  // 1. every headword must name exactly one entry that lists the part of speech we are adding to
  const heads = [...new Set(NEW_SENSES.map((s) => s.headword.toLowerCase()))];
  const found = (await client.query('SELECT id, headword, pos FROM dictionary_entries WHERE lower(headword) = ANY($1::text[]) FOR UPDATE', [heads])).rows;
  const byHead = new Map<string, Array<{ id: string; pos: string[] }>>();
  for (const r of found) byHead.set(r.headword.toLowerCase(), [...(byHead.get(r.headword.toLowerCase()) ?? []), { id: r.id, pos: r.pos ?? [] }]);
  const orderOf = new Map<string, number>();
  const rows = NEW_SENSES.map((s) => {
    const hits = byHead.get(s.headword.toLowerCase()) ?? [];
    if (hits.length !== 1) throw new Error(`"${s.headword}" matches ${hits.length} entries, expected exactly 1`);
    if (!hits[0].pos.includes(s.pos)) throw new Error(`"${s.headword}" does not list part of speech "${s.pos}" (${hits[0].pos.join(', ')})`);
    const key = `${hits[0].id}|${s.pos}`;
    const sense_order = orderOf.get(key) ?? 0;
    orderOf.set(key, sense_order + 1);
    return { entry_id: hits[0].id, pos: s.pos, sense_order, definition_en: s.definition_en, definition_vi: s.definition_vi, grammar_note: s.grammar_note ?? null, example_en: s.example_en, example_vi: s.example_vi };
  });

  // 2. fix 1 first, so that it chooses among the ORIGINAL senses only (the senses fix 2 adds must not influence the pick)
  const filled = (await client.query(FILL_MEANING_EN_SQL)).rows as Array<{
    headword: string; meaning_vi: string; new_en: string; sense_pos: string; sense_order: number; gloss_hit: boolean; differs_from_plain: boolean; history_rows: number;
  }>;
  if (filled.length > MAX_MEANING_EN_ROWS) throw new Error(`refusing: ${filled.length} entries would change, more than ${MAX_MEANING_EN_ROWS}; is this the right database?`);
  const hit = filled.filter((f) => f.gloss_hit).length;
  const differs = filled.filter((f) => f.differs_from_plain);
  console.log(`\nfix 1  meaning_en filled: ${filled.length}   history rows: ${filled[0]?.history_rows ?? 0}`);
  console.log(`       sense chosen because it carries the headline Vietnamese meaning: ${hit}   fallback to the first sense of the first part of speech: ${filled.length - hit}`);
  console.log(`       headline rule chose a different sense than "first sense of the first part of speech": ${differs.length}`);
  if (SAMPLE > 0) {
    console.log('\n       examples (meaning_vi  →  meaning_en):');
    for (const f of filled.slice(0, SAMPLE)) console.log(`         ${f.headword.padEnd(14)} ${clip(f.meaning_vi, 38).padEnd(38)} →  ${clip(f.new_en, 80)}  [${f.sense_pos} #${f.sense_order}]`);
    const fallbacks = filled.filter((f) => !f.gloss_hit);
    if (fallbacks.length > 0) {
      console.log(`\n       fallback picks (no sense carries the first meaning_vi gloss), first ${Math.min(SAMPLE, fallbacks.length)} of ${fallbacks.length}:`);
      for (const f of fallbacks.slice(0, SAMPLE)) console.log(`         ${f.headword.padEnd(14)} ${clip(f.meaning_vi, 38).padEnd(38)} →  ${clip(f.new_en, 80)}  [${f.sense_pos} #${f.sense_order}]`);
    }
    if (differs.length > 0) {
      console.log(`\n       where the headline rule differs from the plain rule, first ${Math.min(SAMPLE, differs.length)} of ${differs.length}:`);
      for (const f of differs.slice(0, SAMPLE)) console.log(`         ${f.headword.padEnd(14)} ${clip(f.meaning_vi, 38).padEnd(38)} →  ${clip(f.new_en, 80)}  [${f.sense_pos} #${f.sense_order}]`);
    }
  }

  // 3. fix 2
  const added = (await client.query(ADD_SENSES_SQL, [JSON.stringify(rows)])).rows[0];
  console.log(`\nfix 2  senses added: ${added.senses}   examples: ${added.examples}   history rows: ${added.history_rows}   (of ${rows.length} prepared; the rest already existed)`);
  if (SAMPLE > 0 && added.senses > 0) {
    console.table(NEW_SENSES.slice(0, SAMPLE).map((s) => ({ word: s.headword, pos: s.pos, definition_en: clip(s.definition_en, 60), definition_vi: clip(s.definition_vi, 40) })));
  }

  // 4. the state we would leave behind
  const left = (await client.query(REMAINING_SQL)).rows[0];
  console.log('\nafter the changes (inside the transaction):', JSON.stringify(left));
  const stillBroken = Object.entries(left).filter(([, n]) => Number(n) > 0);
  if (stillBroken.length > 0) throw new Error(`gaps would remain: ${stillBroken.map(([k, n]) => `${k}=${n}`).join(', ')}`);

  if (CONFIRM) {
    await client.query('COMMIT');
    console.log('\nCOMMITTED. Re-check with: npx tsx scripts/dev/audit-definitions.ts');
  } else {
    await client.query('ROLLBACK');
    console.log('\nDRY RUN: rolled back, nothing was saved. Run again with --confirm to save exactly this.');
  }
  return 0;
}

async function main(): Promise<number> {
  if (unknown.length > 0) {
    console.error(`unknown option(s): ${unknown.join(' ')}   (known: --confirm, --dry-run, --sample N)`);
    return 2;
  }
  if (CONFIRM && argv.includes('--dry-run')) {
    console.error('--dry-run and --confirm cannot be combined');
    return 2;
  }
  const client = await pool.connect();
  let failed = false;
  try {
    return await run(client);
  } catch (err) {
    failed = true;
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release(failed);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('fill-definitions failed (rolled back, nothing saved):', err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
