import type { TelemetryLogDto, TelemetrySpanDto } from '../api/dto';

/**
 * A trace, turned into rows a template can draw with two percentages and an indent.
 *
 * This is a pure function over the spans, kept out of the component on purpose: the rules below are
 * the ones a bounded buffer forces, every one of them is a decision that can regress silently on
 * screen, and a function is something a spec can put a malformed trace into and read the answer
 * out of.
 *
 * **There is no chart library here and there will not be one.** `parentSpanId` gives the nesting,
 * `startEpochNanos` gives the offset and `durationMs` gives the length — a row is a `div` with a
 * `left` and a `width` in percent, and nothing on this screen is a curve. No SPA on this platform
 * carries a charting dependency, and the one place a chart was ever considered it was refused in
 * writing; this screen does not break that streak to draw rectangles.
 *
 * **Four things the measured data forces, and each of them has a spec.**
 *
 * *A parent can be missing.* Eviction removes spans one at a time, so a trace arrives with holes,
 * and a client span whose server parent lives in another source's bucket is not a hole at all — it
 * is ordinary. Either way the child is drawn at the top level with {@link WaterfallRow.parentMissing}
 * set, and it is **never silently re-parented**: an invented parent draws a plausible tree that
 * misstates who called whom.
 *
 * *Every buffered span is drawn.* After the walk, anything not yet emitted — a parent cycle, a span
 * that names itself — is appended at the top level with the same marker rather than dropped. A span
 * the buffer holds and this screen does not show would be the one failure mode nobody could see.
 *
 * *`durationMs` is integer milliseconds.* A sub-millisecond span is `0` and computes to a zero-width
 * bar, which would be invisible. The width is left honest at 0 and the **bar is floored in CSS**, so
 * the geometry stays a true proportion while the row stays visible; the label says `<1 ms`, which is
 * exactly what a `0` here means and is more than "0 ms" says.
 *
 * *Nanosecond stamps exceed `Number.MAX_SAFE_INTEGER`.* An epoch in nanoseconds is a 61-bit figure
 * and JSON hands it to a double, so the low ~8 bits are lost — measured, the error is tens of
 * nanoseconds. Every arithmetic here lands in milliseconds, where that is five orders of magnitude
 * below the smallest thing drawn, so it is recorded rather than defended against.
 */

const NANOS_PER_MS = 1_000_000;

/** One span, placed. `leftPercent` and `widthPercent` are the whole geometry. */
export interface WaterfallRow {
  readonly span: TelemetrySpanDto;
  /** How deep in the call tree, from 0. Purely an indent; it never changes the bar. */
  readonly depth: number;
  /** Where the bar starts, as a percentage of the trace's own window. */
  readonly leftPercent: number;
  /** How long the bar is, as a percentage of that window. Honestly 0 for a sub-ms span. */
  readonly widthPercent: number;
  /** Its parent is named and is not buffered — so it is drawn at the top level and says so. */
  readonly parentMissing: boolean;
  /** The service reported `ERROR` status on it. */
  readonly isError: boolean;
  /** It carries an event the service marked as an exception. */
  readonly hasException: boolean;
  /** How many correlated log records name this span. */
  readonly logCount: number;
}

/** The whole trace, laid out. */
export interface Waterfall {
  readonly rows: readonly WaterfallRow[];
  /** The earliest instant any buffered span starts at — the left edge of every bar's percentage. */
  readonly startEpochNanos: number;
  /** How wide the window is, in milliseconds. Zero when there is nothing to divide by. */
  readonly windowMs: number;
  /**
   * No span with an empty `parentSpanId` is buffered.
   *
   * The trace list answers this as a field; the detail response does not, so it is derived here
   * from the same condition the service uses. It is common in a bounded buffer, and the screen says
   * so rather than presenting the earliest span as though it were the root.
   */
  readonly rootMissing: boolean;
  /** Every service that reported a span, in first-seen order — the legend, and the colour index. */
  readonly services: readonly string[];
  /** Spans with `ERROR` status. */
  readonly errorCount: number;
}

/** The empty answer, which is what an unknown *and* an evicted trace both look like. */
export const EMPTY_WATERFALL: Waterfall = {
  rows: [],
  startEpochNanos: 0,
  windowMs: 0,
  rootMissing: false,
  services: [],
  errorCount: 0,
};

/**
 * Lay a trace out.
 *
 * `logs` is read only for the per-span count on each row; the rail below the waterfall renders them
 * itself, in time order, because a log's place in a trace is when it happened and not where its
 * span sits in a tree.
 */
