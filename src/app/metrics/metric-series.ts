import type { TelemetryMetricDto } from '../api/dto';
import { NONE, formatBytes, formatCount } from '../ui/format';

/**
 * The metric table's shaping, as pure functions over the response.
 *
 * It is a module rather than a handful of template expressions for the reason `trace-layout.ts` is:
 * the interesting cases are the ones a careless rendering gets *plausibly* wrong, and a plausible
 * wrong number on a metrics screen is worse than a blank one. A byte figure drawn as `1.6e8`, a
 * cumulative counter drawn with two decimal places it does not have, and two series of one metric
 * drawn in a different order on every ten-second poll are all things a reader would believe.
 *
 * **One point per series, and the series is the row.** The store holds a `LinkedHashMap` of one
 * `MetricPoint` per series and replaces it in place on arrival, so this response is a snapshot of
 * latest values and nothing else. There is no history behind it and therefore nothing to plot —
 * see {@link groupMetrics}' note on why that is stated on the screen rather than worked around.
 *
 * **A series is identified by its name and its attributes, and by nothing else.** Measured in the
 * service: `MetricPoint.seriesKey()` is the name plus the attribute set sorted by key, with the
 * reporting service *not* in it. So two services exporting `jvm.memory.used` with an identical
 * attribute set into one bucket share one row, and the row shows whichever reported last. Every
 * bucket on this platform today holds exactly one service, so it does not bite — but the screen says
 * so wherever a bucket holds more than one, because the collision is silent and the row looks fine.
 */

/** The unit string OTel uses for bytes. UCUM, not a word — `By`, never `B` or `bytes`. */
export const BYTE_UNIT = 'By';

/** One attribute of a series, as a template can iterate it. */
export interface AttributePair {
  readonly key: string;
  readonly value: string;
}

/** One row: a series of one metric, at the last value that arrived for it. */
export interface MetricSeriesView {
  /**
   * The store's own series identity — the name and the sorted attribute set. Unique inside a
   * response by construction, which is what makes it a safe `track` and a stable sort key.
   */
  readonly key: string;
  /** Which service reported it. Not part of the series identity; see this file's header. */
  readonly serviceName: string;
  /** The attribute set, sorted by key as the store sorts it. Empty for a single-series metric. */
  readonly attributes: readonly AttributePair[];
  /** The value, drawn for its unit. */
  readonly value: string;
  /** When the exporter stamped the point — its clock, not the service's ingest stamp. */
  readonly epochNanos: number;
}

/** What kind of instrument a metric is, plus the answer for a group whose series disagree. */
export type MetricKind = 'GAUGE' | 'COUNTER' | 'MIXED';

/** One metric name, with every series reported under it. */
export interface MetricGroup {
  readonly name: string;
  readonly description: string;
  readonly unit: string;
  readonly kind: MetricKind;
  readonly series: readonly MetricSeriesView[];
}

/** An empty grouping, so a template can stay flat where there is nothing to draw. */
export const NO_GROUPS: readonly MetricGroup[] = [];

/**
 * A value, drawn for the unit the exporter declared.
 *
 * Three rules, and each is a case a bare `{{ value }}` renders wrongly:
 *
 * - **`By` is bytes**, and a memory figure has eight or nine digits. `168,296,448` is read wrong at
 *   a glance and `160.50 MiB` is not, so the byte unit is the one unit that changes the number's
 *   form rather than only labelling it.
 * - **An integer stays an integer.** Cumulative counters arrive as JSON doubles with nothing after
 *   the point, and printing `41,233.00` would suggest a precision the instrument never claimed.
 * - **A small ratio is not zero.** `jvm.cpu.recent_utilization` sits around `0.002` and a fixed two
 *   decimals would draw every idle process as flat `0.00`. Six significant digits keeps the small
 *   readings, and anything under `0.0001` falls back to exponential rather than to a row of zeroes.
 */
export function formatMetricValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) {
    return NONE;
  }
  if (unit === BYTE_UNIT) {
    return formatBytes(value);
  }
  if (Number.isInteger(value)) {
    return formatCount(value);
  }
  const magnitude = Math.abs(value);
  if (magnitude < 1e-4) {
    return value.toExponential(3);
  }
  return value.toLocaleString('en-US', { maximumSignificantDigits: 6 });
}

/**
 * What a unit means, where the UCUM spelling is not readable as English — and the empty string
 * where it is.
 *
 * The raw unit stays on screen and stays authoritative: it is what the exporter declared, and
 * replacing `{thread}` with "threads" would be this app answering for an instrument it did not
 * write. The gloss sits beside it, because `1` and `{class}` are otherwise indistinguishable from
 * noise, and a reader who has not met UCUM has no way to tell that `1` means "a ratio" and not
 * "one".
 */
