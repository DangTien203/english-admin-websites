import { FallbackFastTranslator, GoogleFastTranslator } from '../../services/lookup/fastTranslator';
import { loadLookupConfig, LookupConfigError } from '../../config/lookup';

// ── configuration ────────────────────────────────────────────────────────────
describe('LOOKUP_FAST_TRANSLATOR configuration', () => {
  it('defaults to google', () => {
    expect(loadLookupConfig({}).lookup.fastTranslator).toBe('google');
    expect(loadLookupConfig({ LOOKUP_FAST_TRANSLATOR: '' }).lookup.fastTranslator).toBe('google');
  });

  it('accepts google and haiku (haiku needs the Anthropic key)', () => {
    expect(loadLookupConfig({ LOOKUP_FAST_TRANSLATOR: 'google' }).lookup.fastTranslator).toBe('google');
    expect(loadLookupConfig({ LOOKUP_FAST_TRANSLATOR: 'haiku', ANTHROPIC_API_KEY: 'sk-ant-test' }).lookup.fastTranslator).toBe('haiku');
  });

  it('haiku without ANTHROPIC_API_KEY stops the start-up with a clear message', () => {
    const err = (() => {
      try {
        loadLookupConfig({ LOOKUP_FAST_TRANSLATOR: 'haiku' });
      } catch (e) {
        return e as LookupConfigError;
      }
    })();
    expect(err).toBeInstanceOf(LookupConfigError);
    expect(err!.issues).toEqual(['ANTHROPIC_API_KEY: required when LOOKUP_FAST_TRANSLATOR=haiku']);
  });

  it('google mode never requires the Anthropic key', () => {
    expect(() => loadLookupConfig({ LOOKUP_FAST_TRANSLATOR: 'google' })).not.toThrow();
  });

  it.each(['gemini', 'Haiku', 'GOOGLE', 'true', '1'])('rejects %j and lists the variable without echoing the value', (value) => {
    try {
      loadLookupConfig({ LOOKUP_FAST_TRANSLATOR: value });
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(LookupConfigError);
      expect(e.issues[0]).toMatch(/^LOOKUP_FAST_TRANSLATOR: /);
      expect(e.message).not.toContain(`"${value}"`);
    }
  });

  it('the config object stays frozen', () => {
    expect(Object.isFrozen(loadLookupConfig({}).lookup)).toBe(true);
  });
});

// ── production wiring (services/lookup/index.ts: buildFastTranslator) ────────
const mockUsageAdd = jest.fn(async (..._a: any[]) => undefined);
let mockMode: 'google' | 'haiku' = 'google';

// The tests must not depend on the developer's local .env (one stray character there breaks config/lookup): do not load it.
jest.mock('dotenv', () => ({ __esModule: true, default: { config: jest.fn() }, config: jest.fn() }));
jest.mock('../../config/db', () => ({ query: jest.fn() }));
jest.mock('../../config/lookup', () => {
  const real = jest.requireActual('../../config/lookup');
  return {
    ...real,
    get lookupConfig() {
      return real.loadLookupConfig({ LOOKUP_FAST_TRANSLATOR: mockMode, ANTHROPIC_API_KEY: 'sk-ant-test', LOOKUP_MAX_MEANINGS: '3' });
    },
  };
});

describe('buildFastTranslator', () => {
  const okAnswer = {
    text: JSON.stringify({ meanings: [{ vi: 'ngân hàng', pos: 'noun' }, { vi: 'bờ sông', pos: 'noun' }, { vi: 'gửi tiền', pos: 'verb' }, { vi: 'nghiêng', pos: 'verb' }] }),
    stopReason: 'end_turn',
    usage: { inputTokens: 466, outputTokens: 80, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  };
  const clients: any = () => ({
    google: { translate: jest.fn(async () => ['ngân hàng']) },
    anthropicFast: { call: jest.fn(async () => okAnswer) },
    usage: { add: mockUsageAdd },
  });

  beforeEach(() => mockUsageAdd.mockClear());

  it('google (default) → the plain Google translator', () => {
    mockMode = 'google';
    const { buildFastTranslator } = require('../../services/lookup');
    expect(buildFastTranslator(clients())).toBeInstanceOf(GoogleFastTranslator);
  });

  it('haiku → Haiku with automatic Google fallback, honouring LOOKUP_MAX_MEANINGS', async () => {
    mockMode = 'haiku';
    const { buildFastTranslator } = require('../../services/lookup');
    const c = clients();
    const translator = buildFastTranslator(c);
    expect(translator).toBeInstanceOf(FallbackFastTranslator);

    const r = await translator.translate({ word: 'bank' });
    expect(r.engine).toBe('haiku');
    expect(r.meanings_vi).toHaveLength(3); // LOOKUP_MAX_MEANINGS=3
    expect(c.google.translate).not.toHaveBeenCalled();
  });

  it("haiku → token usage goes to api_usage_counters under provider 'anthropic_fast' for today (UTC)", async () => {
    mockMode = 'haiku';
    const { buildFastTranslator, HAIKU_FAST_USAGE_PROVIDER } = require('../../services/lookup');
    const translator = buildFastTranslator(clients());
    await translator.translate({ word: 'bank' });
    await new Promise((r) => setImmediate(r));

    const today = new Date().toISOString().slice(0, 10);
    expect(HAIKU_FAST_USAGE_PROVIDER).toBe('anthropic_fast');
    expect(mockUsageAdd).toHaveBeenCalledWith('anthropic_fast', 'input_tokens', today, 466);
    expect(mockUsageAdd).toHaveBeenCalledWith('anthropic_fast', 'output_tokens', today, 80);
  });

  it('haiku → on Haiku failure the Google client answers', async () => {
    mockMode = 'haiku';
    const { buildFastTranslator } = require('../../services/lookup');
    const c = clients();
    c.anthropicFast.call = jest.fn(async () => {
      throw new (require('../../services/upstream/errors').UpstreamUnavailable)('anthropic', 'timeout');
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await buildFastTranslator(c).translate({ word: 'bank' });
    expect(r).toMatchObject({ engine: 'google', fallback: { reason: 'timeout' } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fast_translator_fallback'));
    warn.mockRestore();
  });
});
