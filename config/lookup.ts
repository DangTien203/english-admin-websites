import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Configuration for fast word lookup + dictionary self-enrichment.
 * Source of truth for variable names, types and defaults: docs/lookup-spec.md §1.
 *
 * - Validated once at import time; invalid values throw LookupConfigError listing
 *   every offending variable (names only — values are never printed).
 * - The exported object is deeply frozen.
 */

// ── Env helpers ──────────────────────────────────────────────────────────────

/** Empty / whitespace-only env values behave like "not set". */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const envBool = (def: boolean) =>
  z.preprocess(
    (raw) => {
      const v = blankToUndefined(raw);
      if (typeof v !== 'string') return v;
      const s = v.trim().toLowerCase();
      return s === 'true' ? true : s === 'false' ? false : v;
    },
    z.boolean({ error: 'must be "true" or "false"' }).default(def)
  );

const envInt = (def: number, min: number, max: number) =>
  z.preprocess(
    (raw) => {
      const v = blankToUndefined(raw);
      if (typeof v !== 'string') return v;
      return /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : v;
    },
    z
      .number({ error: 'must be an integer' })
      .int({ error: 'must be an integer' })
      .min(min, { error: `must be >= ${min}` })
      .max(max, { error: `must be <= ${max}` })
      .default(def)
  );

const envString = (def: string) =>
  z.preprocess(blankToUndefined, z.string().trim().min(1).default(def));

const envOptionalString = z.preprocess(blankToUndefined, z.string().trim().optional());

const envHttpUrl = (def: string) =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .refine((s) => /^https?:\/\/[^\s/]+/i.test(s), { error: 'must be an http(s) URL' })
      .transform((s) => s.replace(/\/+$/, ''))
      .default(def)
  );

const envPgUrl = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .refine((s) => /^postgres(ql)?:\/\//i.test(s), {
      error: 'must start with postgres:// or postgresql://',
    })
    .optional()
);

const PG_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/i;

// ── Schema (names match docs/lookup-spec.md §1 exactly) ──────────────────────

const envSchema = z.object({
  TRANSLATION_FALLBACK_ENABLED: envBool(true),
  ENRICHMENT_ENABLED: envBool(false),
  ENRICHMENT_WORKER_ENABLED: envBool(true),
  ENRICHMENT_PUBLISH_POLICY: z.preprocess(
    blankToUndefined,
    z.enum(['auto', 'review'], { error: 'must be "auto" or "review"' }).default('auto')
  ),

  LOOKUP_UPSTREAM_TIMEOUT_MS: envInt(2500, 100, 30_000),
  LOOKUP_TOTAL_DEADLINE_MS: envInt(3000, 200, 60_000),
  LOOKUP_MAX_MEANINGS: envInt(4, 1, 10),
  LOOKUP_TRANSLATE_DEFINITIONS: envBool(true),
  LOOKUP_MISS_RATE_LIMIT_PER_MIN: envInt(20, 1, 1000),

  GOOGLE_TRANSLATE_API_KEY: envOptionalString,
  GOOGLE_TRANSLATE_BASE_URL: envHttpUrl('https://translation.googleapis.com/language/translate/v2'),
  GOOGLE_TRANSLATE_MONTHLY_CHAR_LIMIT: envInt(450_000, 0, 1_000_000_000),
  GOOGLE_TRANSLATE_MAX_DEFINITION_CHARS: envInt(160, 20, 1000),

  FREE_DICTIONARY_BASE_URL: envHttpUrl('https://api.dictionaryapi.dev/api/v2/entries/en'),
  FREE_DICTIONARY_MAX_REQUESTS_PER_5MIN: envInt(400, 1, 100_000),

  ANTHROPIC_API_KEY: envOptionalString,
  ANTHROPIC_MODEL_ENRICH: envString('claude-haiku-5-5'),
  ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH: envInt(4000, 256, 64_000),
  ANTHROPIC_TIMEOUT_MS_ENRICH: envInt(60_000, 1000, 600_000),

  DATAMUSE_ENABLED: envBool(true),
  DATAMUSE_BASE_URL: envHttpUrl('https://api.datamuse.com'),
  DATAMUSE_API_KEY: envOptionalString,

  PGBOSS_SCHEMA: z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .refine((s) => PG_IDENTIFIER.test(s), {
        error: 'must be a plain Postgres identifier (letters, digits, underscore)',
      })
      .default('pgboss')
  ),
  PGBOSS_POOL_MAX: envInt(5, 1, 50),
  ENRICHMENT_WORKER_CONCURRENCY: envInt(2, 1, 20),
  ENRICHMENT_JOB_RETRY_LIMIT: envInt(3, 0, 20),
  ENRICHMENT_JOB_RETRY_DELAY_SECONDS: envInt(30, 0, 86_400),
  ENRICHMENT_MAX_JOBS_PER_DAY: envInt(500, 0, 1_000_000),

  UPSTREAM_BREAKER_FAILURE_THRESHOLD: envInt(5, 1, 100),
  UPSTREAM_BREAKER_RESET_MS: envInt(30_000, 1000, 3_600_000),

  REFDATA_DATABASE_URL: envPgUrl,
});

