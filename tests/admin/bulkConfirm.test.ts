/**
 * The confirmation box of a bulk publish shows how many entries are about to go public and 5 of them picked at random
 * (public/js/lookup-bulk-confirm.js, drawn by public/js/lookup-admin.js). The logic is a plain function so that it is tested
 * here; that the page really carries the box is tested in lookupAdminP9.test.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const LookupBulk: {
  SAMPLE_SIZE: number;
  pickSample(items: any[], n: number, random?: () => number): any[];
  describeSelection(items: Array<{ id: string; headword: string }>, random?: () => number): { count: number; sample: string[]; others: number; title: string; lead: string; more: string; plain: string };
} = require('../../public/js/lookup-bulk-confirm.js');

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, headword: `word${i}` }));

/** A random() that returns the given values in turn. */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe('pickSample', () => {
  it('shows 5 by default', () => {
    expect(LookupBulk.SAMPLE_SIZE).toBe(5);
  });

  it('returns 5 DIFFERENT items out of many', () => {
    const picked = LookupBulk.pickSample(items(40), 5);
    expect(picked).toHaveLength(5);
    expect(new Set(picked.map((p) => p.id)).size).toBe(5);
  });

  it('returns all of them, once each, when there are fewer than asked for', () => {
    expect(LookupBulk.pickSample(items(3), 5).map((p) => p.id).sort()).toEqual(['id-0', 'id-1', 'id-2']);
    expect(LookupBulk.pickSample(items(5), 5)).toHaveLength(5);
  });

  it('returns nothing for an empty list or n = 0', () => {
    expect(LookupBulk.pickSample([], 5)).toEqual([]);
    expect(LookupBulk.pickSample(items(4), 0)).toEqual([]);
  });

  it('does not change the list it was given', () => {
    const list = items(12);
    const before = JSON.stringify(list);
    LookupBulk.pickSample(list, 5, Math.random);
    expect(JSON.stringify(list)).toBe(before);
  });

  it('draws with the random function it is given (a fixed sequence gives a fixed sample)', () => {
    const a = LookupBulk.pickSample(items(10), 3, sequence(0, 0, 0)).map((p) => p.id);
    expect(a).toEqual(['id-0', 'id-1', 'id-2']); // always the first of what is left
    const b = LookupBulk.pickSample(items(10), 3, sequence(0.99, 0.99, 0.99)).map((p) => p.id);
    expect(b).toEqual(['id-9', 'id-0', 'id-1']); // always the last of what is left (the copy is shuffled in place, so id-0 has moved to the end by the second draw)
  });

  it('survives a random() that returns 1 (out of its range)', () => {
    expect(LookupBulk.pickSample(items(4), 4, () => 1)).toHaveLength(4);
  });

  it('is really random: over many draws, items other than the first five turn up and every item can be chosen', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) for (const p of LookupBulk.pickSample(items(12), 5)) seen.add(p.id);
    expect(seen.size).toBe(12);
  });
});

describe('describeSelection', () => {
  it('says how many are selected and lists 5 headwords taken from the selection', () => {
    const chosen = items(23);
    const d = LookupBulk.describeSelection(chosen);
    expect(d.count).toBe(23);
    expect(d.sample).toHaveLength(5);
    expect(new Set(d.sample).size).toBe(5);
    for (const w of d.sample) expect(chosen.map((c) => c.headword)).toContain(w);
    expect(d.others).toBe(18);
    expect(d.lead).toContain('23 mục từ');
    expect(d.lead).toContain('5 mục lấy ngẫu nhiên');
    expect(d.more).toBe('và 18 mục khác.');
  });

  it('with 5 or fewer, shows all of them and has nothing to add', () => {
    const d = LookupBulk.describeSelection(items(3));
    expect(d.sample.sort()).toEqual(['word0', 'word1', 'word2']);
    expect(d.others).toBe(0);
    expect(d.more).toBe('');
    expect(d.lead).toContain('3 mục từ');
    expect(d.lead).toContain('toàn bộ các mục');
  });

  it('with exactly 5, shows all 5', () => {
    const d = LookupBulk.describeSelection(items(5));
    expect(d.sample).toHaveLength(5);
    expect(d.others).toBe(0);
  });

  it('the plain text for a browser without <dialog> carries the same facts', () => {
    const d = LookupBulk.describeSelection(items(9), sequence(0, 0, 0, 0, 0));
    expect(d.plain).toBe('Xuất bản 9 mục từ đã chọn?\nword0, word1, word2, word3, word4 và 4 mục khác');
    expect(LookupBulk.describeSelection(items(2)).plain).toMatch(/^Xuất bản 2 mục từ đã chọn\?\n(word0, word1|word1, word0)$/);
  });
});
