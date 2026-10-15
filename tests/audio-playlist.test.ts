import request from 'supertest';
import app from '../app';
import pool from '../config/db';

const TS = Date.now();
const EMAIL = `audio-playlist-${TS}@example.com`;

let access_token = '';
let ebookId = '';
let chapterFullId = '';      // chapter where every paragraph has ready audio
let chapterEmptyId = '';     // chapter with no audio at all
let chapterPartialId = '';   // chapter with 5/10 paragraphs ready

beforeAll(async () => {
  // Register user
  const reg = await request(app).post('/api/v1/auth/register').send({
    email: EMAIL,
    password: 'password123',
    full_name: 'Audio Playlist Tester',
  });
  if (reg.status !== 201) throw new Error(`Register failed: ${JSON.stringify(reg.body)}`);
  access_token = reg.body.data.access_token;

  // Free, published ebook
  const { rows: [eb] } = await pool.query(
    `INSERT INTO ebooks (title, author, level, required_plan, status, epub_file_url)
     VALUES ($1, 'Author', 'beginner', 'free', 'published', '/test.epub')
     RETURNING id`,
    [`Audio Playlist Ebook ${TS}`]
  );
  ebookId = eb.id;

  // ── Chapter 1: fully ready (3 paragraphs with audio)
  const { rows: [chFull] } = await pool.query(
    `INSERT INTO chapters (ebook_id, chapter_index, title, word_count, tts_status, tts_progress)
     VALUES ($1, 0, 'Full chapter', 30, 'ready', 100)
     RETURNING id`,
    [ebookId]
  );
  chapterFullId = chFull.id;

  for (let i = 0; i < 3; i++) {
    await pool.query(
      `INSERT INTO paragraphs
         (chapter_id, paragraph_index, text, word_count, audio_url, audio_status, duration_ms)
       VALUES ($1, $2, $3, 10, $4, 'ready', $5)`,
      [
        chapterFullId,
        i,
        `Full paragraph ${i} text content goes here.`,
        `https://r2.example.com/ebook_paragraph/us/full-${TS}-${i}.mp3`,
        2000 + i * 1000, // 2000, 3000, 4000 ms
      ]
    );
  }

  // ── Chapter 2: no audio at all (4 paragraphs, audio_status='none')
  const { rows: [chEmpty] } = await pool.query(
    `INSERT INTO chapters (ebook_id, chapter_index, title, word_count, tts_status, tts_progress)
     VALUES ($1, 1, 'Empty chapter', 40, 'none', 0)
     RETURNING id`,
    [ebookId]
  );
  chapterEmptyId = chEmpty.id;

  for (let i = 0; i < 4; i++) {
    await pool.query(
      `INSERT INTO paragraphs
         (chapter_id, paragraph_index, text, word_count, audio_status)
       VALUES ($1, $2, $3, 10, 'none')`,
      [chapterEmptyId, i, `Empty paragraph ${i} no audio yet.`]
    );
  }

  // ── Chapter 3: partial — 5/10 ready, others 'failed' or 'none'
  const { rows: [chPartial] } = await pool.query(
    `INSERT INTO chapters (ebook_id, chapter_index, title, word_count, tts_status, tts_progress)
     VALUES ($1, 2, 'Partial chapter', 100, 'failed', 50)
     RETURNING id`,
    [ebookId]
  );
  chapterPartialId = chPartial.id;

  for (let i = 0; i < 10; i++) {
    if (i < 5) {
      await pool.query(
        `INSERT INTO paragraphs
           (chapter_id, paragraph_index, text, word_count, audio_url, audio_status, duration_ms)
         VALUES ($1, $2, $3, 10, $4, 'ready', 1500)`,
        [
          chapterPartialId,
          i,
          `Partial ready paragraph ${i}.`,
          `https://r2.example.com/ebook_paragraph/us/partial-${TS}-${i}.mp3`,
        ]
      );
    } else {
      await pool.query(
        `INSERT INTO paragraphs
           (chapter_id, paragraph_index, text, word_count, audio_status, audio_error)
         VALUES ($1, $2, $3, 10, 'failed', 'Test failure')`,
        [chapterPartialId, i, `Partial failed paragraph ${i}.`]
      );
    }
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM ebooks WHERE id = $1`, [ebookId]);
  await pool.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
  await pool.end();
});

describe('GET /api/v1/ebooks/:id/chapters/:chapter_id/audio-playlist', () => {
  it('fully-ready chapter → playlist has every paragraph, is_fully_ready=true', async () => {
    const res = await request(app)
      .get(`/api/v1/ebooks/${ebookId}/chapters/${chapterFullId}/audio-playlist`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const data = res.body.data;

    expect(data.chapter_id).toBe(chapterFullId);
    expect(data.chapter_title).toBe('Full chapter');
    expect(data.total_paragraphs_in_chapter).toBe(3);
    expect(data.playable_paragraphs_count).toBe(3);
    expect(data.is_fully_ready).toBe(true);
    expect(data.total_duration_ms).toBe(2000 + 3000 + 4000);
    expect(data.playlist).toHaveLength(3);
    // Ordered by paragraph_index ascending
    expect(data.playlist.map((p: any) => p.paragraph_index)).toEqual([0, 1, 2]);
  });

  it('chapter with no audio → playlist=[], is_fully_ready=false', async () => {
    const res = await request(app)
      .get(`/api/v1/ebooks/${ebookId}/chapters/${chapterEmptyId}/audio-playlist`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const data = res.body.data;

    expect(data.total_paragraphs_in_chapter).toBe(4);
    expect(data.playable_paragraphs_count).toBe(0);
    expect(data.is_fully_ready).toBe(false);
    expect(data.total_duration_ms).toBe(0);
    expect(Array.isArray(data.playlist)).toBe(true);
    expect(data.playlist).toHaveLength(0);
  });

  it('partially-ready chapter → playlist has only ready ones, is_fully_ready=false', async () => {
    const res = await request(app)
      .get(`/api/v1/ebooks/${ebookId}/chapters/${chapterPartialId}/audio-playlist`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const data = res.body.data;

    expect(data.total_paragraphs_in_chapter).toBe(10);
    expect(data.playable_paragraphs_count).toBe(5);
    expect(data.is_fully_ready).toBe(false);
    expect(data.playlist).toHaveLength(5);
    // Only the first 5 (paragraph_index 0..4) should be in playlist.
    expect(data.playlist.map((p: any) => p.paragraph_index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('every audio_url in playlist is a non-empty https URL', async () => {
    const res = await request(app)
      .get(`/api/v1/ebooks/${ebookId}/chapters/${chapterFullId}/audio-playlist`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const { playlist } = res.body.data;
    expect(playlist.length).toBeGreaterThan(0);
    for (const item of playlist) {
      expect(typeof item.audio_url).toBe('string');
      expect(item.audio_url.length).toBeGreaterThan(0);
      expect(item.audio_url.startsWith('https://')).toBe(true);
    }
  });

  it('total_duration_ms equals SUM of duration_ms across playlist items', async () => {
    const res = await request(app)
      .get(`/api/v1/ebooks/${ebookId}/chapters/${chapterPartialId}/audio-playlist`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const { total_duration_ms, playlist } = res.body.data;
    const sum = playlist.reduce((acc: number, p: any) => acc + (p.duration_ms ?? 0), 0);
    expect(total_duration_ms).toBe(sum);
    expect(total_duration_ms).toBe(5 * 1500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Re-verify chapter detail nullability contract
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/v1/ebooks/:id/chapters/:chapter_id — null-safety', () => {
  it('uses contract field names (`index` not `chapter_index`/`paragraph_index`)', async () => {
    const res = await request(app)
      .get(`/api/v1/ebooks/${ebookId}/chapters/${chapterEmptyId}`)
      .set('Authorization', `Bearer ${access_token}`);

    expect(res.status).toBe(200);
    const { chapter, paragraphs, progress } = res.body.data;

    // Chapter shape — contract field name is `index`
    expect(typeof chapter.id).toBe('string');
    expect(typeof chapter.index).toBe('number');
    expect(chapter).not.toHaveProperty('chapter_index');
    expect(typeof chapter.title).toBe('string');
    expect(typeof chapter.word_count).toBe('number');
    expect(typeof chapter.tts_status).toBe('string');
    expect(typeof chapter.tts_progress).toBe('number');

    // Paragraphs — contract field name is `index`. audio_url is string|null
    // (null when audio not generated yet — matches contract).
    expect(Array.isArray(paragraphs)).toBe(true);
    expect(paragraphs.length).toBeGreaterThan(0);
    for (const p of paragraphs) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.index).toBe('number');
      expect(p).not.toHaveProperty('paragraph_index');
      expect(typeof p.text).toBe('string');
      expect(typeof p.word_count).toBe('number');
      expect(typeof p.translation_vi).toBe('string'); // '' allowed, never null
      expect(p.audio_url === null || typeof p.audio_url === 'string').toBe(true);
      expect(typeof p.audio_status).toBe('string');
      expect(typeof p.duration_ms).toBe('number');    // 0 allowed, never null
    }

    expect(typeof progress.current_paragraph_index).toBe('number');
    expect(typeof progress.total_time_sec).toBe('number');
  });
});
