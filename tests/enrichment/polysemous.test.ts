import { generateDraft, type DraftFailure, type DraftResult } from '../../services/enrichment/draft';
import type { HaikuCaller, HaikuResponse } from '../../services/enrichment/haiku/client';
import { DraftSchema, LIMITS, type Sense } from '../../services/enrichment/haiku/schema';
import { validateDraft } from '../../services/enrichment/haiku/validators';
import { makeBundle, makeDraft, makeSense } from './fixtures';

/**
 * Highly polysemous function words (`out`, `you`) used to end every job as failed / invalid_output:
 *   out → senses: schema_too_big (more than 6 senses)
 *   you → senses[0].meanings_vi[1]: classifier_duplicate (and, on the first answer, meanings_vi: schema_too_big)
 * validateDraft() now KEEPS the first LIMITS.senses senses / LIMITS.meaningsPerSense meanings and DROPS the later of two meanings
 * that differ only by a classifier, with a "[kiểm tra]" note, and every other rule of spec §9.7 stays an error.
 *
 * The drafts below are hand-written fixtures shaped like what Haiku returned for the two words. Nothing here calls Anthropic:
 * the HaikuCaller is a stub that returns the fixture.
 */

const example = (en: string, vi: string) => [{ example_en: en, example_vi: vi }];

/** Eight senses of `out` (adverb and preposition), most common first: two more than the schema allows. */
function outSenses(): Sense[] {
  const s = (over: Partial<Sense>) =>
    makeSense({ pos: 'adverb', examples: example('He went out for a walk.', 'Anh ấy ra ngoài đi dạo.'), ...over });
  return [
    s({ definition_en: 'away from the inside of a place', meanings_vi: ['ra ngoài', 'ra', 'bên ngoài'] }),
    s({ definition_en: 'not at home or at your usual place of work', meanings_vi: ['đi vắng', 'không có nhà'], examples: example('She is out at the moment.', 'Hiện giờ cô ấy đang đi vắng.') }),
    s({ definition_en: 'no longer burning or shining', meanings_vi: ['tắt', 'hết cháy'], examples: example('The lights went out.', 'Đèn đã tắt.') }),
    s({ definition_en: 'completely, to the end', meanings_vi: ['hết', 'hoàn toàn'], examples: example('Sort the problem out.', 'Hãy giải quyết xong vấn đề.') }),
    s({ definition_en: 'available to the public', meanings_vi: ['phát hành', 'ra mắt'], examples: example('The new album is out now.', 'Album mới đã phát hành.') }),
    s({ pos: 'preposition', definition_en: 'from inside something', meanings_vi: ['ra khỏi', 'từ trong'], examples: example('He took a pen out of his bag.', 'Anh ấy lấy một cây bút ra khỏi túi.') }),
    s({ pos: 'preposition', definition_en: 'because of a feeling', meanings_vi: ['vì', 'do'], examples: example('She helped out of kindness.', 'Cô ấy giúp vì lòng tốt.') }),
    s({ pos: 'preposition', definition_en: 'made from a material', meanings_vi: ['làm từ', 'bằng'], examples: example('The statue is carved out of marble.', 'Bức tượng được tạc từ đá cẩm thạch.') }),
  ];
}

const outDraft = () =>
  makeDraft({
    headword: 'out', lemma: 'out', pos: ['adverb', 'preposition'], cefr_level: 'A1', is_countable: null, topics: ['core_language'],
    senses: outSenses(),
  });

/** `you`: six renderings in the first sense (one more than allowed after cleaning), and "bạn" / "các bạn" collide. */
const youDraft = () =>
  makeDraft({
    headword: 'you', lemma: 'you', pos: ['pronoun'], cefr_level: 'A1', is_countable: null, topics: ['core_language', 'greetings_social'],
    senses: [
      makeSense({
        pos: 'pronoun',
        definition_en: 'the person or people being spoken or written to',
        meanings_vi: ['bạn', 'các bạn', 'anh', 'chị', 'em', 'ông'],
        examples: example('Can you help me?', 'Bạn có thể giúp tôi không?'),
      }),
      makeSense({
        pos: 'pronoun',
        definition_en: 'people in general, including the speaker',
        meanings_vi: ['người ta', 'người', 'một người'],
        examples: example('You never know what will happen.', 'Người ta không bao giờ biết điều gì sẽ xảy ra.'),
      }),
    ],
  });

/** `out` with the given senses. */
const outWith = (senses: Sense[]) => ({ ...outDraft(), senses });

const ctxFor = (word: string) => ({ word, expectedLemma: word });
const codes = (r: ReturnType<typeof validateDraft>) => r.issues.map((i) => `${i.path}:${i.code}`);

