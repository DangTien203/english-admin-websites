/**
 * Which of the eligible Oxford words are sent, and in which order (docs/lookup-runbook.md §13). Pure.
 *
 * Order: CEFR level ascending (A1 first; words with no level last), then frequency (rank 1 = the most common word of
 * ref_word_frequency; words missing from it last), then alphabetical so that the order is the same on every run.
 * Then: --only-cefr keeps some levels, --offset / --limit cut the list. --sample N replaces --offset / --limit by a stratified,
 * reproducible pick (about the same number of words per level, parts of speech mixed inside each level).
 */
import { CEFR_LEVELS, cefrRank, toCefr, type Cefr, type OxfordWord } from './list';

export interface SeedWord extends OxfordWord {
  /** ref_word_frequency.rank (1 = most common) or null */
  rank: number | null;
}

export function bySendOrder(a: SeedWord, b: SeedWord): number {
  const level = cefrRank(a.cefr) - cefrRank(b.cefr);
  if (level !== 0) return level;
  const ra = a.rank ?? Number.MAX_SAFE_INTEGER;
  const rb = b.rank ?? Number.MAX_SAFE_INTEGER;
  if (ra !== rb) return ra - rb;
  return a.word < b.word ? -1 : a.word > b.word ? 1 : 0;
}

/** "A1,a2" → ['A1','A2']. Throws on a value that is not a level. */
export function parseCefrList(text: string): Cefr[] {
  const out: Cefr[] = [];
  for (const part of text.split(',')) {
    if (part.trim() === '') continue;
    const level = toCefr(part);
    if (!level) throw new Error(`--only-cefr: "${part.trim()}" is not a CEFR level (${CEFR_LEVELS.join(', ')})`);
    if (!out.includes(level)) out.push(level);
  }
  if (out.length === 0) throw new Error('--only-cefr needs at least one level');
  return out;
}

export interface SelectionOptions {
  onlyCefr?: readonly Cefr[];
  offset?: number;
  limit?: number;
  sample?: number;
}

/** FNV-1a, 32 bit: a fixed, dependency-free hash so a sample is the same on every machine and every run. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const SAMPLE_SEED = 'oxford-seed-v1';

/**
 * About `n` words, the same number from each level that has eligible words (the remainder goes to the lowest levels; a level with
 * too few words gives its share to the others). Inside a level the parts of speech take turns (largest group first), and inside a
 * part of speech the words are picked by hash, so the pick is reproducible but not alphabetical. Words with no level are not
 * sampled.
 */
export function stratifiedSample(words: readonly SeedWord[], n: number): SeedWord[] {
  if (!Number.isInteger(n) || n < 1) throw new Error('--sample needs a positive integer');

  const levels = CEFR_LEVELS.filter((l) => words.some((w) => w.cefr === l));
  if (levels.length === 0) return [];

  // quotas
  const available = new Map<Cefr, SeedWord[]>(levels.map((l) => [l, words.filter((w) => w.cefr === l)]));
  const quota = new Map<Cefr, number>(levels.map((l) => [l, 0]));
  let left = Math.min(n, [...available.values()].reduce((s, a) => s + a.length, 0));
  while (left > 0) {
    const open = levels.filter((l) => quota.get(l)! < available.get(l)!.length);
    if (open.length === 0) break;
    const share = Math.floor(left / open.length);
    const extra = left % open.length;
    let given = 0;
    open.forEach((l, i) => {
      const want = share + (i < extra ? 1 : 0);
      const take = Math.min(want, available.get(l)!.length - quota.get(l)!);
      quota.set(l, quota.get(l)! + take);
      given += take;
    });
    if (given === 0) break;
    left -= given;
  }

  const picked: SeedWord[] = [];
  for (const level of levels) {
    const want = quota.get(level)!;
    if (want === 0) continue;
    const groups = new Map<string, SeedWord[]>();
    for (const w of available.get(level)!) {
      const key = w.primaryPos ?? '(none)';
      groups.set(key, [...(groups.get(key) ?? []), w]);
    }
    const ordered = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
      .map(([, list]) => [...list].sort((a, b) => fnv1a(`${SAMPLE_SEED}:${a.word}`) - fnv1a(`${SAMPLE_SEED}:${b.word}`) || (a.word < b.word ? -1 : 1)));
    let taken = 0;
    for (let round = 0; taken < want; round++) {
      let progressed = false;
      for (const list of ordered) {
        if (taken >= want) break;
        if (round < list.length) {
          picked.push(list[round]);
          taken++;
          progressed = true;
        }
      }
      if (!progressed) break;
    }
  }
  return picked;
}

/** The words that will be sent, in sending order. */
export function selectWords(eligible: readonly SeedWord[], opts: SelectionOptions = {}): SeedWord[] {
  if (opts.sample !== undefined && (opts.offset !== undefined || opts.limit !== undefined)) {
    throw new Error('--sample cannot be combined with --offset or --limit');
  }
  let list = [...eligible];
  if (opts.onlyCefr && opts.onlyCefr.length > 0) list = list.filter((w) => w.cefr !== null && opts.onlyCefr!.includes(w.cefr));
  list.sort(bySendOrder);

  if (opts.sample !== undefined) return stratifiedSample(list, opts.sample).sort(bySendOrder);

  const offset = opts.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw new Error('--offset needs a non-negative integer');
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) throw new Error('--limit needs a positive integer');
  return list.slice(offset, opts.limit === undefined ? undefined : offset + opts.limit);
}