export function layOutTrace(
  spans: readonly TelemetrySpanDto[],
  logs: readonly TelemetryLogDto[] = [],
): Waterfall {
  if (spans.length === 0) {
    return EMPTY_WATERFALL;
  }

  const byId = new Map<string, TelemetrySpanDto>();
  for (const span of spans) {
    byId.set(span.spanId, span);
  }

  /** A span is drawn at the top level when it has no parent, or names one nobody buffered. */
  const isTopLevel = (span: TelemetrySpanDto): boolean =>
    !span.parentSpanId || span.parentSpanId === span.spanId || !byId.has(span.parentSpanId);

  const children = new Map<string, TelemetrySpanDto[]>();
  const roots: TelemetrySpanDto[] = [];
  for (const span of spans) {
    if (isTopLevel(span)) {
      roots.push(span);
      continue;
    }
    const siblings = children.get(span.parentSpanId);
    if (siblings) {
      siblings.push(span);
    } else {
      children.set(span.parentSpanId, [span]);
    }
  }

  const byStart = (left: TelemetrySpanDto, right: TelemetrySpanDto): number =>
    left.startEpochNanos - right.startEpochNanos || left.spanId.localeCompare(right.spanId);
  roots.sort(byStart);
  for (const siblings of children.values()) {
    siblings.sort(byStart);
  }

  const windowStart = spans.reduce(
    (earliest, span) => Math.min(earliest, span.startEpochNanos),
    Number.POSITIVE_INFINITY,
  );
  const windowEnd = spans.reduce(
    (latest, span) => Math.max(latest, span.startEpochNanos + span.durationMs * NANOS_PER_MS),
    Number.NEGATIVE_INFINITY,
  );
  const windowMs = Math.max(0, (windowEnd - windowStart) / NANOS_PER_MS);

  const logCounts = new Map<string, number>();
  for (const log of logs) {
    if (log.spanId) {
      logCounts.set(log.spanId, (logCounts.get(log.spanId) ?? 0) + 1);
    }
  }

  const rows: WaterfallRow[] = [];
  const emitted = new Set<string>();

  const place = (span: TelemetrySpanDto, depth: number, parentMissing: boolean): WaterfallRow => {
    const offsetMs = (span.startEpochNanos - windowStart) / NANOS_PER_MS;
    const left = windowMs > 0 ? clamp((offsetMs / windowMs) * 100, 0, 100) : 0;
    const width = windowMs > 0 ? clamp((span.durationMs / windowMs) * 100, 0, 100 - left) : 0;
    return {
      span,
      depth,
      leftPercent: left,
      widthPercent: width,
      parentMissing,
      isError: span.status === 'ERROR',
      hasException: span.events.some((event) => event.exception),
      logCount: logCounts.get(span.spanId) ?? 0,
    };
  };

  /*
   * Iterative rather than recursive: a trace can be a few thousand spans deep in principle, and a
   * blown stack on a malformed one would take the screen with it. `emitted` is what makes a cycle
   * terminate — a span already drawn is not drawn again beneath itself.
   */
  const walk = (root: TelemetrySpanDto): void => {
    const stack: { span: TelemetrySpanDto; depth: number }[] = [{ span: root, depth: 0 }];
    while (stack.length > 0) {
      const { span, depth } = stack.pop()!;
      if (emitted.has(span.spanId)) {
        continue;
      }
      emitted.add(span.spanId);
      rows.push(place(span, depth, depth === 0 && !!span.parentSpanId));
      const kids = children.get(span.spanId) ?? [];
      for (let index = kids.length - 1; index >= 0; index -= 1) {
        stack.push({ span: kids[index], depth: depth + 1 });
      }
    }
  };

  for (const root of roots) {
    walk(root);
  }

  /*
   * Whatever a cycle swallowed. These are unreachable from any top-level span, so they have no
   * honest depth — they go to the top level with the marker, because showing a span in the wrong
   * place is recoverable and not showing one the buffer holds is not.
   */
  for (const span of [...spans].sort(byStart)) {
    if (!emitted.has(span.spanId)) {
      emitted.add(span.spanId);
      rows.push(place(span, 0, true));
    }
  }

  const services: string[] = [];
  for (const span of spans) {
    if (span.serviceName && !services.includes(span.serviceName)) {
      services.push(span.serviceName);
    }
  }

  return {
    rows,
    startEpochNanos: windowStart,
    windowMs,
    rootMissing: !spans.some((span) => !span.parentSpanId),
    services,
    errorCount: spans.filter((span) => span.status === 'ERROR').length,
  };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) {
    return low;
  }
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * `812 ms`, `<1 ms` — a span's own length, said truthfully.
 *
 * `0` from this service means "under a millisecond", not "instantaneous": the figure is integer
 * milliseconds and the store has no finer one to give. `<1 ms` is the only rendering of it that is
 * both true and useful.
 */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '—';
  }
  if (durationMs === 0) {
    return '<1 ms';
  }
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 2 : 1)} s`;
}
