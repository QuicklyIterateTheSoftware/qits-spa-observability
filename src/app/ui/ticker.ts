import { DestroyRef, inject, signal, type Signal } from '@angular/core';

/**
 * A clock, as a signal, for the durations that grow while you watch them.
 *
 * The buffer's uptime and every record's age are computed from a timestamp against *now* — they are
 * not polled, and must not be: re-reading the store to learn what a subtraction already knows would
 * turn every visible row into traffic. Everything the server can change comes from the poll; this
 * only moves the second hand.
 *
 * Must be called in an injection context, which is what gives it the `DestroyRef` that stops it.
 */
export function tickingNow(intervalMs = 1000): Signal<number> {
  const now = signal(Date.now());
  const handle = setInterval(() => now.set(Date.now()), intervalMs);
  inject(DestroyRef).onDestroy(() => clearInterval(handle));
  return now.asReadonly();
}