// ── Public shape ─────────────────────────────────────────────────────────────

export type DeepReadonly<T> = T extends (infer U)[]
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export interface LookupConfig {
  flags: {
    translationFallbackEnabled: boolean;
    enrichmentEnabled: boolean;
    enrichmentWorkerEnabled: boolean;
    enrichmentPublishPolicy: 'auto' | 'review';
  };
  lookup: {
    upstreamTimeoutMs: number;
    totalDeadlineMs: number;
    maxMeanings: number;
    translateDefinitions: boolean;
    missRateLimitPerMin: number;
  };
  google: {
    /** Empty key = Google disabled. */
    apiKey: string | undefined;
    enabled: boolean;
    baseUrl: string;
    monthlyCharLimit: number;
    maxDefinitionChars: number;
  };
  freeDictionary: {
    baseUrl: string;
    maxRequestsPer5Min: number;
  };
  anthropic: {
    apiKey: string | undefined;
    modelEnrich: string;
    maxOutputTokensEnrich: number;
    timeoutMsEnrich: number;
  };
  datamuse: {
    enabled: boolean;
    baseUrl: string;
    /** Empty key = unauthenticated calls. */
    apiKey: string | undefined;
  };
  queue: {
    schema: string;
    poolMax: number;
    workerConcurrency: number;
    jobRetryLimit: number;
    jobRetryDelaySeconds: number;
    maxJobsPerDay: number;
  };
  breaker: {
    failureThreshold: number;
    resetMs: number;
  };
  refdata: {
    /** Set = ref_* tables live in this database instead of the main one. */
    databaseUrl: string | undefined;
  };
}

export class LookupConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `Invalid lookup configuration (${issues.length} problem${issues.length === 1 ? '' : 's'}):\n` +
        issues.map((i) => `  - ${i}`).join('\n')
    );
    this.name = 'LookupConfigError';
    this.issues = issues;
  }
}

/** Dates are compared as UTC calendar days. */
export const DATAMUSE_KEY_REQUIRED_FROM = '2027-01-01';

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const value of Object.values(obj as Record<string, unknown>)) deepFreeze(value);
  }
  return obj;
}

/**
 * Pure loader (no side effects, no logging) so it can be unit-tested with a fake env.
 * Throws LookupConfigError listing every invalid variable. Never includes values.
 */
