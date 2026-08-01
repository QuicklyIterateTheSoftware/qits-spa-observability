/**
 * The small conversions the screens need, kept out of the templates so they can be asserted
 * directly.
 *
 * Every timestamp is rendered in **UTC**, as in every sibling SPA: the services stamp `Instant`s and
 * a browser-local rendering would make two people looking at the same trace disagree about when it
 * happened.
 *
 * **No bare relative time.** {@link formatStamp} prints an absolute clock reading with a relative
 * suffix — `15:40:02 · 2 m ago` — and it is the only stamp the screens use for a record. This buffer
 * holds records that may predate your last page load by hours, so a bare "2 m ago" invites the
 * conclusion that what is on screen is what just happened. The absolute reading is what makes the
 * relative one safe to show.
 *
 * **Counts carry separators and bytes carry a unit.** The figures on this UI run to five digits —
 * `41233 spans evicted` is read wrong at a glance, `41,233` is not.
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/** What is drawn where there is nothing to draw — one em dash, everywhere. */
export const NONE = '—';

function parse(iso: string | null | undefined): Date | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

/** `14:06:23` — the clock reading of an instant, to the second, in UTC. */
export function formatClock(iso: string | null | undefined): string {
  const date = parse(iso);
  if (!date) {
    return NONE;
  }
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** `31 Jul 14:02` — a row's timestamp where the year is noise and the day is not. */
export function formatDayTime(iso: string | null | undefined): string {
  const date = parse(iso);
  if (!date) {
    return NONE;
  }
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** `31 Jul 2026 14:02:11Z` — the exact instant, where being exact is the point. */
export function formatInstant(iso: string | null | undefined): string {
  const date = parse(iso);
  if (!date) {
    return NONE;
  }
  return (
    `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * `6 h 18 m`, `2 m 05 s`, `41 s` — a span of time in the register the buffer band is written in.
 *
 * Spaced rather than spa-ci's tighter `1h 04m`, because these appear inside sentences here rather
 * than in a table cell.
 */
export function formatElapsed(millis: number): string {
  const total = Math.max(0, Math.round(millis / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) {
    return `${hours} h ${pad(minutes)} m`;
  }
  if (minutes > 0) {
    return `${minutes} m ${pad(seconds)} s`;
  }
  return `${seconds} s`;
}

/** How long ago an instant was, against a clock the caller supplies. `NONE` if it is unparseable. */
export function formatAge(iso: string | null | undefined, nowMs: number): string {
  const date = parse(iso);
  return date ? `${formatElapsed(nowMs - date.getTime())} ago` : NONE;
}

/**
 * `15:40:02 · 2 m ago` — the only form a record's time is drawn in on this UI.
 *
 * See this file's header for why the absolute half is not optional.
 */
export function formatStamp(iso: string | null | undefined, nowMs: number): string {
  const date = parse(iso);
  return date ? `${formatClock(iso)} · ${formatAge(iso, nowMs)}` : NONE;
}

/** `41,233` — a count, grouped, because these run to five digits and are misread without it. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return NONE;
  }
  return Math.round(value).toLocaleString('en-US');
}

/** `3.73 MiB` — a byte figure, never a bare number. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
    return NONE;
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${BYTE_UNITS[unit]}`;
}

/** `1,841 spans`, `1 span` — a count is never drawn without the noun it counts. */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${formatCount(count)} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

/** The first eight characters of a trace id — enough to recognise, short enough for a row. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
