module.exports = [
  {
    file: 'scripts/acceptance/source.ts',
    edits: [
      [
        `/** A common word that Free Dictionary has had for years. */
export const PROBE_WORD = 'hello';`,
        `/**
 * Three ordinary words, ONE PER ATTEMPT. Not a single sample word, and not \`hello\`: on 16/10/2026 the service answered \`hello\` in 0.2 s
 * (its CDN had it cached) while every other word hung for more than 8 s, so a probe on \`hello\` called a dead service healthy.
 */
export const PROBE_WORDS: readonly string[] = ['house', 'water', 'tree'];`,
      ],
      [
        `export interface ProbeAttempt {
  ok: boolean;`,
        `export interface ProbeAttempt {
  /** the word asked for in this attempt */
  word: string;
  ok: boolean;`,
      ],
      [
        `export interface ProbeResult {
  word: string;
  attempts: ProbeAttempt[];`,
        `export interface ProbeResult {
  words: string[];
  attempts: ProbeAttempt[];`,
      ],
      [
        `export async function probeFreeDictionary(baseUrl: string, timeoutMs: number, deps: ProbeDeps = {}, word: string = PROBE_WORD, attempts: number = PROBE_ATTEMPTS): Promise<ProbeResult> {`,
        `export async function probeFreeDictionary(baseUrl: string, timeoutMs: number, deps: ProbeDeps = {}, words: string | readonly string[] = PROBE_WORDS, attempts: number = PROBE_ATTEMPTS): Promise<ProbeResult> {`,
      ],
      [
        `  const url = \`\${baseUrl.replace(/\\/+$/, '')}/\${encodeURIComponent(word)}\`;

  const out: ProbeAttempt[] = [];
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(PROBE_GAP_MS);
    const started = now();`,
        `  const list = typeof words === 'string' ? [words] : words;
  const base = baseUrl.replace(/\\/+$/, '');

  const out: ProbeAttempt[] = [];
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(PROBE_GAP_MS);
    const word = list[i % list.length];
    const url = \`\${base}/\${encodeURIComponent(word)}\`;
    const started = now();`,
      ],
      [
        `      out.push({ ok, status: res.status, ms: Math.round(now() - started), error: ok ? null : res.status === 200 ? 'not_a_word_list' : \`http_\${res.status}\` });`,
        `      out.push({ word, ok, status: res.status, ms: Math.round(now() - started), error: ok ? null : res.status === 200 ? 'not_a_word_list' : \`http_\${res.status}\` });`,
      ],
      [
        `      out.push({ ok: false, status: null, ms: Math.round(now() - started), error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : name });`,
        `      out.push({ word, ok: false, status: null, ms: Math.round(now() - started), error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : name });`,
      ],
      [
        `  return { word, attempts: out, healthy: out.length === attempts && out.every((a) => a.ok) };`,
        `  return { words: [...new Set(out.map((a) => a.word))], attempts: out, healthy: out.length === attempts && out.every((a) => a.ok) };`,
      ],
      [
        `\`lần \${i + 1}: \${a.ok ? 'OK' : (a.error ?? 'lỗi')}`,
        `\`lần \${i + 1} (\${a.word}): \${a.ok ? 'OK' : (a.error ?? 'lỗi')}`,
      ],
    ],
  },
  {
    file: 'scripts/acceptance/report.ts',
    edits: [
      [
        `3 lần liền với một từ mẫu; **khỏe**`,
        `3 lần liền, mỗi lần một từ thông dụng khác nhau (một từ duy nhất như \\\`hello\\\` có thể nằm sẵn trong bộ nhớ đệm của CDN và vẫn được trả lời khi máy chủ gốc đã treo); **khỏe**`,
      ],
    ],
  },
  {
    file: 'tests/acceptance/source.test.ts',
    edits: [
      [
        `  it('is healthy when all three attempts get 200 with a list of entries, and asks for the sample word', async () => {`,
        `  it('is healthy when all three attempts get 200 with a list of entries; each attempt asks for a DIFFERENT ordinary word (a cached \`hello\` hid a dead service)', async () => {`,
      ],
      [
        `    expect((fetchImpl as unknown as jest.Mock).mock.calls.map((c) => c[0])).toEqual(Array(3).fill('https://fd.test/api/v2/entries/en/hello'));`,
        `    expect((fetchImpl as unknown as jest.Mock).mock.calls.map((c) => c[0])).toEqual([
      'https://fd.test/api/v2/entries/en/house',
      'https://fd.test/api/v2/entries/en/water',
      'https://fd.test/api/v2/entries/en/tree',
    ]);
    expect(r.attempts.map((a) => a.word)).toEqual(['house', 'water', 'tree']);
    expect(r.words).toEqual(['house', 'water', 'tree']);`,
      ],
      [
        `    const text = describeProbe({ word: 'hello', healthy: false, attempts: [{ ok: true, status: 200, ms: 120, error: null }, { ok: false, status: null, ms: 2500, error: 'timeout' }] });
    expect(text).toBe('lần 1: OK (HTTP 200) 120 ms; lần 2: timeout 2500 ms');`,
        `    const text = describeProbe({
      words: ['house', 'water'],
      healthy: false,
      attempts: [
        { word: 'house', ok: true, status: 200, ms: 120, error: null },
        { word: 'water', ok: false, status: null, ms: 2500, error: 'timeout' },
      ],
    });
    expect(text).toBe('lần 1 (house): OK (HTTP 200) 120 ms; lần 2 (water): timeout 2500 ms');`,
      ],
      [
        `    expect(classifyWordCheck({ ok: true, status: 200, ms: 90, error: null })).toBe('has');
    expect(classifyWordCheck({ ok: false, status: 404, ms: 90, error: 'http_404' })).toBe('absent');
    expect(classifyWordCheck({ ok: false, status: 503, ms: 90, error: 'http_503' })).toBe('error');
    expect(classifyWordCheck({ ok: false, status: null, ms: 2500, error: 'timeout' })).toBe('error');`,
        `    expect(classifyWordCheck({ word: 'w', ok: true, status: 200, ms: 90, error: null })).toBe('has');
    expect(classifyWordCheck({ word: 'w', ok: false, status: 404, ms: 90, error: 'http_404' })).toBe('absent');
    expect(classifyWordCheck({ word: 'w', ok: false, status: 503, ms: 90, error: 'http_503' })).toBe('error');
    expect(classifyWordCheck({ word: 'w', ok: false, status: null, ms: 2500, error: 'timeout' })).toBe('error');`,
      ],
    ],
  },
  {
    file: 'tests/acceptance/report.test.ts',
    edits: [
      [
        `const probe = (healthy: boolean) => ({
  word: 'hello',
  healthy,
  attempts: Array.from({ length: 3 }, () => (healthy ? { ok: true, status: 200, ms: 140, error: null } : { ok: false, status: null, ms: 2500, error: 'timeout' })),
});`,
        `const probe = (healthy: boolean) => ({
  words: ['house', 'water', 'tree'],
  healthy,
  attempts: ['house', 'water', 'tree'].map((word) => (healthy ? { word, ok: true, status: 200, ms: 140, error: null } : { word, ok: false, status: null, ms: 2500, error: 'timeout' })),
});`,
      ],
      [
        `'| trước khi chạy | **KHÔNG KHỎE** | lần 1: timeout 2500 ms; lần 2: timeout 2500 ms; lần 3: timeout 2500 ms |'`,
        `'| trước khi chạy | **KHÔNG KHỎE** | lần 1 (house): timeout 2500 ms; lần 2 (water): timeout 2500 ms; lần 3 (tree): timeout 2500 ms |'`,
      ],
    ],
  },
  {
    file: 'docs/lookup-runbook.md',
    edits: [
      [
        `Gọi THẲNG Free Dictionary 3 lần liền với từ mẫu \`hello\` (không qua máy chủ, để không làm mạch ngắt của máy chủ nhích).`,
        `Gọi THẲNG Free Dictionary 3 lần liền, **mỗi lần một từ thông dụng khác nhau** (\`house\`, \`water\`, \`tree\`; không qua máy chủ, để không làm mạch ngắt của máy chủ nhích). Không dùng một từ mẫu duy nhất như \`hello\`: ngày 16/10/2026 dịch vụ trả \`hello\` trong 0,2 s (CDN của họ có sẵn) trong khi mọi từ khác treo quá 8 giây, nên một lần thăm dò bằng \`hello\` gọi một dịch vụ đã chết là khỏe.`,
      ],
    ],
  },
];