function reply(body: unknown): HaikuResponse {
  return {
    text: JSON.stringify(body),
    stopReason: 'end_turn',
    refusalCategory: null,
    usage: { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    requestId: 'req_1',
    model: 'test-model',
  };
}

// strictNullChecks is off in this project, so `if (r.ok)` does not narrow the union: assert the failure explicitly.
function asFailure(r: DraftResult): DraftFailure {
  if (r.ok) throw new Error('expected a failed draft');
  return r as DraftFailure;
}

function stub(...replies: HaikuResponse[]) {
  let calls = 0;
  const caller: HaikuCaller = async () => {
    const next = replies[calls++];
    if (!next) throw new Error('no more replies');
    return next;
  };
  return { caller, calls: () => calls };
}

describe('more senses than the limit (out)', () => {
  it('the fixture really is over the limit', () => {
    expect(outSenses()).toHaveLength(8);
    expect(LIMITS.senses).toBe(6);
  });

  it('validates into a usable draft with the 6 first senses, in order, and a note', () => {
    const r = validateDraft(outDraft(), ctxFor('out'));
    expect(r.issues).toEqual([]);
    expect(r.draft.senses).toHaveLength(LIMITS.senses);
    expect(r.draft.senses.map((s) => s.definition_en)).toEqual(outSenses().slice(0, 6).map((s) => s.definition_en));
    expect(r.draft.notes_for_review).toEqual([expect.stringMatching(/^\[kiểm tra\] .*8 sense.*chỉ giữ 6 sense đầu tiên/)]);
  });

  it('derives pos from the senses that are kept, not the ones that were cut', () => {
    const base = outSenses().slice(0, 5).map((s) => ({ ...s, pos: 'adverb' as const }));
    const prepositions = outSenses().slice(5).map((s) => ({ ...s, pos: 'preposition' as const }));
    // 5 adverb senses, 3 preposition senses: only the first preposition survives the cut
    const r = validateDraft(outWith([...base, ...prepositions]), ctxFor('out'));
    expect(r.issues).toEqual([]);
    expect(r.draft.pos).toEqual(['adverb', 'preposition']);
    expect(r.draft.senses.filter((s) => s.pos === 'preposition')).toHaveLength(1);
    // all 8 adverb senses: the preposition the model declared in `pos` is gone
    const adverbs = validateDraft(outWith(Array.from({ length: 8 }, (_, i) => ({ ...outSenses()[i], pos: 'adverb' as const }))), ctxFor('out'));
    expect(adverbs.draft.pos).toEqual(['adverb']);
  });

  it('exactly 6 senses is untouched and gets no note', () => {
    const r = validateDraft(outWith(outSenses().slice(0, 6)), ctxFor('out'));
    expect(r.issues).toEqual([]);
    expect(r.draft.senses).toHaveLength(6);
    expect(r.draft.notes_for_review).toEqual([]);
  });

  it('does not validate (or fail on) a sense that is cut: it is never used', () => {
    const senses = outSenses();
    senses[7] = { ...senses[7], meanings_vi: ['làm từ (chất liệu)'], definition_en: '' };
    const r = validateDraft(outWith(senses), ctxFor('out'));
    expect(r.issues).toEqual([]);
  });

  it('but a bad sense INSIDE the first 6 still fails, with the model\'s own index', () => {
    const senses = outSenses();
    senses[4] = { ...senses[4], meanings_vi: ['phát hành (ra mắt)'] };
    expect(codes(validateDraft(outWith(senses), ctxFor('out')))).toEqual(['senses[4].meanings_vi[0]:parenthesis']);
  });

  it('end to end: one Haiku call, no repair, an entry-ready draft', async () => {
    const { caller, calls } = stub(reply(outDraft()));
    const r = await generateDraft(makeBundle({ word: 'out', expectedLemma: 'out' }), { haiku: caller });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls()).toBe(1);
    expect(r.repaired).toBe(false);
    expect(r.draft.senses).toHaveLength(6);
    expect(r.draft.lemma).toBe('out');
  });
});

