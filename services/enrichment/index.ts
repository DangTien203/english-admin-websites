import { getRefDb } from '../lookup/refDb';
import { getUpstreamClients } from '../upstream';
import { generateDraft, type DraftResult } from './draft';
import { createHaikuCaller, type HaikuCaller } from './haiku/client';
import { collectSources, type SourceDeps } from './sources';
import type { SourceBundle } from './types';

/**
 * Production wiring of the enrichment stages S1–S4 (config + real clients + real database).
 * P6a stops at the draft: nothing here writes to the dictionary tables (P6b does).
 */

export interface EnrichmentDeps {
  sources: SourceDeps;
  haiku: HaikuCaller;
}

export function createEnrichmentDeps(overrides: { tolerateFreeDictionaryError?: boolean } = {}): EnrichmentDeps {
  const clients = getUpstreamClients();
  return {
    sources: {
      refDb: getRefDb(),
      freeDictionary: clients.freeDictionary,
      datamuse: clients.datamuse,
      tolerateFreeDictionaryError: overrides.tolerateFreeDictionaryError,
    },
    haiku: createHaikuCaller(clients.anthropic),
  };
}

/** S1 + S3 + S4 for one word. Infrastructure errors propagate (see draft.ts). */
export async function draftWord(word: string, deps: EnrichmentDeps): Promise<{ bundle: SourceBundle; result: DraftResult }> {
  const bundle = await collectSources(word, deps.sources);
  const result = await generateDraft(bundle, { haiku: deps.haiku });
  return { bundle, result };
}

export { collectSources, generateDraft };
export { haikuSkipReason } from './sources';
export type { DraftResult, SourceBundle };
