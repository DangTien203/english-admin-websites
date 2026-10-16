module.exports = [
  {
    file: 'scripts/acceptance/evaluate.ts',
    edits: [
      [
        `export type VerdictKind = 'pass' | 'fail' | 'skip';`,
        `/**
 * pass / fail / skip (a precondition of the database was wrong) / unevaluable: the expectation needs an outside source that was not
 * answering (Free Dictionary), so the word can be neither passed nor failed. Unevaluable is never turned into pass.
 */
export type VerdictKind = 'pass' | 'fail' | 'skip' | 'unevaluable';`,
      ],
      [
        `/** skip beats fail beats pass; the reasons of every part are kept. */
export function combine(...parts: Verdict[]): Verdict {
  const reasons = parts.flatMap((p) => p.reasons);
  if (parts.some((p) => p.verdict === 'skip')) return { verdict: 'skip', reasons };
  if (parts.some((p) => p.verdict === 'fail')) return { verdict: 'fail', reasons };
  return { verdict: 'pass', reasons };
}`,
        `/**
 * skip beats fail beats unevaluable beats pass; the reasons of every part are kept. A real failure of one part (say, the job wrote
 * an entry with the wrong published flag) is not hidden by another part that could not be judged.
 */
export function combine(...parts: Verdict[]): Verdict {
  const reasons = parts.flatMap((p) => p.reasons);
  if (parts.some((p) => p.verdict === 'skip')) return { verdict: 'skip', reasons };
  if (parts.some((p) => p.verdict === 'fail')) return { verdict: 'fail', reasons };
  if (parts.some((p) => p.verdict === 'unevaluable')) return { verdict: 'unevaluable', reasons };
  return { verdict: 'pass', reasons };
}`,
      ],
      [
        `// ── the form row written in the background (group B) ──`,
        `// ── Free Dictionary failing: "cannot be judged", not "failed" ─────────────────────────────────────────────────────────

/** What the report calls a row whose expectation needs a source that was not answering. */
export const UNEVALUABLE_LABEL = 'KHÔNG ĐÁNH GIÁ ĐƯỢC: nguồn ngoài lỗi';

export interface SourceHealth {
  /** Free Dictionary could not be relied on while this word was looked up (probe failed, or its circuit breaker was open) */
  unhealthy: boolean;
  /** short, content-free reason for the report */
  why: string;
}

/** 503 TRANSLATION_UNAVAILABLE: by docs/lookup-spec.md §6 ("không G, FDerr") it is only answered when Free Dictionary ERRORED. */
export function isSourceOutage(obs: FastObservation): boolean {
  return obs.status === 503 && obs.body?.error?.code === 'TRANSLATION_UNAVAILABLE';
}

/**
 * A fast-path verdict that fails ONLY because Free Dictionary was failing becomes "unevaluable" (never pass). Applied to
 *   - groups E and F: a 503. The word has no Google translation, so the answer waits for Free Dictionary; when that hangs or errors
 *     the matrix of §6 says 503, which is what the server did. The report says so; the expectation (E: 200, F: 404) cannot be checked.
 *   - group H: a 503, or, while Free Dictionary was unhealthy, an answer without the senses that only it provides.
 * Everything else keeps its verdict, so a wrong status or a wrong source is still a failure whatever Free Dictionary did.
 */
export function reclassifyForSource(group: Group, obs: FastObservation, verdict: Verdict, source: SourceHealth): Verdict {
  if (verdict.verdict !== 'fail') return verdict;
  const outage = isSourceOutage(obs);
  const reasons = (extra: string) => [extra, ...verdict.reasons.map((r) => \`(\${r})\`)];

  if ((group === 'E' || group === 'F') && outage) {
    return {
      verdict: 'unevaluable',
      reasons: reasons('503 TRANSLATION_UNAVAILABLE: Free Dictionary lỗi hoặc treo và Google không cho bản dịch dùng được; spec §6 (không G, FDerr → 503) đòi đúng 503, nên hành vi của máy chủ ĐÚNG (đạt có ghi chú), còn kỳ vọng của nhóm cần Free Dictionary trả lời'),
    };
  }
  if (group === 'H') {
    if (outage) return { verdict: 'unevaluable', reasons: reasons('503 TRANSLATION_UNAVAILABLE: Free Dictionary lỗi (spec §6), không có sense để chấm') };
    if (source.unhealthy && obs.status === 200 && obs.body?.data?.source === 'translation') {
      return { verdict: 'unevaluable', reasons: reasons(\`Free Dictionary không khỏe lúc tra (\${source.why}); các sense của nhóm H đến từ nguồn đó\`) };
    }
  }
  return verdict;
}

// ── the form row written in the background (group B) ──`,
      ],
    ],
  },
];
