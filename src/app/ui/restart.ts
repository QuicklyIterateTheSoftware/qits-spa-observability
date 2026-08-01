import type { StoreStateDto } from '../api/dto';
import { formatElapsed } from './format';

/**
 * The one home for "this buffer was emptied a moment ago", which every screen here has to be able
 * to say.
 *
 * A store that empties on restart makes the same blank table mean two opposite things: a process
 * that came up thirty seconds ago is working perfectly, and a process that has been up six hours
 * with nothing in it is not. Every screen therefore ends its empty-state ladder with this sentence,
 * and the sentence has to be the *same* sentence — a reader who meets it on the trace list and again
 * on the log tail must not have to work out whether the two are describing the same event.
 *
 * It lived in five copies before this file: one constant and one hand-assembled sentence on each of
 * the overview, the trace list, the errors list, the log tail and, once it was written, the metric
 * table. Five copies of a threshold is five chances to move one of them.
 *
 * **The lead is fixed and the coda is the caller's.** What was emptied is the same fact everywhere;
 * what the reader loses by it is not — a trace list loses traces, a tail loses lines, and the
 * overview loses the whole source list. So the first sentence is written here and each screen adds
 * the second in its own nouns.
 */

/**
 * How recent a restart has to be for it to be the whole explanation of an empty screen.
 *
 * Five minutes, and the figure is a judgement rather than a measurement: it is long enough that a
 * deploy's restart still explains a blank page while a reader is still looking at it, and short
 * enough that "it only just came up" cannot excuse a service that has been reachable and silent for
 * an hour. Past it the screens say what is actually true — nothing is exporting — which is a real
 * problem and must not be dressed up as a fresh start.
 */
export const RECENT_RESTART_MS = 5 * 60 * 1000;

/**
 * How long the buffer has been filling, or null when there is no readable start.
 *
 * Null covers both a store that has not been read yet and one whose `startedAt` will not parse. A
 * screen that let an unparseable stamp through would print "The buffer was emptied NaN ago", which
 * is the one thing worse than saying nothing.
 */
export function bufferAge(
  store: Pick<StoreStateDto, 'startedAt'> | null,
  nowMs: number,
): number | null {
  if (!store) {
    return null;
  }
  const started = new Date(store.startedAt).getTime();
  return Number.isNaN(started) ? null : Math.max(0, nowMs - started);
}

/**
 * The §5 row: "the store restarted recently", or the empty string when it did not.
 *
 * Returning the empty string rather than a boolean is what keeps the callers flat — every screen
 * uses it the same way, as the last rung of an empty-state ladder:
 *
 * ```ts
 * const restart = restartEmptied(this.buffer.storeValue(), this.now(), 'Anything logged before that is gone.');
 * if (restart) {
 *   return restart;
 * }
 * ```
 *
 * @param coda what this screen in particular lost, in its own nouns. It is required, because the
 *     sentence without it says a buffer was emptied and never says what that cost the reader.
 */
export function restartEmptied(
  store: Pick<StoreStateDto, 'startedAt'> | null,
  nowMs: number,
  coda: string,
): string {
  const age = bufferAge(store, nowMs);
  if (age === null || age >= RECENT_RESTART_MS) {
    return '';
  }
  return `The buffer was emptied ${formatElapsed(age)} ago when qits-observability restarted. ${coda}`;
}
