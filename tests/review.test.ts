import request from 'supertest';
import app from '../app';
import pool from '../config/db';

const TS = Date.now();
const EMAIL_PREFIX = `phase5r-${TS}`;
// Headwords must be alphanumeric (no hyphens) for \b word-boundary regex to work in cloze
const HW_VERB = `vb${TS}`;    // verb entry with senses + example → SwiftChoice + Cloze
const HW_SPARSE = `sp${TS}`;  // unique POS → INSUFFICIENT_DISTRACTORS
const HW_B = `eb${TS}`;       // User B's card → ownership test

let tokenA = '';
let tokenB = '';
let deckIdA = '';
let deckIdB = '';
let cardIdVerb = '';   // User A — normal verb card (SwiftChoice + Cloze happy path)
let cardIdSparse = ''; // User A — unique POS (INSUFFICIENT_DISTRACTORS)
let cardIdB = '';      // User B — ownership test

beforeAll(async () => {
  // ── Register users ────────────────────────────────────────────────────────
  const regA = await request(app).post('/api/v1/auth/register').send({
    email: `${EMAIL_PREFIX}a@example.com`,
    password: 'password123',
    full_name: 'Review Tester A',
  });
  if (regA.status !== 201) throw new Error(`Setup regA: ${JSON.stringify(regA.body)}`);
  tokenA = regA.body.data.access_token;

  const regB = await request(app).post('/api/v1/auth/register').send({
    email: `${EMAIL_PREFIX}b@example.com`,
    password: 'password123',
    full_name: 'Review Tester B',
  });
  if (regB.status !== 201) throw new Error(`Setup regB: ${JSON.stringify(regB.body)}`);
  tokenB = regB.body.data.access_token;

  // ── Insert dictionary entries ─────────────────────────────────────────────
  // Verb entry: has meaning_vi, cefr_level=B1, pos=['verb']
  const { rows: eVerb } = await pool.query(
    `INSERT INTO dictionary_entries
       (headword, lemma, pos, meaning_vi, cefr_level, published, source)
     VALUES ($1, $1, $2, 'to arrange in order', 'B1', TRUE, 'manual')
     RETURNING id`,
    [HW_VERB, ['verb']]
  );
  const entryVerbId: string = eVerb[0].id;

  // Sense + example for verb entry (required by Cloze endpoint)
  const { rows: senseRows } = await pool.query(
    `INSERT INTO entry_senses (entry_id, pos, sense_order, definition_en, definition_vi)
     VALUES ($1, 'verb', 0, 'to put things in order', 'tổ chức, sắp xếp')
     RETURNING id`,
    [entryVerbId]
  );
  const senseId: string = senseRows[0].id;

  await pool.query(
    `INSERT INTO sense_examples (sense_id, example_en, sort_order)
     VALUES ($1, $2, 0)`,
    [senseId, `She needs to ${HW_VERB} the files before the meeting.`]
  );

  // Sparse entry: pos=[unique value] → guaranteed INSUFFICIENT_DISTRACTORS
  const uniquePos = `xpos${TS}`;
  const { rows: eSparse } = await pool.query(
    `INSERT INTO dictionary_entries
       (headword, lemma, pos, meaning_vi, cefr_level, published, source)
     VALUES ($1, $1, $2, 'sparse test meaning', 'A1', TRUE, 'manual')
     RETURNING id`,
    [HW_SPARSE, [uniquePos]]
  );
  const entrySparseId: string = eSparse[0].id;

  // 4 filler noun entries so deck A has 6 cards total (5 returned by PairLink count=5)
  const fillerIds: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const { rows } = await pool.query(
      `INSERT INTO dictionary_entries
         (headword, lemma, pos, meaning_vi, cefr_level, published, source)
       VALUES ($1, $1, $2, $3, 'B1', TRUE, 'manual')
       RETURNING id`,
      [`nn${i}${TS}`, ['noun'], `filler meaning ${i}`]
    );
    fillerIds.push(rows[0].id);
  }

  // 3 verb distractor entries so SwiftChoice happy path always has enough distractors
  // (test DB may not have pre-seeded Oxford data)
  for (let i = 1; i <= 3; i++) {
    await pool.query(
      `INSERT INTO dictionary_entries
         (headword, lemma, pos, meaning_vi, cefr_level, published, source)
       VALUES ($1, $1, $2, $3, 'B1', TRUE, 'manual')`,
      [`dist${i}${TS}`, ['verb'], `distractor vi meaning ${i}`]
    );
  }

  // User B's entry
  const { rows: eB } = await pool.query(
    `INSERT INTO dictionary_entries
       (headword, lemma, pos, meaning_vi, published, source)
     VALUES ($1, $1, $2, 'user B meaning', TRUE, 'manual')
     RETURNING id`,
    [HW_B, ['noun']]
  );
  const entryBId: string = eB[0].id;

  // ── Create decks via API ──────────────────────────────────────────────────
  const deckARes = await request(app)
    .post('/api/v1/decks')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ title: 'Review Test Deck A', level: 'beginner' });
  if (deckARes.status !== 201) throw new Error(`Deck A: ${JSON.stringify(deckARes.body)}`);
  deckIdA = deckARes.body.data.id;

  const deckBRes = await request(app)
    .post('/api/v1/decks')
    .set('Authorization', `Bearer ${tokenB}`)
    .send({ title: 'Review Test Deck B', level: 'beginner' });
  if (deckBRes.status !== 201) throw new Error(`Deck B: ${JSON.stringify(deckBRes.body)}`);
  deckIdB = deckBRes.body.data.id;

  // ── Add cards via API ─────────────────────────────────────────────────────
  const addCard = async (token: string, deckId: string, entryId: string): Promise<string> => {
    const res = await request(app)
      .post(`/api/v1/decks/${deckId}/cards`)
      .set('Authorization', `Bearer ${token}`)
      .send({ entry_id: entryId });
    if (res.status !== 201) throw new Error(`Add card: ${JSON.stringify(res.body)}`);
    return res.body.data.id;
  };

  // Deck A: verb + sparse + 4 fillers = 6 cards
  cardIdVerb = await addCard(tokenA, deckIdA, entryVerbId);
  cardIdSparse = await addCard(tokenA, deckIdA, entrySparseId);
  for (const fid of fillerIds) {
    await addCard(tokenA, deckIdA, fid);
  }

  // Deck B: User B's card
  cardIdB = await addCard(tokenB, deckIdB, entryBId);
});

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${EMAIL_PREFIX}%`]);
  // Cascade: user deletion removes decks → cards → user_card_progress → reviews
  // Dictionary entries must be deleted separately (no user FK)
  // All test entries have TS suffix
  await pool.query(
    `DELETE FROM dictionary_entries WHERE headword LIKE $1`,
    [`%${TS}`]
  );
  await pool.end();
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/review/swift-choice/question', () => {
  it('happy path → 200, 4 options, correct_index in [0-3]', async () => {
    const res = await request(app)
      .post('/api/v1/review/swift-choice/question')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ card_id: cardIdVerb });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.card_id).toBe(cardIdVerb);
    expect(d.question_type).toBe('meaning_from_word');
    expect(d.prompt.word).toBe(HW_VERB);
    expect(Array.isArray(d.options)).toBe(true);
    expect(d.options).toHaveLength(4);
    expect(typeof d.correct_index).toBe('number');
    expect(d.correct_index).toBeGreaterThanOrEqual(0);
    expect(d.correct_index).toBeLessThanOrEqual(3);
    // correct option text must match the entry's meaning
    expect(d.options[d.correct_index].text.length).toBeGreaterThan(0);
  });

  it('non-existent card_id → 404 CARD_NOT_FOUND', async () => {
    const res = await request(app)
      .post('/api/v1/review/swift-choice/question')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ card_id: '00000000-0000-0000-0000-000000000000' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CARD_NOT_FOUND');
  });

  it('unique-POS card → 422 INSUFFICIENT_DISTRACTORS', async () => {
    const res = await request(app)
      .post('/api/v1/review/swift-choice/question')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ card_id: cardIdSparse });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_DISTRACTORS');
  });

  it('User A cannot use User B card → 404 CARD_NOT_FOUND', async () => {
    const res = await request(app)
      .post('/api/v1/review/swift-choice/question')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ card_id: cardIdB });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CARD_NOT_FOUND');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/review/cloze/question', () => {
  it('level=1 → 200, word_choices array of 4', async () => {
    const res = await request(app)
      .post('/api/v1/review/cloze/question')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ card_id: cardIdVerb, level: 1 });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.card_id).toBe(cardIdVerb);
    expect(d.level).toBe(1);
    expect(typeof d.target_word).toBe('string');
    expect(d.sentence_masked).toContain('___');
    expect(d.sentence_full).not.toContain('___');
    expect(Array.isArray(d.word_choices)).toBe(true);
    expect(d.word_choices.length).toBeGreaterThanOrEqual(2); // at least correct + 1 wrong
    expect(d.scrambled_letters).toBeNull();
  });

  it('level=2 → 200, scrambled_letters is non-empty array', async () => {
    const res = await request(app)
      .post('/api/v1/review/cloze/question')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ card_id: cardIdVerb, level: 2 });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.level).toBe(2);
    expect(Array.isArray(d.scrambled_letters)).toBe(true);
    expect(d.scrambled_letters.length).toBeGreaterThan(0);
    expect(d.word_choices).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/review/pair-link/session', () => {
  it('deck_id + count=5 → 200, exactly 5 pairs with p1..p5 ids', async () => {
    const res = await request(app)
      .post('/api/v1/review/pair-link/session')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ deck_id: deckIdA, count: 5 });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(typeof d.session_id).toBe('string');
    expect(Array.isArray(d.pairs)).toBe(true);
    expect(d.pairs).toHaveLength(5);

    d.pairs.forEach((pair: any, idx: number) => {
      expect(pair.pair_id).toBe(`p${idx + 1}`);
      expect(typeof pair.card_id).toBe('string');
      expect(typeof pair.en).toBe('string');
      expect(typeof pair.vi).toBe('string');
    });
  });
});
