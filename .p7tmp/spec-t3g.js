module.exports = [
  {
    file: 'scripts/acceptance/source.ts',
    edits: [
      [
        `/** What was known about Free Dictionary when a word was looked up, and at the end of the fast path. */
export function sourceHealthFor(at: { probeHealthy: boolean | null; breakerOpen: boolean }, endProbeHealthy: boolean | null): SourceHealth {
  if (at.breakerOpen) return { unhealthy: true, why: 'mạch ngắt Free Dictionary đang mở sau nhiều lần lỗi liên tiếp' };
  if (at.probeHealthy === false) return { unhealthy: true, why: 'lần thăm dò Free Dictionary trước đó không khỏe' };
  if (endProbeHealthy === false) return { unhealthy: true, why: 'lần thăm dò Free Dictionary sau lượt tra không khỏe' };
  return { unhealthy: false, why: 'Free Dictionary khỏe' };
}`,
        `/**
 * One more look at ONE word, after the fast path: does Free Dictionary have it?
 *   has     it answers 200 with entries NOW, although the server got nothing from it when it looked the word up (a timeout, a bad
 *           response or an open circuit breaker at that moment): the source was failing, the word is fine;
 *   absent  it answers 404: it really does not have the word, so an empty answer was correct (and the word is a bad choice);
 *   error   it does not answer this time either.
 * The sample word of the probe (\`hello\`) is cached by the service's CDN and always answers; an uncached word is where it struggles.
 */
export type WordCheck = 'has' | 'absent' | 'error';

export function classifyWordCheck(attempt: ProbeAttempt | undefined): WordCheck {
  if (attempt?.ok) return 'has';
  if (attempt?.status === 404) return 'absent';
  return 'error';
}

/** What was known about Free Dictionary when a word was looked up, at the end of the fast path, and (for one word) when asked again. */
export function sourceHealthFor(at: { probeHealthy: boolean | null; breakerOpen: boolean }, endProbeHealthy: boolean | null, wordCheck: WordCheck | null = null): SourceHealth {
  if (at.breakerOpen) return { unhealthy: true, why: 'mạch ngắt Free Dictionary đang mở sau nhiều lần lỗi liên tiếp' };
  if (at.probeHealthy === false) return { unhealthy: true, why: 'lần thăm dò Free Dictionary trước đó không khỏe' };
  if (endProbeHealthy === false) return { unhealthy: true, why: 'lần thăm dò Free Dictionary sau lượt tra không khỏe' };
  if (wordCheck === 'has') return { unhealthy: true, why: 'thăm dò lại đúng từ này thì Free Dictionary có dữ liệu, nhưng máy chủ không nhận được gì lúc tra (timeout, phản hồi hỏng hoặc mạch ngắt)' };
  if (wordCheck === 'error') return { unhealthy: true, why: 'thăm dò lại đúng từ này, Free Dictionary vẫn không trả lời' };
  return { unhealthy: false, why: wordCheck === 'absent' ? 'Free Dictionary không có từ này (404 khi thăm dò lại)' : 'Free Dictionary khỏe' };
}`,
      ],
    ],
  },
  {
    file: 'scripts/acceptance/words.ts',
    edits: [
      [
        `  H: ['trunk', 'rack', 'pawn', 'bark', 'crane', 'pitch', 'seal', 'bolt', 'stalk', 'jam'],`,
        `  H: ['trunk', 'rack', 'pawn', 'bark', 'crane', 'pitch', 'seal', 'bolt', 'stalk', 'jam', 'ring', 'spring', 'bat', 'mint', 'pound', 'row', 'wave', 'well', 'yard', 'fan', 'tap', 'rock', 'bear', 'pool'],`,
      ],
    ],
  },
  {
    file: 'scripts/acceptance/report.ts',
    edits: [
      [
        `export interface BreakerWait {`,
        `export interface WordCheckEntry {
  word: string;
  outcome: 'has' | 'absent' | 'error';
}

export interface BreakerWait {`,
      ],
      [
        `  waits: BreakerWait[];
  breakerResetMs: number;`,
        `  waits: BreakerWait[];
  /** group H words that came back without anything from Free Dictionary, asked about again one by one after the fast path */
  wordChecks: WordCheckEntry[];
  breakerResetMs: number;`,
      ],
      [
        `  lines.push('Thứ tự chạy: A, B, C, D, **H**, E, F.`,
        `  if (s.wordChecks.length > 0) {
    lines.push('Từ nhóm H trả về không có sense của Free Dictionary được hỏi lại ĐÚNG từ đó sau lượt tra (từ mẫu \`hello\` luôn được CDN của dịch vụ trả lời nên không lộ ra lúc nó chập chờn với từ chưa có trong bộ nhớ đệm):');
    lines.push('');
    lines.push('| Từ | Free Dictionary khi hỏi lại | Hiểu là |');
    lines.push('|---|---|---|');
    for (const c of s.wordChecks) {
      const text =
        c.outcome === 'has'
          ? ['có dữ liệu (200)', 'lúc tra máy chủ không nhận được gì: nguồn chập chờn, từ không sai; không đánh giá được']
          : c.outcome === 'absent'
            ? ['404', 'nguồn không có từ này; câu trả lời rỗng là đúng và từ này chọn không hợp (không đạt)']
            : ['không trả lời', 'nguồn vẫn lỗi; không đánh giá được'];
      lines.push(\`| \${c.word} | \${text[0]} | \${text[1]} |\`);
    }
    lines.push('');
  }
  lines.push('Thứ tự chạy: A, B, C, D, **H**, E, F.`,
      ],
    ],
  },
  {
    file: 'scripts/acceptance/lookup-acceptance.ts',
    edits: [
      [
        `import { buildReport, verdictLabel, fmtMs, type BreakerWait, type ProbeEntry, type RunSummary, type WordResult } from './report';
import { breakerLikelyOpen, breakerWaitMs, describeProbe, fdFailureEvidence, probeFreeDictionary, rerunCommand, sourceHealthFor, type ProbeResult } from './source';`,
        `import { buildReport, verdictLabel, fmtMs, type BreakerWait, type ProbeEntry, type RunSummary, type WordCheckEntry, type WordResult } from './report';
import { breakerLikelyOpen, breakerWaitMs, classifyWordCheck, describeProbe, fdFailureEvidence, probeFreeDictionary, rerunCommand, sourceHealthFor, type ProbeResult, type WordCheck } from './source';`,
      ],
      [
        `  // ── word_forms rows of group B (written in the background) ──`,
        `  // ── group H words that came back with nothing from Free Dictionary: does it have the word now? ──
  const wordCheck = new Map<string, WordCheck>();
  const wordChecks: WordCheckEntry[] = [];
  for (const p of plan.run.filter((x) => x.group === 'H')) {
    const obs = observations.get(p.word)!;
    if (isSourceOutage(obs) || !fdFailureEvidence('H', obs)) continue; // answered with senses, or a 503 (unevaluable without any look)
    const r = await probeFreeDictionary(lookupConfig.freeDictionary.baseUrl, lookupConfig.lookup.upstreamTimeoutMs, {}, p.word, 1);
    const outcome = classifyWordCheck(r.attempts[0]);
    wordCheck.set(p.word, outcome);
    wordChecks.push({ word: p.word, outcome });
    console.log(\`  hỏi lại Free Dictionary về "\${p.word}": \${outcome === 'has' ? 'có dữ liệu' : outcome === 'absent' ? '404 (nguồn không có từ này)' : 'không trả lời'}\`);
  }

  // ── word_forms rows of group B (written in the background) ──`,
      ],
      [
        `sourceHealthFor(at, endProbe ? endProbe.healthy : null)`,
        `sourceHealthFor(at, endProbe ? endProbe.healthy : null, wordCheck.get(planned.word) ?? null)`,
      ],
      [
        `    probes,
    waits,
    breakerResetMs`,
        `    probes,
    waits,
    wordChecks,
    breakerResetMs`,
      ],
      [
        `  reclassifyForSource,
  summarizeFast,`,
        `  isSourceOutage,
  reclassifyForSource,
  summarizeFast,`,
      ],
    ],
  },
];
