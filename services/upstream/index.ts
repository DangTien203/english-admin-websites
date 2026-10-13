import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { AnthropicEnrichClient } from './anthropicEnrichClient';
import { ApiUsage } from './apiUsage';
import { BreakerState, CircuitBreaker } from './circuitBreaker';
import { DatamuseClient } from './datamuseClient';
import { UpstreamProvider } from './errors';
import { FreeDictionaryClient } from './freeDictionaryClient';
import { GoogleTranslateClient } from './googleTranslateClient';
import { TokenBucket } from './tokenBucket';

/**
 * Wires the four external-service clients from config/lookup.ts. NOT yet used by any endpoint
 * (P3 connects the fast path, P6 the enrichment job). Clients are created lazily, once per process.
 */

export interface UpstreamClients {
  google: GoogleTranslateClient;
  freeDictionary: FreeDictionaryClient;
  datamuse: DatamuseClient;
  anthropic: AnthropicEnrichClient;
  usage: ApiUsage;
  breakers: Record<UpstreamProvider, CircuitBreaker>;
}

let instance: UpstreamClients | undefined;

function logBreakerChange(provider: UpstreamProvider, from: BreakerState, to: BreakerState): void {
  // Opening is worth attention; the other transitions are routine.
  const log = to === 'open' ? console.warn : console.info;
  log(JSON.stringify({ evt: 'breaker', provider, from, to }));
}

export function getUpstreamClients(): UpstreamClients {
  if (instance) return instance;

  const cfg = lookupConfig;
  const makeBreaker = (provider: UpstreamProvider) =>
    new CircuitBreaker(provider, {
      failureThreshold: cfg.breaker.failureThreshold,
      resetMs: cfg.breaker.resetMs,
      onStateChange: logBreakerChange,
    });

  const breakers: Record<UpstreamProvider, CircuitBreaker> = {
    google_translate: makeBreaker('google_translate'),
    free_dictionary: makeBreaker('free_dictionary'),
    datamuse: makeBreaker('datamuse'),
    anthropic: makeBreaker('anthropic'),
  };
  const usage = new ApiUsage(pool);

  instance = {
    usage,
    breakers,
    google: new GoogleTranslateClient(
      {
        apiKey: cfg.google.apiKey,
        baseUrl: cfg.google.baseUrl,
        monthlyCharLimit: cfg.google.monthlyCharLimit,
        timeoutMs: cfg.lookup.upstreamTimeoutMs,
      },
      { usage, breaker: breakers.google_translate }
    ),
    freeDictionary: new FreeDictionaryClient(
      { baseUrl: cfg.freeDictionary.baseUrl, timeoutMs: cfg.lookup.upstreamTimeoutMs },
      {
        breaker: breakers.free_dictionary,
        bucket: new TokenBucket({ capacity: cfg.freeDictionary.maxRequestsPer5Min, windowMs: 5 * 60 * 1000 }),
      }
    ),
    datamuse: new DatamuseClient(
      { enabled: cfg.datamuse.enabled, baseUrl: cfg.datamuse.baseUrl, apiKey: cfg.datamuse.apiKey, timeoutMs: cfg.lookup.upstreamTimeoutMs },
      { breaker: breakers.datamuse, onDegraded: (word, err) => console.warn(JSON.stringify({ evt: 'datamuse_degraded', word, error: String((err as Error)?.message ?? err).slice(0, 200) })) }
    ),
    anthropic: new AnthropicEnrichClient(
      {
        apiKey: cfg.anthropic.apiKey,
        model: cfg.anthropic.modelEnrich,
        maxOutputTokens: cfg.anthropic.maxOutputTokensEnrich,
        timeoutMs: cfg.anthropic.timeoutMsEnrich,
      },
      { breaker: breakers.anthropic }
    ),
  };
  return instance;
}

export * from './errors';
