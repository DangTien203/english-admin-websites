import { buildReport, type RunSummary, type WordResult } from '../../scripts/acceptance/report';
import { combine, evaluateFast, reclassifyForSource, summarizeFast, UNEVALUABLE_LABEL, type FastObservation, type JobObservation } from '../../scripts/acceptance/evaluate';
import { rerunCommand, sourceHealthFor } from '../../scripts/acceptance/source';
import type { Group } from '../../scripts/acceptance/words';

const err = (status: number, code: string, ms = 3050): FastObservation => ({ status, ms, body: { success: false, error: { code, message: 'x' } } });
const none: JobObservation = { rows: [], entry: null, headwordEntryExists: false, timedOut: false };
const BASE = 'http://localhost:3000';

/** A finished word: its fast answer judged the way the script judges it (with Free Dictionary's health). */
function word(group: Group, w: string, obs: FastObservation, health: { probeHealthy: boolean | null; breakerOpen?: boolean }, endProbeHealthy: boolean | null): WordResult {
  const fast = reclassifyForSource(group, obs, evaluateFast(group, w, obs), sourceHealthFor({ probeHealthy: health.probeHealthy, breakerOpen: health.breakerOpen ?? false }, endProbeHealthy));
  const job = { verdict: 'pass' as const, reasons: [] };
  return { planned: { group, word: w }, fast: obs, summary: summarizeFast(obs), formPresent: null, job: none, verdicts: { fast, job }, verdict: combine(fast, job) };
}

function summary(results: WordResult[], extra: Partial<RunSummary> = {}): RunSummary {
  const unevaluable = new Set(results.filter((r) => r.verdict.verdict === 'unevaluable').map((r) => r.planned.group));
  return {
    startedAtDb: '2026-10-16T09:00:00.000000Z',
    identity: { host: 'ep-example.neon.tech', database: 'neondb', user: 'u' },
    baseUrl: BASE,
    groups: ['H', 'E', 'F'],
    results,
    skipped: [],
    latency: { verdict: 'pass', reasons: [], p50: 1000, p95: 3100, limitMs: 3500, samples: results.length },
    tokens: { anthropicBefore: { input: 0, output: 0 }, anthropicAfter: { input: 0, output: 0 }, jobs: { input: 0, output: 0, calls: 0, costUsd: null } },
    waitMinutes: 10,
    jobWaitTimedOut: false,
    elapsedSec: 90,
    probes: [],
    waits: [],
    deferred: [],
    wordChecks: [],
    breakerResetMs: 30_000,
    settings: { publishPolicy: 'review', totalDeadlineMs: 3000, fastTranslator: 'google' },
    rerun: unevaluable.size > 0 ? rerunCommand(unevaluable, BASE) : null,
    ...extra,
  };
}

const probe = (healthy: boolean) => ({
  words: ['house', 'water', 'tree'],
  healthy,
  attempts: ['house', 'water', 'tree'].map((word) => (healthy ? { word, ok: true, status: 200, ms: 140, error: null } : { word, ok: false, status: null, ms: 2500, error: 'timeout' })),
});