export function unitGloss(unit: string): string {
  const trimmed = unit.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed === '1') {
    return 'dimensionless — a ratio or a plain count';
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return `a count of ${trimmed.slice(1, -1)}`;
  }
  switch (trimmed) {
    case BYTE_UNIT:
      return 'bytes';
    case 's':
      return 'seconds';
    case 'ms':
      return 'milliseconds';
    case 'ns':
      return 'nanoseconds';
    case 'Hz':
      return 'hertz — events per second';
    case '%':
      return 'per cent';
    default:
      return '';
  }
}

/** A series' attributes, sorted by key exactly as the store sorts them into its series identity. */
export function attributePairs(attributes: TelemetryMetricDto['attributes']): AttributePair[] {
  return Object.entries(attributes)
    .map(([key, value]) => ({ key, value: String(value) }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * The response, grouped by metric name and filtered by a substring of it.
 *
 * **The filter is applied here rather than on the wire, and that is measured rather than
 * preferred.** The endpoint takes a `?name=`, and it is an *exact, case-sensitive* match: asked for
 * `memory` against a bucket holding five `jvm.memory.used` series it answered zero, and asked for
 * `JVM.MEMORY.USED` it answered zero as well. A search box wired to that would be a field that
 * silently requires its user to already know the answer. One read holds every series a bucket has —
 * there is one point per series and the store caps a bucket at 500 of them — so filtering in the
 * browser costs nothing, keeps the screen at one request, and lets the box mean what a reader
 * expects a box to mean.
 *
 * **The order is this function's, not the response's.** Series come back in the store's insertion
 * order, which is the order a process first exported them, and a table that reordered itself under a
 * ten-second poll would move a row out from under a reader mid-read. Groups sort by name and series
 * sort by their attribute set, both stable, both independent of what arrived when.
 */
export function groupMetrics(
  metrics: readonly TelemetryMetricDto[],
  nameFilter = '',
): readonly MetricGroup[] {
  const needle = nameFilter.trim().toLowerCase();
  const byName = new Map<string, TelemetryMetricDto[]>();

  for (const metric of metrics) {
    if (needle && !metric.name.toLowerCase().includes(needle)) {
      continue;
    }
    const bucket = byName.get(metric.name);
    if (bucket) {
      bucket.push(metric);
    } else {
      byName.set(metric.name, [metric]);
    }
  }

  return [...byName.entries()]
    .map(([name, members]) => toGroup(name, members))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** How many series a grouping holds in total — the figure the screen counts rows by. */
export function seriesCount(groups: readonly MetricGroup[]): number {
  return groups.reduce((total, group) => total + group.series.length, 0);
}

function toGroup(name: string, members: readonly TelemetryMetricDto[]): MetricGroup {
  const series = members
    .map((metric) => toSeries(metric))
    .sort((left, right) => left.key.localeCompare(right.key));
  return {
    name,
    /* The first non-empty wins: an exporter may declare a description on one series of an
       instrument and leave it off the rest, and a blank subtitle beside a described sibling would
       read as "this one is undocumented" rather than as the same instrument. */
    description: members.find((metric) => metric.description)?.description ?? '',
    unit: members.find((metric) => metric.unit)?.unit ?? '',
    kind: kindOf(members),
    series,
  };
}

function toSeries(metric: TelemetryMetricDto): MetricSeriesView {
  const attributes = attributePairs(metric.attributes);
  return {
    key: seriesKey(metric.name, attributes),
    serviceName: metric.serviceName,
    attributes,
    value: formatMetricValue(metric.value, metric.unit),
    epochNanos: metric.epochNanos,
  };
}

/**
 * The store's own series spelling: the name, then each attribute sorted by key.
 *
 * Rebuilt here rather than invented, because it is the identity the service already uses to decide
 * that two points are the same series — so it is unique within one response, which is exactly what
 * a `track` expression needs to be.
 */
function seriesKey(name: string, attributes: readonly AttributePair[]): string {
  return attributes.reduce((key, pair) => `${key}|${pair.key}=${pair.value}`, name);
}

/**
 * One kind for the group, or `MIXED` where its series disagree.
 *
 * `MIXED` should never appear — a kind is a property of the instrument, not of a series — but a
 * bucket can hold two services, and two services are free to declare the same metric name
 * differently. Drawing one of their badges over both would be picking a winner silently.
 */
function kindOf(members: readonly TelemetryMetricDto[]): MetricKind {
  const first = members[0]?.type ?? 'GAUGE';
  return members.every((metric) => metric.type === first) ? first : 'MIXED';
}
