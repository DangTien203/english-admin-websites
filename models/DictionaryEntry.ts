import pool from '../config/db';
import { paginate } from '../helpers/pagination';

const DictionaryEntry = {
  async getAll({ search = '', pos = '', cefrLevel = '', source = '', published = '', page = 1, limit = 20 }: { search?: string; pos?: string; cefrLevel?: string; source?: string; published?: string; page?: number; limit?: number } = {}) {
    const conditions: string[] = [];
    const params: any[] = [];

    if (search) {
      params.push(`%${search}%`);
      params.push(`%${search}%`);
      conditions.push(`(headword ILIKE $${params.length - 1} OR meaning_vi ILIKE $${params.length})`);
    }
    if (pos) {
      params.push(pos);
      conditions.push(`$${params.length} = ANY(pos)`);
    }
    if (cefrLevel) {
      params.push(cefrLevel);
      conditions.push(`cefr_level = $${params.length}`);
    }
    if (source) {
      params.push(source);
      conditions.push(`source = $${params.length}`);
    }
    if (published !== '') {
      params.push(published === 'true');
      conditions.push(`published = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const n = params.length;

    const query = `
      SELECT id, headword, lemma, ipa_us, pos, meaning_vi, cefr_level, source, published, created_at
      FROM dictionary_entries
      ${where}
      ORDER BY headword ASC
      LIMIT $${n + 1} OFFSET $${n + 2}`;
    const countQuery = `SELECT COUNT(*)::int AS count FROM dictionary_entries ${where}`;

    return paginate(query, countQuery, params, params, page, limit);
  },

  async findById(id: string) {
    const { rows } = await pool.query(`
      SELECT de.*,
             COALESCE(
               json_agg(DISTINCT jsonb_build_object('id', t.id, 'name', t.name))
               FILTER (WHERE t.id IS NOT NULL), '[]'
             ) AS tags,
             COALESCE(
               json_agg(DISTINCT jsonb_build_object('id', s.id, 'headword', s.headword))
               FILTER (WHERE s.id IS NOT NULL), '[]'
             ) AS synonyms,
             COALESCE(
               json_agg(DISTINCT jsonb_build_object('id', an.id, 'headword', an.headword))
               FILTER (WHERE an.id IS NOT NULL), '[]'
             ) AS antonyms
      FROM dictionary_entries de
      LEFT JOIN entry_tags et       ON et.entry_id   = de.id
      LEFT JOIN tags t              ON t.id           = et.tag_id
      LEFT JOIN entry_synonyms esyn ON esyn.entry_id  = de.id
      LEFT JOIN dictionary_entries s ON s.id          = esyn.synonym_id
      LEFT JOIN entry_antonyms ean  ON ean.entry_id   = de.id
      LEFT JOIN dictionary_entries an ON an.id        = ean.antonym_id
      WHERE de.id = $1
      GROUP BY de.id`,
      [id]
    );
    return rows[0] || null;
  },

  async findByHeadwordLemma(headword: string, lemma: string) {
    const { rows } = await pool.query(
      'SELECT id FROM dictionary_entries WHERE headword = $1 AND lemma = $2',
      [headword, lemma]
    );
    return rows[0] || null;
  },

  async create(data: any, tagIds: string[] = []) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        INSERT INTO dictionary_entries
          (headword, lemma, ipa_us, ipa_uk, audio_us_url, audio_uk_url, pos,
           meaning_vi, meaning_en, example_en, example_vi, cefr_level,
           frequency_rank, source, admin_note, published, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        RETURNING *`,
        [
          data.headword.trim().toLowerCase(),
          data.lemma.trim().toLowerCase(),
          data.ipa_us || null,
          data.ipa_uk || null,
          data.audio_us_url || null,
          data.audio_uk_url || null,
          data.pos || [],
          data.meaning_vi,
          data.meaning_en || null,
          data.example_en || null,
          data.example_vi || null,
          data.cefr_level || null,
          data.frequency_rank ? parseInt(data.frequency_rank) : null,
          data.source || 'manual',
          data.admin_note || null,
          data.published !== false && data.published !== 'false',
          data.created_by || null,
        ]
      );
      const entry = rows[0];
      for (const tid of tagIds) {
        await client.query(
          'INSERT INTO entry_tags (entry_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [entry.id, tid]
        );
      }
      await client.query('COMMIT');
      return entry;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * `adminId` (optional) is who saves the form: a change of `published` is then written to entry_edit_history in the same
   * transaction, like the publish / hide buttons of the review pages (/lookup/review).
   * `published` is the checkbox of the form: ticked → true; unticked (the field is absent) → false.
   */
  async update(id: string, data: any, tagIds: string[] = [], adminId?: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const published = data.published === true || data.published === 'true' || data.published === 'on';
      const before = await client.query('SELECT published FROM dictionary_entries WHERE id = $1 FOR UPDATE', [id]);
      await client.query(`
        UPDATE dictionary_entries SET
          headword       = $1,
          lemma          = $2,
          ipa_us         = $3,
          ipa_uk         = $4,
          audio_us_url   = $5,
          audio_uk_url   = $6,
          pos            = $7,
          meaning_vi     = $8,
          meaning_en     = $9,
          example_en     = $10,
          example_vi     = $11,
          cefr_level     = $12,
          frequency_rank = $13,
          source         = $14,
          admin_note     = $15,
          published      = $16,
          updated_at     = NOW()
        WHERE id = $17`,
        [
          data.headword.trim().toLowerCase(),
          data.lemma.trim().toLowerCase(),
          data.ipa_us || null,
          data.ipa_uk || null,
          data.audio_us_url || null,
          data.audio_uk_url || null,
          data.pos || [],
          data.meaning_vi,
          data.meaning_en || null,
          data.example_en || null,
          data.example_vi || null,
          data.cefr_level || null,
          data.frequency_rank ? parseInt(data.frequency_rank) : null,
          data.source || 'manual',
          data.admin_note || null,
          published,
          id,
        ]
      );
      if (before.rows[0] && before.rows[0].published !== published) {
        await client.query(
          `INSERT INTO entry_edit_history (entry_id, admin_id, field_name, old_value, new_value)
           VALUES ($1, $2, 'published', $3, $4)`,
          [id, adminId ?? null, String(before.rows[0].published), String(published)]
        );
      }
      await client.query('DELETE FROM entry_tags WHERE entry_id = $1', [id]);
      for (const tid of tagIds) {
        await client.query(
          'INSERT INTO entry_tags (entry_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [id, tid]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async delete(id: string) {
    await pool.query('DELETE FROM dictionary_entries WHERE id = $1', [id]);
  },

  async importFromJson(jsonArray: any[], adminId: string) {
    let inserted = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const item of jsonArray) {
      if (!item.headword || !item.lemma || !item.meaning_vi) {
        errors.push(`Thiếu trường bắt buộc: ${JSON.stringify(item)}`);
        continue;
      }
      try {
        const { rowCount } = await pool.query(`
          INSERT INTO dictionary_entries
            (headword, lemma, ipa_us, ipa_uk, pos, meaning_vi, meaning_en,
             example_en, example_vi, cefr_level, frequency_rank, source, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (headword, lemma) DO NOTHING`,
          [
            String(item.headword).trim().toLowerCase(),
            String(item.lemma).trim().toLowerCase(),
            item.ipa_us || null,
            item.ipa_uk || null,
            Array.isArray(item.pos) ? item.pos : [],
            item.meaning_vi,
            item.meaning_en || null,
            item.example_en || null,
            item.example_vi || null,
            item.cefr_level || null,
            item.frequency_rank ? parseInt(item.frequency_rank) : null,
            item.source || 'manual',
            adminId,
          ]
        );
        if (rowCount > 0) inserted++;
        else skipped++;
      } catch (err) {
        const error = err as Error;
        errors.push(`${item.headword}/${item.lemma}: ${error.message}`);
      }
    }
    return { inserted, skipped, errors };
  },

  async count() {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM dictionary_entries');
    return rows[0].count;
  },

  async countMissingIpa() {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM dictionary_entries WHERE ipa_us IS NULL OR ipa_uk IS NULL`
    );
    return rows[0].count;
  },

  async getAllTags() {
    const { rows } = await pool.query('SELECT id, name FROM tags ORDER BY name');
    return rows;
  },
};

export = DictionaryEntry;
