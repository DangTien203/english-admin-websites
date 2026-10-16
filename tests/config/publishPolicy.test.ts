import { loadLookupConfig, LookupConfigError } from '../../config/lookup';
import { assembleEntry } from '../../services/enrichment/assemble';
import { makeBundle, makeDraft } from '../enrichment/fixtures';

/**
 * ENRICHMENT_PUBLISH_POLICY (docs/lookup-spec.md §1 and §10.3, version 1.5): the default is `review`. An entry written by the
 * background job stays unpublished until an admin publishes it, unless `auto` is set explicitly.
 */
describe('ENRICHMENT_PUBLISH_POLICY configuration', () => {
  const policy = (env: Record<string, string | undefined>) => loadLookupConfig(env as NodeJS.ProcessEnv).flags.enrichmentPublishPolicy;

  it('defaults to review when the variable is not set', () => {
    expect(policy({})).toBe('review');
    expect(policy({ ENRICHMENT_PUBLISH_POLICY: undefined })).toBe('review');
  });

  it('a blank value (an empty line in a hosting dashboard) is "not set", so it is review as well', () => {
    expect(policy({ ENRICHMENT_PUBLISH_POLICY: '' })).toBe('review');
    expect(policy({ ENRICHMENT_PUBLISH_POLICY: '   ' })).toBe('review');
  });

  it('auto is accepted only when it is set explicitly', () => {
    expect(policy({ ENRICHMENT_PUBLISH_POLICY: 'auto' })).toBe('auto');
    expect(policy({ ENRICHMENT_PUBLISH_POLICY: 'review' })).toBe('review');
  });

  it('any other value stops the start-up instead of silently choosing one policy, and the message names the variable but not the value', () => {
    let err: LookupConfigError | undefined;
    try {
      loadLookupConfig({ ENRICHMENT_PUBLISH_POLICY: 'publish-everything' } as NodeJS.ProcessEnv);
    } catch (e) {
      err = e as LookupConfigError;
    }
    expect(err).toBeInstanceOf(LookupConfigError);
    expect(err!.issues.join('\n')).toContain('ENRICHMENT_PUBLISH_POLICY');
    expect(err!.message).not.toContain('publish-everything');
  });

  it('the policy is part of the frozen configuration', () => {
    expect(Object.isFrozen(loadLookupConfig({} as NodeJS.ProcessEnv).flags)).toBe(true);
  });
});

describe('what the default means for an entry written by the job', () => {
  // makeBundle() + makeDraft() is an entry with tier A complete: under `auto` it is published (tests/enrichment/assemble.test.ts).
  const written = (env: Record<string, string | undefined>) => {
    const r = assembleEntry(makeBundle(), makeDraft(), {
      jobId: 'job-1',
      model: 'test-model',
      publishPolicy: loadLookupConfig(env as NodeJS.ProcessEnv).flags.enrichmentPublishPolicy,
      topicIds: new Map(),
    });
    if (r.status !== 'ok') throw new Error(`expected an entry, got ${JSON.stringify(r)}`);
    return r.entry;
  };

  it('with the variable unset the complete entry is created unpublished, and the note says it waits for review', () => {
    const e = written({});
    expect(e.report.tierAMissing).toEqual([]);
    expect(e.published).toBe(false);
    expect(e.adminNote).toContain('published=false: chờ duyệt (ENRICHMENT_PUBLISH_POLICY=review)');
  });

  it('only an explicit auto publishes it', () => {
    const e = written({ ENRICHMENT_PUBLISH_POLICY: 'auto' });
    expect(e.published).toBe(true);
    expect(e.adminNote).toContain('published=true (ENRICHMENT_PUBLISH_POLICY=auto)');
  });
});
