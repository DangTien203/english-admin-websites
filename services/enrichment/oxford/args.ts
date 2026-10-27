/**
 * Command-line parsing of the three Oxford tools. Strict: an option that is not known is an error, so a typo of --confirm never runs as
 * something else. Pure (tests/enrichment/oxfordArgs.test.ts).
 */
import { BLOCKING_REVIEW_NOTE_CATEGORIES, type ReviewNoteCategoryId } from '../../lookup/reviewNotes';
import { DEFAULT_PUBLISH_LIMIT } from './publish';
import { parseCefrList, type SelectionOptions } from './selection';

const whole = (flag: string, value: string): number => {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} needs a whole number, got "${value}"`);
  return Number(value);
};

const valueOf = (argv: string[], i: number, flag: string): string => {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
  return v;
};

// ── enrich:seed-oxford ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface SeedArgs {
  file?: string;
  limit?: number;
  offset?: number;
  onlyCefr?: string;
  sample?: number;
  workerLog?: string;
  dryRun: boolean;
  confirm: boolean;
  report: boolean;
  allowAuto: boolean;
  /** send again the words of the latest run whose job did not make an entry */
  retryLastRun: boolean;
  /** --report only: report on the runs from this one (1 = the first) onwards */
  fromRun?: number;
}

export function parseSeedArgs(argv: string[]): SeedArgs {
  const args: SeedArgs = { dryRun: false, confirm: false, report: false, allowAuto: false, retryLastRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--confirm':
        args.confirm = true;
        break;
      case '--report':
        args.report = true;
        break;
      case '--allow-auto':
        args.allowAuto = true;
        break;
      case '--retry-last-run':
        args.retryLastRun = true;
        break;
      case '--file':
      case '--only-cefr':
      case '--worker-log': {
        const v = valueOf(argv, i++, a);
        if (a === '--file') args.file = v;
        else if (a === '--only-cefr') args.onlyCefr = v;
        else args.workerLog = v;
        break;
      }
      case '--from-run': {
        const n = whole(a, valueOf(argv, i++, a));
        if (n < 1) throw new Error('--from-run needs a positive number');
        args.fromRun = n;
        break;
      }
      case '--limit':
      case '--offset':
      case '--sample': {
        const n = whole(a, valueOf(argv, i++, a));
        if (a === '--limit') args.limit = n;
        else if (a === '--offset') args.offset = n;
        else args.sample = n;
        break;
      }
      default:
        throw new Error(`Unknown option: ${a}`);
    }
  }
  if (args.dryRun && args.confirm) throw new Error('--dry-run and --confirm cannot be used together');
  if (args.report && (args.confirm || args.dryRun)) throw new Error('--report cannot be combined with --confirm or --dry-run (send first, then report)');
  if (args.fromRun !== undefined && !args.report) throw new Error('--from-run only goes with --report');
  if (args.retryLastRun && (args.limit !== undefined || args.offset !== undefined || args.sample !== undefined || args.onlyCefr !== undefined)) {
    throw new Error('--retry-last-run cannot be combined with --limit, --offset, --sample or --only-cefr (it sends the words of the latest run, nothing else)');
  }
  if (args.retryLastRun && args.report) throw new Error('--retry-last-run cannot be combined with --report');
  if (args.sample !== undefined && (args.limit !== undefined || args.offset !== undefined)) throw new Error('--sample cannot be combined with --limit or --offset');
  if (args.limit !== undefined && args.limit < 1) throw new Error('--limit needs a positive number');
  if (args.sample !== undefined && args.sample < 1) throw new Error('--sample needs a positive number');
  if (args.onlyCefr !== undefined) parseCefrList(args.onlyCefr); // fails early on a bad level
  return args;
}

/** The selection options and a short description of them for the printed summary. */
export function selectionFromArgs(a: SeedArgs): { text: string; options: SelectionOptions } {
  const options: SelectionOptions = {};
  const parts: string[] = [];
  if (a.onlyCefr) {
    options.onlyCefr = parseCefrList(a.onlyCefr);
    parts.push(`chỉ mức ${options.onlyCefr.join(', ')}`);
  }
  if (a.sample !== undefined) {
    options.sample = a.sample;
    parts.push(`mẫu phân tầng ${a.sample} từ`);
  } else {
    if (a.offset !== undefined) {
      options.offset = a.offset;
      parts.push(`bỏ ${a.offset} từ đầu`);
    }
    if (a.limit !== undefined) {
      options.limit = a.limit;
      parts.push(`tối đa ${a.limit} từ`);
    }
  }
  if (a.retryLastRun) parts.push('gửi lại các từ của lần gửi gần nhất mà job chưa thành mục từ');
  return { text: parts.length > 0 ? parts.join(', ') : 'toàn bộ phần còn lại', options };
}

// ── oxford:apply-cefr ──────────────────────────────────────────────────────────────────────────────────────────────────

export function parseApplyCefrArgs(argv: string[]): { file?: string; dryRun: boolean } {
  const out: { file?: string; dryRun: boolean } = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--file') out.file = valueOf(argv, i++, a);
    else throw new Error(`Unknown option: ${a}`);
  }
  return out;
}

// ── enrich:publish ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PublishArgs {
  cefr?: string;
  limit: number;
  dryRun: boolean;
  confirm: boolean;
  /** "needs a look" categories of Haiku's notes that the caller accepts: an entry held back ONLY by these is published too */
  acceptNotes: ReviewNoteCategoryId[];
}

/**
 * --accept-notes meaning_doubt,validator_flag  (or: all). Only the categories that hold an entry back can be named: accepting a light
 * category would mean nothing, and a typo must never be read as "accept nothing" or "accept everything".
 */
export function parseAcceptNotes(value: string): ReviewNoteCategoryId[] {
  const names = [...new Set(value.split(',').map((s) => s.trim()).filter(Boolean))];
  if (names.length === 0) throw new Error('--accept-notes needs at least one category');
  if (names.includes('all')) {
    if (names.length > 1) throw new Error('--accept-notes: "all" cannot be combined with other categories');
    return [...BLOCKING_REVIEW_NOTE_CATEGORIES];
  }
  const unknown = names.filter((n) => !(BLOCKING_REVIEW_NOTE_CATEGORIES as readonly string[]).includes(n));
  if (unknown.length > 0) throw new Error(`--accept-notes: unknown category ${unknown.join(', ')} (allowed: ${BLOCKING_REVIEW_NOTE_CATEGORIES.join(', ')}, or all)`);
  return names as ReviewNoteCategoryId[];
}

export function parsePublishArgs(argv: string[]): PublishArgs {
  const out: PublishArgs = { limit: DEFAULT_PUBLISH_LIMIT, dryRun: false, confirm: false, acceptNotes: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--confirm') out.confirm = true;
    else if (a === '--cefr') out.cefr = valueOf(argv, i++, a);
    else if (a === '--limit') out.limit = whole(a, valueOf(argv, i++, a));
    else if (a === '--accept-notes') out.acceptNotes = parseAcceptNotes(valueOf(argv, i++, a));
    else throw new Error(`Unknown option: ${a}`);
  }
  if (out.dryRun && out.confirm) throw new Error('--dry-run and --confirm cannot be used together');
  if (out.cefr !== undefined) parseCefrList(out.cefr);
  return out;
}
