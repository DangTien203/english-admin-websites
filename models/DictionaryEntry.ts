import pool from '../config/db';
import { paginate } from '../helpers/pagination';

/** The "Published" checkbox of a form: ticked → true. An unticked box sends no field at all, so absent means false. */
const isTicked = (value: unknown): boolean => value === true || value === 'true' || value === 'on';

const DictionaryEntry = {
  /** The "Published" checkbox of a form: ticked → true. Exposed so that a controller can tell what the form ASKED for. */
  isTicked,

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

  /**
   * `published` is the checkbox of the form (ticked → true, absent → false). `options.published = false` OVERRIDES it: the entry is
   * created hidden whatever the form said (the creator is a role that may not publish, canChangePublished).
   */
  async create(data: any, tagIds: string[] = [], options: { published?: false } = {}) {
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
          options.published === false ? false : isTicked(data.published),
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
   * `keepPublished` (the editor is a role that may not change `published`, canChangePublished): the field of the form is ignored,
   * the stored value stays and no history line is written. The result says when something was asked that this ignored.
   */
  async update(id: string, data: any, tagIds: string[] = [], adminId?: string, options: { keepPublished?: boolean } = {}): Promise<{ ignoredPublished: { requested: boolean; stored: boolean } | null }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const before = await client.query('SELECT published FROM dictionary_entries WHERE id = $1 FOR UPDATE', [id]);
      const stored: boolean | undefined = before.rows[0]?.published;
      const published = options.keepPublished && stored !== undefined ? stored : isTicked(data.published);
      const ignoredPublished =
        options.keepPublished && stored !== undefined && data.published !== undefined && isTicked(data.published) !== stored
          ? { requested: isTicked(data.published), stored }
          : null;
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
      return { ignoredPublished };
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