describe('buildReport — Free Dictionary was down', () => {
  const down = [
    word('H', 'batter', { status: 200, ms: 900, body: { success: true, data: { source: 'translation', temporary: true, translation_vi: 'x', meanings_vi: ['x'], senses: [], partial: true, missing: ['pos'], enrichment: { status: 'queued' } } } }, { probeHealthy: false }, false),
    word('E', 'microsoft', err(503, 'TRANSLATION_UNAVAILABLE'), { probeHealthy: false }, false),
    word('F', 'asdfghjk', err(503, 'TRANSLATION_UNAVAILABLE'), { probeHealthy: false }, false),
  ];
  const text = buildReport(summary(down, { probes: [{ label: 'trước khi chạy', result: probe(false) }, { label: 'sau lượt tra', result: probe(false) }] }));

  it('counts them as "cannot be judged", not as failures', () => {
    expect(down.map((r) => r.verdict.verdict)).toEqual(['unevaluable', 'unevaluable', 'unevaluable']);
    expect(text).toContain(`| Đạt | Không đạt | ${UNEVALUABLE_LABEL} | Bỏ qua (tiền đề sai) |`);
    expect(text).toContain('| 0 | 0 | 3 | 0 |');
  });

  it('says plainly that the run is not finished, and gives the command that runs again only the groups that need it (H before E and F)', () => {
    expect(text).toContain('CHƯA kết luận hết');
    expect(text).toContain('npm run acceptance:lookup -- --staging --only H,E,F --base-url http://localhost:3000');
    expect(text).toMatch(/```bash\nnpm run acceptance:lookup -- --staging --only H,E,F/);
  });

  it('says that a 503 for a garbage word while Free Dictionary hangs is what spec §6 asks for ("đạt có ghi chú")', () => {
    expect(text).toContain('asdfghjk');
    expect(text).toContain('hành vi **ĐÚNG**');
    expect(text).toContain('"không G, FDerr → 503"');
    expect(text).toContain('đạt có ghi chú');
    expect(text).toContain('không sửa đặc tả để hợp thức hóa kết quả');
  });

  it('shows the probes of Free Dictionary with their three attempts, and the row label in the tables', () => {
    expect(text).toContain('### 1.1 Free Dictionary trong lần chạy này');
    expect(text).toContain('| trước khi chạy | **KHÔNG KHỎE** | lần 1 (house): timeout 2500 ms; lần 2 (water): timeout 2500 ms; lần 3 (tree): timeout 2500 ms |');
    expect(text).toContain(`### 4.1 Từ "${UNEVALUABLE_LABEL}"`);
    expect((text.match(new RegExp(`\\| ${UNEVALUABLE_LABEL} \\|`, 'g')) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('lists the order the groups ran in, and why H goes first', () => {
    expect(text).toContain('Thứ tự chạy: A, B, C, D, **H**, E, F');
  });
});

describe('buildReport — a normal run', () => {
  const good = [word('F', 'asdfghjk', err(404, 'ENTRY_NOT_FOUND', 400), { probeHealthy: true }, true)];
  const text = buildReport(summary(good, { probes: [{ label: 'trước khi chạy', result: probe(true) }] }));

  it('has no "run again" paragraph and no row to explain', () => {
    expect(text).not.toContain('CHƯA kết luận hết');
    expect(text).toContain('| 1 | 0 | 0 | 0 |');
    expect(text).toMatch(/### 4\.1[^\n]*\n\nKhông có\./);
    expect(text).toContain('| trước khi chạy | khỏe |');
  });

  it('prints the settings of the run in the header', () => {
    expect(text).toContain('ENRICHMENT_PUBLISH_POLICY=review');
    expect(text).toContain('LOOKUP_TOTAL_DEADLINE_MS=3000');
  });
});

describe('buildReport — group H not run because Free Dictionary was down at the start', () => {
  const deferred = ['jam', 'ring'].map((w) => ({ group: 'H' as const, word: w, reason: `${UNEVALUABLE_LABEL}: chưa chạy vì Free Dictionary không trả lời lúc bắt đầu (từ giữ nguyên cho lần chạy lại)` }));
  const f = word('F', 'asdfghjk', err(404, 'ENTRY_NOT_FOUND', 400), { probeHealthy: false }, false);
  const text = buildReport(summary([f], { deferred, rerun: rerunCommand(['H'], BASE), probes: [{ label: 'trước khi chạy', result: probe(false) }] }));

  it('counts them as not judged, lists them with the reason, and gives the command that runs them', () => {
    expect(text).toContain(`| Đạt | Không đạt | ${UNEVALUABLE_LABEL} | Bỏ qua (tiền đề sai) |`);
    expect(text).toContain('| 1 | 0 | 2 | 0 |');
    expect(text).toContain('| H | jam |');
    expect(text).toContain('chưa chạy vì Free Dictionary không trả lời lúc bắt đầu');
    expect(text).toContain('npm run acceptance:lookup -- --staging --only H --base-url http://localhost:3000');
    expect(text).toContain('CHƯA kết luận hết');
  });
});

describe('buildReport — group H words asked about again', () => {
  it('shows what Free Dictionary said about each word, and what that means for the verdict', () => {
    const text = buildReport(
      summary([word('F', 'asdfghjk', err(404, 'ENTRY_NOT_FOUND', 400), { probeHealthy: true }, true)], {
        wordChecks: [
          { word: 'crane', outcome: 'has' },
          { word: 'zzword', outcome: 'absent' },
          { word: 'bolt', outcome: 'error' },
        ],
      })
    );
    expect(text).toContain('| crane | có dữ liệu (200) | lúc tra máy chủ không nhận được gì: nguồn chập chờn, từ không sai; không đánh giá được |');
    expect(text).toContain('| zzword | 404 | nguồn không có từ này; câu trả lời rỗng là đúng và từ này chọn không hợp (không đạt) |');
    expect(text).toContain('| bolt | không trả lời | nguồn vẫn lỗi; không đánh giá được |');
  });

  it('says nothing about it when no word needed asking', () => {
    expect(buildReport(summary([]))).not.toContain('được hỏi lại ĐÚNG từ đó');
  });
});

describe('buildReport — a wait for the circuit breaker', () => {
  it('says how long it waited, why, and between which groups', () => {
    const text = buildReport(summary([word('F', 'asdfghjk', err(404, 'ENTRY_NOT_FOUND', 400), { probeHealthy: true }, true)], { waits: [{ before: 'E', after: 'H', waitedMs: 31_500 }] }));
    expect(text).toContain('Sau nhóm H mạch ngắt Free Dictionary của máy chủ có vẻ đã mở');
    expect(text).toContain('chờ 32 s (UPSTREAM_BREAKER_RESET_MS = 30000 ms cộng 2 s đệm) trước nhóm E');
  });
});

describe('buildReport — a run without any group that reaches Free Dictionary', () => {
  it('does not claim a probe was made', () => {
    const text = buildReport(summary([]));
    expect(text).toContain('Lần chạy không có nhóm nào đi tới Free Dictionary (không thăm dò).');
  });
});
