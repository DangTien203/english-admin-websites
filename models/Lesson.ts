import pool from '../config/db';
import { paginate } from '../helpers/pagination';

const Lesson = {
  async getAll({ search = '', level = '', status = '', page = 1, limit = 20 }: { search?: string; level?: string; status?: string; page?: number; limit?: number } = {}) {
    const conditions: string[] = [];
    const params: any[] = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`l.title ILIKE $${params.length}`);
    }
    if (level) {
      params.push(level);
      conditions.push(`l.level = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`l.status = $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const n = params.length;

    const query = `
      SELECT l.id, l.title, l.level, l.status, l.sort_order, l.created_at,
             a.full_name AS creator_name,
             (SELECT COUNT(*)::int FROM lesson_entries le WHERE le.lesson_id = l.id) AS entry_count
      FROM lessons l
      LEFT JOIN admin_accounts a ON a.id = l.created_by
      ${where}
      ORDER BY l.sort_order ASC, l.created_at DESC
      LIMIT $${n + 1} OFFSET $${n + 2}`;
    const countQuery = `SELECT COUNT(*)::int AS count FROM lessons l ${where}`;

    return paginate(query, countQuery, params, params, page, limit);
  },

  async findById(id: string) {
    const { rows } = await pool.query(`
      SELECT l.*,
             a.full_name AS creator_name,
             COALESCE(
               json_agg(DISTINCT jsonb_build_object('id', t.id, 'name', t.name))
               FILTER (WHERE t.id IS NOT NULL), '[]'
             ) AS tags,
             COALESCE(
               json_agg(DISTINCT jsonb_build_object(
                 'id', de.id,
                 'headword', de.headword,
                 'meaning_vi', de.meaning_vi,
                 'sort_order', le.sort_order
               ))
               FILTER (WHERE de.id IS NOT NULL), '[]'
             ) AS entries
      FROM lessons l
      LEFT JOIN admin_accounts a  ON a.id  = l.created_by
      LEFT JOIN lesson_tags lt    ON lt.lesson_id = l.id
      LEFT JOIN tags t            ON t.id = lt.tag_id
      LEFT JOIN lesson_entries le ON le.lesson_id = l.id
      LEFT JOIN dictionary_entries de ON de.id = le.entry_id
      WHERE l.id = $1
      GROUP BY l.id, a.full_name`,
      [id]
    );
    return rows[0] || null;
  },

  async create(data: any, entryIds: string[] = [], tagIds: string[] = []) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        INSERT INTO lessons
          (title, description, content_html, level, thumbnail_url, status,
           publish_at, sort_order, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *`,
        [
          data.title.trim(),
          data.description || null,
          data.content_html || null,
          data.level || 'beginner',
          data.thumbnail_url || null,
          data.status || 'draft',
          data.publish_at || null,
          data.sort_order ? parseInt(data.sort_order) : 0,
          data.created_by || null,
        ]
      );
      const lesson = rows[0];

      // One statement for all the entries (in the order given, position = index) and one for all the tags — not one per row.
      if (entryIds.length > 0) {
        await client.query(
          `INSERT INTO lesson_entries (lesson_id, entry_id, sort_order)
         SELECT $1, t.entry_id, t.ord - 1 FROM unnest($2::uuid[]) WITH ORDINALITY AS t(entry_id, ord)
         ON CONFLICT DO NOTHING`,
          [lesson.id, entryIds]
        );
      }
      if (tagIds.length > 0) {
        await client.query(
          'INSERT INTO lesson_tags (lesson_id, tag_id) SELECT $1, t FROM unnest($2::uuid[]) AS t ON CONFLICT DO NOTHING',
          [lesson.id, tagIds]
        );
      }
      await client.query('COMMIT');
      return lesson;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async update(id: string, data: any, entryIds: string[] = [], tagIds: string[] = []) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        UPDATE lessons SET
          title        = $1,
          description  = $2,
          content_html = $3,
          level        = $4,
          thumbnail_url = $5,
          status       = $6,
          publish_at   = $7,
          sort_order   = $8,
          updated_at   = NOW()
        WHERE id = $9`,
        [
          data.title.trim(),
          data.description || null,
          data.content_html || null,
          data.level || 'beginner',
          data.thumbnail_url || null,
          data.status || 'draft',
          data.publish_at || null,
          data.sort_order ? parseInt(data.sort_order) : 0,
          id,
        ]
      );

      await client.query('DELETE FROM lesson_entries WHERE lesson_id = $1', [id]);
      if (entryIds.length > 0) {
        await client.query(
          `INSERT INTO lesson_entries (lesson_id, entry_id, sort_order)
         SELECT $1, t.entry_id, t.ord - 1 FROM unnest($2::uuid[]) WITH ORDINALITY AS t(entry_id, ord)
         ON CONFLICT DO NOTHING`,
          [id, entryIds]
        );
      }

      await client.query('DELETE FROM lesson_tags WHERE lesson_id = $1', [id]);
      if (tagIds.length > 0) {
        await client.query(
          'INSERT INTO lesson_tags (lesson_id, tag_id) SELECT $1, t FROM unnest($2::uuid[]) AS t ON CONFLICT DO NOTHING',
          [id, tagIds]
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
    await pool.query('DELETE FROM lessons WHERE id = $1', [id]);
  },
};

export = Lesson;