describe('more meanings than the limit, and classifier collisions (you)', () => {
  it('the zod schema no longer rejects either shape', () => {
    expect(DraftSchema.safeParse(youDraft()).success).toBe(true);
  });

  it('validates into a usable draft: "các bạn" is dropped, the rest is cut to 4, first ones kept', () => {
    const r = validateDraft(youDraft(), ctxFor('you'));
    expect(r.issues).toEqual([]);
    // bạn, [các bạn dropped], anh, chị, em, [ông cut]
    expect(r.draft.senses[0].meanings_vi).toEqual(['bạn', 'anh', 'chị', 'em']);
    expect(r.draft.senses[0].meanings_vi.length).toBeLessThanOrEqual(LIMITS.meaningsPerSense);
    const notes = r.draft.notes_for_review.join('\n');
    expect(notes).toMatch(/senses\[0\]\.meanings_vi\[1\] "các bạn" chỉ khác "bạn"/);
    expect(notes).toMatch(/senses\[0\]\.meanings_vi: Haiku viết 5 nghĩa, chỉ giữ 4 nghĩa đầu tiên/);
  });

  it('keeps the earlier (more common) meaning and drops the later one, whichever has the classifier', () => {
    const r = validateDraft(youDraft(), ctxFor('you'));
    // sense 1: người ta, người, [một người dropped]
    expect(r.draft.senses[1].meanings_vi).toEqual(['người ta', 'người']);
    const reversed = validateDraft(makeDraft({ headword: 'you', lemma: 'you', senses: [makeSense({ meanings_vi: ['một người', 'người'] })] }), ctxFor('you'));
    expect(reversed.issues).toEqual([]);
    expect(reversed.draft.senses[0].meanings_vi).toEqual(['một người']);
  });

  it('end to end: one Haiku call, no repair', async () => {
    const { caller, calls } = stub(reply(youDraft()));
    const r = await generateDraft(makeBundle({ word: 'you', expectedLemma: 'you' }), { haiku: caller });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls()).toBe(1);
    expect(r.repaired).toBe(false);
    expect(r.draft.senses[0].meanings_vi).toEqual(['bạn', 'anh', 'chị', 'em']);
  });
});

describe('what stays strict', () => {
  const sense = (meanings_vi: string[]) => makeDraft({ headword: 'you', lemma: 'you', senses: [makeSense({ meanings_vi })] });

  it('keeps at least one meaning when every meaning is a classifier variant of the first', () => {
    const r = validateDraft(sense(['mèo', 'con mèo', 'cái mèo', 'một mèo']), ctxFor('you'));
    expect(r.issues).toEqual([]);
    expect(r.draft.senses[0].meanings_vi).toEqual(['mèo']);
  });

  it('drops every repeat of a dropped variant, not just the first', () => {
    const r = validateDraft(sense(['mèo', 'con mèo', 'con mèo']), ctxFor('you'));
    expect(r.issues).toEqual([]);
    expect(r.draft.senses[0].meanings_vi).toEqual(['mèo']);
  });

  it('an exact duplicate is still an error', () => {
    expect(codes(validateDraft(sense(['bạn', 'Bạn ', 'anh']), ctxFor('you')))).toEqual(['senses[0].meanings_vi[1]:duplicate']);
  });

  it('the other meaning rules still fail a meaning that is kept (path = the model\'s own index)', () => {
    // 'các bạn' (index 1) is dropped; 'anh (nam)' is index 2 in the model's JSON, so the repair request can quote it
    expect(codes(validateDraft(sense(['bạn', 'các bạn', 'anh (nam)']), ctxFor('you')))).toEqual(['senses[0].meanings_vi[2]:parenthesis']);
    expect(codes(validateDraft(sense(['bạn', 'một hai ba bốn năm sáu bảy']), ctxFor('you')))).toEqual(['senses[0].meanings_vi[1]:too_many_syllables']);
  });

  it('a dropped duplicate does not use up one of the 4 places', () => {
    const r = validateDraft(sense(['bạn', 'các bạn', 'anh', 'chị', 'em']), ctxFor('you'));
    expect(r.issues).toEqual([]);
    expect(r.draft.senses[0].meanings_vi).toEqual(['bạn', 'anh', 'chị', 'em']);
    expect(r.draft.notes_for_review.some((n) => /chỉ giữ 4 nghĩa/.test(n))).toBe(false);
  });

  it('the lower bounds are still zod rules (no meaning, no example)', () => {
    expect(DraftSchema.safeParse(sense([])).success).toBe(false);
    const noExample = makeDraft({ senses: [makeSense({ examples: [] })] });
    expect(DraftSchema.safeParse(noExample).success).toBe(false);
  });

  it('more than 2 examples in a sense is still a zod error', () => {
    const three = makeSense().examples[0];
    expect(DraftSchema.safeParse(makeDraft({ senses: [makeSense({ examples: [three, three, three] })] })).success).toBe(false);
  });

  it('a draft that is cut but also breaks another rule is still repaired once, then fails', async () => {
    const bad = outDraft();
    bad.senses[0] = { ...bad.senses[0], meanings_vi: ['ra ngoài (đi ra)'] };
    const { caller, calls } = stub(reply(bad), reply(bad));
    const r = await generateDraft(makeBundle({ word: 'out', expectedLemma: 'out' }), { haiku: caller });
    expect(calls()).toBe(2);
    const failure = asFailure(r);
    expect(failure.reason).toBe('invalid_output');
    expect(failure.details.map((i) => `${i.path}:${i.code}`)).toEqual(['senses[0].meanings_vi[0]:parenthesis']);
  });
});
