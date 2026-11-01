import pool from '../config/db';
import { paginate } from '../helpers/pagination';

const Deck = {
  async getAll({ search = '', level = '', status = '', type = 'all', page = 1, limit = 20 }: { search?: string; level?: string; status?: string; type?: 'all' | 'system' | 'user'; page?: number; limit?: number } = {}) {
    const conditions: string[] = [];
    const params: any[] = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`d.title ILIKE $${params.length}`);
    }
    if (level) {
      params.push(level);
      conditions.push(`d.level = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`d.status = $${params.length}`);
    }
    if (type === 'system') {
      conditions.push(`d.is_system = true`);
    } else if (type === 'user') {
      conditions.push(`d.is_system = false`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const n = params.length;

    // System decks always sort by sort_order; user decks irrelevant to that ordering.
    // For 'all' / 'system' views, surface system decks first (is_system DESC) so admins can manage their order.
    const orderBy =
      type === 'user'
        ? 'd.created_at DESC'
        : 'd.is_system DESC, d.sort_order ASC, d.created_at DESC';

    const query = `
      SELECT d.id, d.title, d.level, d.deck_type, d.status, d.min_cards_to_study,
             d.is_system, d.sort_order, d.created_at,
             a.full_name AS creator_name,
             (SELECT COUNT(*)::int FROM cards c WHERE c.deck_id = d.id) AS card_count
      FROM decks d
      LEFT JOIN admin_accounts a ON a.id = d.created_by
      ${where}
      ORDER BY ${orderBy}
      LIMIT $${n + 1} OFFSET $${n + 2}`;
    const countQuery = `SELECT COUNT(*)::int AS count FROM decks d ${where}`;

    return paginate(query, countQuery, params, params, page, limit);
  },

  async findById(id: string) {
    const { rows } = await pool.query(`
      SELECT d.*,
             a.full_name AS creator_name,
             COALESCE(
               json_agg(DISTINCT jsonb_build_object('id', t.id, 'name', t.name))
               FILTER (WHERE t.id IS NOT NULL), '[]'
             ) AS tags
      FROM decks d
      LEFT JOIN admin_accounts a  ON a.id  = d.created_by
      LEFT JOIN deck_tags dt      ON dt.deck_id = d.id
      LEFT JOIN tags t            ON t.id = dt.tag_id
      WHERE d.id = $1
      GROUP BY d.id, a.full_name`,
      [id]
    );
    if (!rows[0]) return null;

    // Fetch cards separately (cleaner than nested agg)
    const { rows: cards } = await pool.query(`
      SELECT c.id AS card_id, c.entry_id, c.note_html, c.sort_order,
             de.headword, de.lemma, de.ipa_us, de.meaning_vi
      FROM cards c
      JOIN dictionary_entries de ON de.id = c.entry_id
      WHERE c.deck_id = $1
      ORDER BY c.sort_order ASC, de.headword ASC`,
      [id]
    );

    return { ...rows[0], cards };
  },

  async create(data: any, tagIds: string[] = []) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        INSERT INTO decks
          (title, description, level, thumbnail_url, deck_type, min_cards_to_study, status, sort_order, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *`,
        [
          data.title.trim(),
          data.description || null,
          data.level || 'beginner',
          data.thumbnail_url || null,
          data.deck_type || 'premade',
          data.min_cards_to_study ? parseInt(data.min_cards_to_study) : 5,
          data.status || 'draft',
          Number.isFinite(parseInt(data.sort_order)) ? parseInt(data.sort_order) : 0,
          data.created_by || null,
        ]
      );
      const deck = rows[0];
      if (tagIds.length > 0) {
        await client.query(
          'INSERT INTO deck_tags (deck_id, tag_id) SELECT $1, t FROM unnest($2::uuid[]) AS t ON CONFLICT DO NOTHING',
          [deck.id, tagIds]
        );
      }
      await client.query('COMMIT');
      return deck;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async update(id: string, data: any, tagIds: string[] = []) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        UPDATE decks SET
          title              = $1,
          description        = $2,
          level              = $3,
          thumbnail_url      = $4,
          deck_type          = $5,
          min_cards_to_study = $6,
          status             = $7,
          sort_order         = $8,
          updated_at         = NOW()
        WHERE id = $9`,
        [
          data.title.trim(),
          data.description || null,
          data.level || 'beginner',
          data.thumbnail_url || null,
          data.deck_type || 'premade',
          data.min_cards_to_study ? parseInt(data.min_cards_to_study) : 5,
          data.status || 'draft',
          Number.isFinite(parseInt(data.sort_order)) ? parseInt(data.sort_order) : 0,
          id,
        ]
      );
      await client.query('DELETE FROM deck_tags WHERE deck_id = $1', [id]);
      if (tagIds.length > 0) {
        await client.query(
          'INSERT INTO deck_tags (deck_id, tag_id) SELECT $1, t FROM unnest($2::uuid[]) AS t ON CONFLICT DO NOTHING',
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
    // CASCADE on cards, and user_card_progress cascades from cards
    await pool.query('DELETE FROM decks WHERE id = $1', [id]);
  },

  async addCards(deckId: string, entryIds: string[] = []) {
    if (entryIds.length === 0) return { added: 0, skipped: 0 };

    // ONE statement for the whole batch. It used to read the highest sort_order and insert for EVERY entry (two round trips each:
    // adding 100 words to a deck took about 12 seconds against the remote database). The new cards are numbered one after another from
    // the highest position, in the order given; entries already in the deck, and repeats within the batch, are skipped and use no number.
    const { rowCount } = await pool.query(
      `INSERT INTO cards (deck_id, entry_id, sort_order)
       SELECT $1::uuid, n.entry_id, base.max_order + ROW_NUMBER() OVER (ORDER BY n.ord)
         FROM (SELECT t.entry_id, MIN(t.ord) AS ord
                 FROM unnest($2::uuid[]) WITH ORDINALITY AS t(entry_id, ord)
                WHERE NOT EXISTS (SELECT 1 FROM cards c WHERE c.deck_id = $1::uuid AND c.entry_id = t.entry_id)
                GROUP BY t.entry_id) n
        CROSS JOIN (SELECT COALESCE(MAX(sort_order), -1)::int AS max_order FROM cards WHERE deck_id = $1::uuid) base
       ON CONFLICT (deck_id, entry_id) DO NOTHING`,
      [deckId, entryIds]
    );
    const added = rowCount ?? 0;
    return { added, skipped: entryIds.length - added };
  },

  async removeCard(deckId: string, entryId: string) {
    await pool.query(
      'DELETE FROM cards WHERE deck_id = $1 AND entry_id = $2',
      [deckId, entryId]
    );
  },

  /**
   * Move a system deck up or down in the admin-controlled display order.
   *
   * Display order on mobile /decks/system: ORDER BY sort_order ASC, created_at DESC.
   * "Up" = appear earlier (smaller sort_order, or same sort_order with newer created_at).
   *
   * Returns:
   *   { ok: true, swapped: true }  → swap succeeded
   *   { ok: true, swapped: false } → already at top/bottom (no neighbor)
   *   { ok: false, reason: 'NOT_FOUND' | 'NOT_SYSTEM' }
   */
  async reorder(deckId: string, direction: 'up' | 'down'): Promise<
    | { ok: true; swapped: boolean }
    | { ok: false; reason: 'NOT_FOUND' | 'NOT_SYSTEM' }
  > {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: curRows } = await client.query(
        `SELECT id, is_system, sort_order, created_at FROM decks WHERE id = $1 FOR UPDATE`,
        [deckId]
      );
      if (!curRows[0]) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'NOT_FOUND' };
      }
      const current = curRows[0];
      if (!current.is_system) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'NOT_SYSTEM' };
      }

      // Find the neighbor in the requested direction.
      // Up   = (sort_order < current) OR (sort_order = current AND created_at > current.created_at)
      // Down = (sort_order > current) OR (sort_order = current AND created_at < current.created_at)
      const targetSql =
        direction === 'up'
          ? `SELECT id, sort_order FROM decks
              WHERE is_system = true
                AND id <> $1
                AND (
                  sort_order < $2
                  OR (sort_order = $2 AND created_at > $3)
                )
              ORDER BY sort_order DESC, created_at ASC
              LIMIT 1
              FOR UPDATE`
          : `SELECT id, sort_order FROM decks
              WHERE is_system = true
                AND id <> $1
                AND (
                  sort_order > $2
                  OR (sort_order = $2 AND created_at < $3)
                )
              ORDER BY sort_order ASC, created_at DESC
              LIMIT 1
              FOR UPDATE`;

      const { rows: tgtRows } = await client.query(targetSql, [
        current.id,
        current.sort_order,
        current.created_at,
      ]);

      if (!tgtRows[0]) {
        await client.query('COMMIT');
        return { ok: true, swapped: false };
      }
      const target = tgtRows[0];

      if (current.sort_order === target.sort_order) {
        // Tie-broken by created_at — push the OTHER side to differentiate.
        // Up:   bump target to current+1 so current floats above it.
        // Down: bump current to target+1 so current sinks below it.
        if (direction === 'up') {
          await client.query(
            `UPDATE decks SET sort_order = $1 WHERE id = $2`,
            [current.sort_order + 1, target.id]
          );
        } else {
          await client.query(
            `UPDATE decks SET sort_order = $1 WHERE id = $2`,
            [current.sort_order + 1, current.id]
          );
        }
      } else {
        // Different sort_order — clean swap.
        await client.query(
          `UPDATE decks SET sort_order = $1 WHERE id = $2`,
          [target.sort_order, current.id]
        );
        await client.query(
          `UPDATE decks SET sort_order = $1 WHERE id = $2`,
          [current.sort_order, target.id]
        );
      }

      await client.query('COMMIT');
      return { ok: true, swapped: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

export = Deck;
