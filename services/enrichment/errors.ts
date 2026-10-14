/**
 * Errors of the enrichment pipeline that are NOT about an external service.
 *
 * EnrichmentConfigError: the environment is not set up for enrichment (e.g. the 30 topic tags are missing from
 * the `tags` table). Retrying cannot help, so the queue worker treats it like UpstreamConfigError:
 * the job row becomes failed / config_error and pg-boss does not retry (services/queue/enrichmentWorker.ts).
 */
export class EnrichmentConfigError extends Error {
  /** Short machine code, e.g. "topics_not_seeded". */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EnrichmentConfigError';
    this.code = code;
  }
}
