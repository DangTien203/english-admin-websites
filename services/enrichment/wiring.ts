import pool from '../../config/db';
import { lookupConfig } from '../../config/lookup';
import { getRefDb } from '../lookup/refDb';
import { getUpstreamClients } from '../upstream';
import { generateDraft } from './draft';
import { createHaikuCaller } from './haiku/client';
import type { PipelineDeps } from './pipeline';
import { findExistingEntry, linkFormOnly, persistEntry, type PersistPool } from './persist';
import { collectSources } from './sources';
import { loadTopicIds } from './topics';
import { withUsageRecording } from './usage';

/**
 * Production wiring of the pipeline: the main pool (dictionary, tags, counters), the reference-data database (ref_* tables; the
 * same pool unless REFDATA_DATABASE_URL is set), and the shared upstream clients with their circuit breakers.
 * Kept apart from pipeline.ts so that the pipeline itself can be tested with plain fakes.
 */
export function createProductionDeps(): PipelineDeps {
  const clients = getUpstreamClients();
  const refDb = getRefDb();
  const haiku = withUsageRecording(createHaikuCaller(clients.anthropic), pool);
  const writePool = pool as unknown as PersistPool;

  return {
    ensureTopics: () => loadTopicIds(pool),
    publishPolicy: () => lookupConfig.flags.enrichmentPublishPolicy,
    findExisting: (words) => findExistingEntry(pool, words),
    collectSources: (word, { signal }) =>
      collectSources(word, { refDb, freeDictionary: clients.freeDictionary, datamuse: clients.datamuse, signal }),
    generateDraft: (bundle, { signal }) => generateDraft(bundle, { haiku, signal }),
    persist: (entry, ctx) => persistEntry(writePool, entry, ctx),
    linkForm: (entryId, form, type) => linkFormOnly(writePool, entryId, form, type),
  };
}
