/**
 * The time window the errors list and the log tail share, and the one honest way to spell "no
 * window at all".
 *
 * **An absent window is not a very large one.** `sinceMinutes` unset means "everything still
 * buffered", and on a bounded store that is a *smaller* answer than the parameter suggests: the
 * buffer holds what it holds, and no window can show more than that. It is also the only setting
 * that can never hide a record the buffer is still keeping, which is why it is the default on both
 * screens rather than a tidy-looking number of minutes.
 *
 * **A window filters on the server's own ingest stamp**, never on the exporter's timestamps. A
 * record that took a minute to reach the collector is dated by its arrival here, and that is the
 * service's rule rather than this app's — worth knowing before concluding a window is off by a
 * minute.
 *
 * Shared by the two screens that offer it rather than copied into both, because they must agree:
 * `?since=15` means one thing, and a reader carrying the parameter from one screen to the other
 * must not silently get a different window.
 */

/** The window, in minutes, as a query parameter. Absent means everything still buffered. */
export const SINCE_PARAM = 'since';

/** The windows the control offers. `null` is first and is the default — see this file's header. */
export const WINDOW_PRESETS: readonly (number | null)[] = [null, 15, 60, 360, 1440];

/** What a window is called. `null` is "everything buffered", which is a different kind of answer. */
export function windowLabel(minutes: number | null): string {
  if (minutes === null) {
    return 'Everything buffered';
  }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? '1 day' : `${days} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** The window a URL asks for. Anything that is not a positive number reads as no window. */
export function readWindow(raw: string | null): number | null {
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : null;
}
