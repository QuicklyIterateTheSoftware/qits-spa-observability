import type { SpanEventDto, TelemetryErrorGroupDto, TelemetrySpanDto } from '../api/dto';

/**
 * What one error group says about itself, as a pure function over the group.
 *
 * A function rather than a template expression, for the reason the waterfall's layout is one: the
 * shapes that matter here are the ones a careless rendering gets *plausibly* wrong, and each of them
 * is worth asserting directly instead of through the DOM. Three of them, measured live against the
 * deployed service rather than assumed:
 *
 * **A group's trace id can be empty, and then it is not a trace.** The service groups evidence it
 * could not correlate under an empty id. Posted fixture, read back: an ERROR log carrying no trace
 * id answers as a group with `traceId: ""`, `errorSpans: []` and one log in `errorLogs`. So the
 * uncorrelated group has **no spans at all** — a card that reached for `errorSpans[0]` to write its
 * headline would draw an empty one on the single group most in need of a sentence. It is also the
 * one card that must not link to `/traces/`, because there is nothing at the other end.
 *
 * **The headline is the exception's, when there is an exception.** A span event carries its own
 * `exception` boolean — the service's verdict, not a test on the event's name — and its attributes
 * carry `exception.type` and `exception.message`. That pair is what somebody came to the screen to
 * read. Where there is none, the span's `statusMessage` is the next best true sentence, and an
 * ERROR log's body after that. Where there is nothing at all the group says so, rather than drawing
 * a blank line that reads as a rendering fault.
 *
 * **The latest instant is derived, not given.** The group carries no timestamp of its own. It is the
 * newest end of its evidence: a span's start plus its duration, or a log's own stamp. Taking a
 * span's *start* instead would date a slow failure to the moment it began rather than the moment it
 * failed, which on a list sorted by recency is the wrong row in the wrong place.
 */

/** One group, with the figures a row draws, and its members left untouched underneath. */
export interface ErrorGroupView {
  /** The group itself, for the members an expanded row lists. */
  readonly group: TelemetryErrorGroupDto;
  /** The trace id, or the empty string for the uncorrelated group. */
  readonly traceId: string;
  /** True when this group is evidence the service could not correlate. It links nowhere. */
  readonly uncorrelated: boolean;
  /** The service that produced the evidence. */
  readonly serviceName: string;
  /** The exception, the status message, or the log body — in that order of preference. */
  readonly headline: string;
  /** What the headline came from, so a row never presents a log line as an exception. */
  readonly headlineKind: 'exception' | 'status' | 'log' | 'none';
  /** The exception type on its own, where there is one, for the row's marker. */
  readonly exceptionType: string;
  /** How many spans the service marked ERROR. */
  readonly spanCount: number;
  /** How many ERROR-or-worse log records are grouped here. */
  readonly logCount: number;
  /** The newest instant across every member, in epoch **milliseconds**, or 0 for an empty group. */
  readonly latestEpochMillis: number;
}

/** Nothing to draw. Kept as a value so a template never destructures a null. */
export const NO_GROUPS: readonly ErrorGroupView[] = [];

/**
 * The groups in the order the list draws them: the service's own order, with the uncorrelated group
 * moved to the end.
 *
 * The server's ordering is kept for everything else rather than re-sorted here — it is the same
 * answer the `telemetryErrors` MCP tool gives an agent, and a human and an agent debugging one
 * failure should be looking at the same list in the same order. The single exception is the
 * uncorrelated group, which the plan puts at the bottom because it is not a trace and reading it
 * between two traces invites the conclusion that it is one.
 */
export function viewErrorGroups(
  groups: readonly TelemetryErrorGroupDto[],
): readonly ErrorGroupView[] {
  const views = groups.map(viewErrorGroup);
  const correlated = views.filter((view) => !view.uncorrelated);
  const uncorrelated = views.filter((view) => view.uncorrelated);
  return [...correlated, ...uncorrelated];
}

/** One group's row figures. */
export function viewErrorGroup(group: TelemetryErrorGroupDto): ErrorGroupView {
  const exception = firstException(group.errorSpans);
  const headline = headlineOf(group, exception);
  return {
    group,
    traceId: group.traceId,
    uncorrelated: group.traceId === '',
    serviceName: group.serviceName,
    headline: headline.text,
    headlineKind: headline.kind,
    exceptionType: exception ? attribute(exception, 'exception.type') : '',
    spanCount: group.errorSpans.length,
    logCount: group.errorLogs.length,
    latestEpochMillis: latestOf(group),
  };
}

/** The exception event of the first span that has one — the service's own `exception` verdict. */
export function firstException(spans: readonly TelemetrySpanDto[]): SpanEventDto | null {
  for (const span of spans) {
    for (const event of span.events) {
      if (event.exception) {
        return event;
      }
    }
  }
  return null;
}

/** One attribute of an event as a string, or the empty string. Attributes are `unknown` on the wire. */
export function attribute(event: SpanEventDto, key: string): string {
  const value = event.attributes[key];
  return value === undefined || value === null ? '' : String(value);
}

function headlineOf(
  group: TelemetryErrorGroupDto,
  exception: SpanEventDto | null,
): { text: string; kind: ErrorGroupView['headlineKind'] } {
  if (exception) {
    const type = attribute(exception, 'exception.type');
    const message = attribute(exception, 'exception.message');
    const text = type && message ? `${type}: ${message}` : type || message;
    if (text) {
      return { text, kind: 'exception' };
    }
  }
  const status = group.errorSpans.find((span) => span.statusMessage.trim() !== '');
  if (status) {
    return { text: status.statusMessage, kind: 'status' };
  }
  const log = group.errorLogs.find((record) => record.body.trim() !== '');
  if (log) {
    return { text: log.body, kind: 'log' };
  }
  return { text: '', kind: 'none' };
}

/**
 * The newest instant across the group's evidence, in milliseconds.
 *
 * A span ends at its start plus its duration, and `durationMs` is integer milliseconds, so a
 * sub-millisecond span ends where it began — which is exactly right and is the finest figure the
 * buffer holds. Nanosecond epochs arrive as doubles and have already lost their low bits before this
 * code sees them; every comparison here is in milliseconds, five orders of magnitude above that.
 */
function latestOf(group: TelemetryErrorGroupDto): number {
  let latest = 0;
  for (const span of group.errorSpans) {
    latest = Math.max(latest, span.startEpochNanos / 1_000_000 + span.durationMs);
  }
  for (const log of group.errorLogs) {
    latest = Math.max(latest, log.epochNanos / 1_000_000);
  }
  return latest;
}
