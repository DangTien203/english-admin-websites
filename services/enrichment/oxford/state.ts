/**
 * What `enrich:seed-oxford --confirm` remembers between runs, in a local file that is not committed (.oxford-seed.local.json).
 * No new table is needed: the report (`--report`) only has to know WHICH words were sent, WHEN, and what the counters and the
 * database size were before the first send. Nothing secret is stored.
 */
import fs from 'node:fs';
import path from 'node:path';

export const STATE_FILE = path.resolve(process.cwd(), '.oxford-seed.local.json');

export interface RunRecord {
  /** ISO time the sending started */
  startedAt: string;
  finishedAt: string | null;
  /** how the words were chosen, as typed (no file path is stored) */
  options: { sample?: number; limit?: number; offset?: number; onlyCefr?: string[]; retryLastRun?: boolean };
  model: string;
  publishPolicy: string;
  concurrency: number;
  /** words sent in this run (queued or already queued) */
  words: string[];
  stoppedBy: string | null;
  /** state of the database before the first send of THIS run */
  before: {
    dbBytes: number;
    /** api_usage_counters of provider 'anthropic' for the current month */
    anthropicInputTokens: number;
    anthropicOutputTokens: number;
    /** sum of the sizes of the tables the seeding writes to */
    tableBytes: number;
  };
  estimate: { words: number; costUsd: number; costSource: string; secondsPerWord: number; workerSeconds: number; days: number };
}

export interface SeedState {
  runs: RunRecord[];
}

export function readState(file: string = STATE_FILE): SeedState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { runs: Array.isArray(parsed?.runs) ? parsed.runs : [] };
  } catch {
    return { runs: [] };
  }
}

export function writeState(state: SeedState, file: string = STATE_FILE): void {
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function addRun(run: RunRecord, file: string = STATE_FILE): void {
  const state = readState(file);
  state.runs.push(run);
  writeState(state, file);
}

/** Every word sent by any run, once. */
export function allSentWords(state: SeedState): string[] {
  return [...new Set(state.runs.flatMap((r) => r.words))];
}