export function loadLookupConfig(env: NodeJS.ProcessEnv): DeepReadonly<LookupConfig> {
  const parsed = envSchema.safeParse(env);
  const issues: string[] = [];

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
  } else if (parsed.data.ENRICHMENT_ENABLED && !parsed.data.ANTHROPIC_API_KEY) {
    issues.push('ANTHROPIC_API_KEY: required when ENRICHMENT_ENABLED=true');
  }

  if (!parsed.success || issues.length > 0) {
    throw new LookupConfigError(issues);
  }

  const e = parsed.data;
  const config: LookupConfig = {
    flags: {
      translationFallbackEnabled: e.TRANSLATION_FALLBACK_ENABLED,
      enrichmentEnabled: e.ENRICHMENT_ENABLED,
      enrichmentWorkerEnabled: e.ENRICHMENT_WORKER_ENABLED,
      enrichmentPublishPolicy: e.ENRICHMENT_PUBLISH_POLICY,
    },
    lookup: {
      upstreamTimeoutMs: e.LOOKUP_UPSTREAM_TIMEOUT_MS,
      totalDeadlineMs: e.LOOKUP_TOTAL_DEADLINE_MS,
      maxMeanings: e.LOOKUP_MAX_MEANINGS,
      translateDefinitions: e.LOOKUP_TRANSLATE_DEFINITIONS,
      missRateLimitPerMin: e.LOOKUP_MISS_RATE_LIMIT_PER_MIN,
    },
    google: {
      apiKey: e.GOOGLE_TRANSLATE_API_KEY,
      enabled: Boolean(e.GOOGLE_TRANSLATE_API_KEY),
      baseUrl: e.GOOGLE_TRANSLATE_BASE_URL,
      monthlyCharLimit: e.GOOGLE_TRANSLATE_MONTHLY_CHAR_LIMIT,
      maxDefinitionChars: e.GOOGLE_TRANSLATE_MAX_DEFINITION_CHARS,
    },
    freeDictionary: {
      baseUrl: e.FREE_DICTIONARY_BASE_URL,
      maxRequestsPer5Min: e.FREE_DICTIONARY_MAX_REQUESTS_PER_5MIN,
    },
    anthropic: {
      apiKey: e.ANTHROPIC_API_KEY,
      modelEnrich: e.ANTHROPIC_MODEL_ENRICH,
      maxOutputTokensEnrich: e.ANTHROPIC_MAX_OUTPUT_TOKENS_ENRICH,
      timeoutMsEnrich: e.ANTHROPIC_TIMEOUT_MS_ENRICH,
    },
    datamuse: {
      enabled: e.DATAMUSE_ENABLED,
      baseUrl: e.DATAMUSE_BASE_URL,
      apiKey: e.DATAMUSE_API_KEY,
    },
    queue: {
      schema: e.PGBOSS_SCHEMA,
      poolMax: e.PGBOSS_POOL_MAX,
      workerConcurrency: e.ENRICHMENT_WORKER_CONCURRENCY,
      jobRetryLimit: e.ENRICHMENT_JOB_RETRY_LIMIT,
      jobRetryDelaySeconds: e.ENRICHMENT_JOB_RETRY_DELAY_SECONDS,
      maxJobsPerDay: e.ENRICHMENT_MAX_JOBS_PER_DAY,
    },
    breaker: {
      failureThreshold: e.UPSTREAM_BREAKER_FAILURE_THRESHOLD,
      resetMs: e.UPSTREAM_BREAKER_RESET_MS,
    },
    refdata: {
      databaseUrl: e.REFDATA_DATABASE_URL,
    },
  };

  return deepFreeze(config) as DeepReadonly<LookupConfig>;
}

/** Non-fatal startup warnings (spec §1). Pure: returns messages, caller logs them. */
export function getLookupConfigWarnings(
  config: DeepReadonly<LookupConfig>,
  now: Date = new Date()
): string[] {
  const warnings: string[] = [];

  if (!config.google.enabled) {
    warnings.push('GOOGLE_TRANSLATE_API_KEY is empty: Google Translate is disabled.');
  }
  if (
    config.datamuse.enabled &&
    !config.datamuse.apiKey &&
    now.toISOString().slice(0, 10) >= DATAMUSE_KEY_REQUIRED_FROM
  ) {
    warnings.push(
      `DATAMUSE_API_KEY is empty and today is on/after ${DATAMUSE_KEY_REQUIRED_FROM}: ` +
        'Datamuse calls may require a key.'
    );
  }

  return warnings;
}

export const lookupConfig: DeepReadonly<LookupConfig> = loadLookupConfig(process.env);

// Warn once per process at startup (module is cached after first import).
for (const message of getLookupConfigWarnings(lookupConfig)) {
  console.warn(`[lookup-config] ${message}`);
}
