/**
 * Orders the steps of a Leitner review session.
 *
 * Words in Leitner box 4/5 are checked twice — English meaning first, Vietnamese
 * meaning later — so such a word owns two steps; every other word owns one.
 * The two checks of one word are kept at least MIN_STEPS_BETWEEN_CHECKS steps
 * apart so the learner has to recall the second meaning instead of answering it
 * straight after the first. Example: English check at step 1 → Vietnamese check
 * at step 4 or later.
 *
 * Pure functions only (no DB) so the ordering rules are easy to verify.
 */

export type ReviewCheck = 'en' | 'vi';

/** Steps (of any other word) that must sit between the two checks of one word. */
export const MIN_STEPS_BETWEEN_CHECKS = 2;
const MIN_STEP_DISTANCE = MIN_STEPS_BETWEEN_CHECKS + 1;

export interface QueueWord {
  id: string;
  /** true → English + Vietnamese check (box 4/5); false → Vietnamese check only. */
  dual: boolean;
}

export interface QueueStep {
  wordId: string;
  check: ReviewCheck;
  checkNumber: 1 | 2;
  checksTotal: 1 | 2;
}

interface Pending {
  word: QueueWord;
  /** First position at which the second check may be placed. */
  readyAt: number;
}

interface Remaining {
  pos: number;
  readyAt: number[];
  singles: number;
  duals: number;
}

type Move = 'pending' | 'single' | 'dual';

const firstStep = (word: QueueWord): QueueStep =>
  word.dual
    ? { wordId: word.id, check: 'en', checkNumber: 1, checksTotal: 2 }
    : { wordId: word.id, check: 'vi', checkNumber: 1, checksTotal: 1 };

const secondStep = (word: QueueWord): QueueStep => ({
  wordId: word.id,
  check: 'vi',
  checkNumber: 2,
  checksTotal: 2,
});

/**
 * Can the remaining work still fill positions pos, pos+1, … without gaps while
 * honouring the distance rule? Best case for the release times is that every
 * not-yet-started dual word starts first, so a dense schedule exists exactly
 * when, for every position u, enough steps have been released by u.
 */
function canFinish({ pos, readyAt, singles, duals }: Remaining): boolean {
  const total = readyAt.length + singles + 2 * duals;
  const readyNow = readyAt.filter((r) => r <= pos).length;
  const waiting = readyAt.filter((r) => r > pos);

  for (let u = pos; u < pos + total; u++) {
    const freshSeconds = Math.min(duals, Math.max(0, u - pos - MIN_STEP_DISTANCE + 1));
    const released =
      singles + duals + readyNow + waiting.filter((r) => r <= u).length + freshSeconds;
    if (released < u - pos + 1) return false;
  }
  return true;
}

/**
 * Used when the session is too small for the rule to hold (fewer than 3 words
 * with a dual word in it): spread the two checks as far apart as possible.
 */
function bestEffortSequence(words: QueueWord[]): QueueStep[] {
  const duals = words.filter((w) => w.dual);
  const singles = words.filter((w) => !w.dual);
  return [...duals.map(firstStep), ...singles.map(firstStep), ...duals.map(secondStep)];
}

/**
 * @param words  words in the order they should be started (shuffle beforehand)
 * @param random injectable randomness (0..1) for deterministic tests
 */
export function buildReviewSequence(
  words: QueueWord[],
  random: () => number = Math.random
): QueueStep[] {
  let singles = words.filter((w) => !w.dual).length;
  let duals = words.length - singles;

  if (!canFinish({ pos: 0, readyAt: [], singles, duals })) {
    return bestEffortSequence(words);
  }

  const fresh = [...words];
  const pending: Pending[] = [];
  const steps: QueueStep[] = [];

  while (fresh.length > 0 || pending.length > 0) {
    const pos = steps.length;

    const freshMoves: Move[] = [];
    if (fresh.length > 0) {
      const next: Move = fresh[0].dual ? 'dual' : 'single';
      const other: Move = next === 'dual' ? 'single' : 'dual';
      freshMoves.push(next);
      if ((other === 'dual' ? duals : singles) > 0) freshMoves.push(other);
    }

    // Placing a second check as soon as it is allowed would make the gap
    // predictable, so sometimes let a fresh word go first.
    const hasReady = pending.length > 0 && pending[0].readyAt <= pos;
    const order: Move[] = !hasReady
      ? freshMoves
      : freshMoves.length === 0 || random() < 0.5
        ? ['pending', ...freshMoves]
        : [...freshMoves, 'pending'];

    const afterMove = (move: Move): Remaining => {
      const readyAt = pending.map((p) => p.readyAt);
      let s = singles;
      let d = duals;
      if (move === 'pending') readyAt.shift();
      else if (move === 'single') s--;
      else {
        d--;
        readyAt.push(pos + MIN_STEP_DISTANCE);
      }
      return { pos: pos + 1, readyAt, singles: s, duals: d };
    };

    const move = order.find((m) => canFinish(afterMove(m))) ?? order[0] ?? 'pending';

    if (move === 'pending') {
      steps.push(secondStep(pending.shift()!.word));
    } else {
      const word = fresh.splice(fresh.findIndex((w) => w.dual === (move === 'dual')), 1)[0];
      steps.push(firstStep(word));
      if (word.dual) {
        duals--;
        pending.push({ word, readyAt: pos + MIN_STEP_DISTANCE });
      } else {
        singles--;
      }
    }
  }

  return steps;
}

/** Smallest number of steps between the two checks of any word (null when no word is checked twice). */
export function minStepsBetweenChecks(steps: QueueStep[]): number | null {
  const firstAt = new Map<string, number>();
  let min: number | null = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.checkNumber === 1) {
      firstAt.set(step.wordId, i);
    } else {
      const between = i - (firstAt.get(step.wordId) ?? i) - 1;
      min = min === null ? between : Math.min(min, between);
    }
  }
  return min;
}
