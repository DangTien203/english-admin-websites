module.exports = [
  {
    file: 'tests/leitner.test.ts',
    edits: [
      [
        `  it('box/1 returns all 5 cards with full entry shape', async () => {
    const res = await request(app)
      .get('/api/v1/leitner/box/1')
      .set('Authorization', \`Bearer \${access_token}\`);

    expect(res.status).toBe(200);
    expect(res.body.data.box_number).toBe(1);
    expect(res.body.data.total).toBe(5);
    expect(res.body.data.items).toHaveLength(5);`,
        `  it('box/1 returns every card that is in box 1, with the full entry shape', async () => {
    // Since the Leitner rewrite a correct practice answer moves a card that is already in a box to the NEXT box, so the second
    // practice session above leaves the 3 old cards in box 2 and only the 2 new words in box 1 (it used to leave all 5 in box 1).
    const { rows: inBox1 } = await pool.query(\`SELECT COUNT(*)::int AS n FROM leitner_cards WHERE user_id = $1 AND box_number = 1\`, [userId]);
    const { rows: inBox2 } = await pool.query(\`SELECT COUNT(*)::int AS n FROM leitner_cards WHERE user_id = $1 AND box_number = 2\`, [userId]);
    expect(inBox1[0].n + inBox2[0].n).toBe(5); // nothing was lost or duplicated
    expect(inBox1[0].n).toBeGreaterThan(0);

    const res = await request(app)
      .get('/api/v1/leitner/box/1')
      .set('Authorization', \`Bearer \${access_token}\`);

    expect(res.status).toBe(200);
    expect(res.body.data.box_number).toBe(1);
    expect(res.body.data.total).toBe(inBox1[0].n);
    expect(res.body.data.items).toHaveLength(inBox1[0].n);`,
      ],
      [
        `  it('correct=true from box 4 → box 5, mastered_now=true', async () => {
    await pool.query(
      \`UPDATE leitner_cards SET box_number = 4 WHERE id = $1\`,
      [targetCardId]
    );

    const res = await request(app)
      .post('/api/v1/leitner/review')
      .set('Authorization', \`Bearer \${access_token}\`)
      .send({ leitner_card_id: targetCardId, correct: true });

    expect(res.status).toBe(200);
    expect(res.body.data.new_box_number).toBe(5);
    expect(res.body.data.mastered_now).toBe(true);
  });

  it('correct=false from box 5 → box 1', async () => {
    // Card is already in box 5 from previous test
    const res = await request(app)
      .post('/api/v1/leitner/review')
      .set('Authorization', \`Bearer \${access_token}\`)
      .send({ leitner_card_id: targetCardId, correct: false });

    expect(res.status).toBe(200);
    expect(res.body.data.new_box_number).toBe(1);
    expect(res.body.data.mastered_now).toBe(false);

    // Verify DB
    const { rows } = await pool.query(
      \`SELECT box_number FROM leitner_cards WHERE id = $1\`,
      [targetCardId]
    );
    expect(rows[0].box_number).toBe(1);
  });`,
        `  // Box 4 and 5 are checked on BOTH meanings in a review session (POST /leitner/session/start); the single-answer endpoint
  // refuses them. (These two tests used to expect 4 -> 5 and 5 -> 1 from this endpoint.)
  it.each([4, 5])('a card in box %i is refused here with 409 REVIEW_SESSION_REQUIRED and stays where it is', async (box) => {
    await pool.query(\`UPDATE leitner_cards SET box_number = $2 WHERE id = $1\`, [targetCardId, box]);

    for (const body of [{ correct: true }, { correct: false }]) {
      const res = await request(app)
        .post('/api/v1/leitner/review')
        .set('Authorization', \`Bearer \${access_token}\`)
        .send({ leitner_card_id: targetCardId, ...body });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('REVIEW_SESSION_REQUIRED');
    }

    const { rows } = await pool.query(\`SELECT box_number FROM leitner_cards WHERE id = $1\`, [targetCardId]);
    expect(rows[0].box_number).toBe(box);
  });

  it('correct=false from box 3 → box 1', async () => {
    await pool.query(\`UPDATE leitner_cards SET box_number = 3 WHERE id = $1\`, [targetCardId]);

    const res = await request(app)
      .post('/api/v1/leitner/review')
      .set('Authorization', \`Bearer \${access_token}\`)
      .send({ leitner_card_id: targetCardId, correct: false });

    expect(res.status).toBe(200);
    expect(res.body.data.new_box_number).toBe(1);
    expect(res.body.data.mastered_now).toBe(false);

    const { rows } = await pool.query(
      \`SELECT box_number FROM leitner_cards WHERE id = $1\`,
      [targetCardId]
    );
    expect(rows[0].box_number).toBe(1);
  });`,
      ],
    ],
  },
];
