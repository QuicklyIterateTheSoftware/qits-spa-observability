/**
 * The wire shapes qits-observability answers with, as this application reads them.
 *
 * Hand-written rather than generated. The service's own generated schema names the controller's
 * nested response records `Response`, `Response1` … `Response4`, so a generated client would
 * inherit five interfaces nobody can read; and the platform's rule is that it generates documents,
 * not clients.
 *
 * Four facts run through the whole file and are worth stating once rather than at every field.
 *
 * **A source is named by an opaque key, and the key is passed back verbatim.** Buckets used to be
 * addressed by a `repositoryId` + `workspaceId` pair, and that pair cannot name the bucket every
 * qits service actually exports into: the lookup key is `repoId + "/" + workspaceId`, and no pair
 * produces a string with no slash in it. `?source=` is the way out. Nothing in this app builds a
 * key, parses one, or assumes a shape for one — {@link TelemetrySourceDto.key} is a token from the
 * sources listing and the only legal thing to do with it is send it back.
 *
 * **The store is a bounded, in-memory buffer and it empties on every restart.** There is no
 * database behind any of this. `startedAt` is when the process came up, not when telemetry began,
 * and `evictedSpans` is the difference between "the buffer is showing you everything" and "the
 * buffer is showing you what survived". Both are rendered, always.
 *
 * **`null` means unknown, never zero.** A `SERVICE` source has no `repositoryId` and answers null
 * for it; a source that has received nothing of a signal answers null for its oldest and newest
 * stamps. Zero is a measurement, null is the absence of one.
 *
 * **Time windows filter on the server's ingest stamp**, never on the exporter's own timestamps, and
 * a null `sinceMinutes` means "everything still buffered" — which is the honest default for a
 * bounded store and is what every screen here sends.
 */

/* ------------------------------------------------------------------------- the buffer's own state
 */

/** The three per-source count caps. Bytes bind second; these bind first, and always. */
export interface StoreCapsDto {
  readonly spansPerSource: number;
  readonly logsPerSource: number;
  readonly metricSeriesPerSource: number;
}

/**
 * `GET /observability/api/telemetry/store` — what the buffer is, right now.
 *
 * `startedAt` is the process's own start. It is the single most load-bearing field on this UI:
 * "empty" three minutes after a restart is the design working, and "empty" six hours in is a
 * service that has stopped receiving.
 *
 * The three eviction counters are cumulative since `startedAt`. They are shown whenever they are
 * non-zero, in ordinary weight — eviction is the bound doing its job, not a warning — and never
 * hidden, because they change what every other number here means.
 */
export interface StoreStateDto {
  readonly startedAt: string;
  readonly totalBytes: number;
  readonly maxTotalBytes: number;
  readonly caps: StoreCapsDto;
  readonly sourceCount: number;
  readonly evictedSpans: number;
  readonly evictedLogs: number;
  readonly droppedMetricSeries: number;
}

/* ------------------------------------------------------------------------------------ the sources
 */

/**
 * How a bucket came to exist.
 *
 * - `SERVICE` — a platform service's own export, bucketed by `service.name`. This is what everything
 *   on this platform produces today.
 * - `WORKSPACE` — a workspace dev server's export, the original addressing. Real, and empty: no
 *   workspace exports OTLP yet.
 * - `UNSCOPED` — telemetry carrying neither a service name nor the workspace pair. The quarantine.
 */
export type SourceKind = 'SERVICE' | 'WORKSPACE' | 'UNSCOPED';

/** One reporting service inside a bucket, with what it put there. */
export interface SourceServiceDto {
  readonly name: string;
  readonly spans: number;
  readonly logs: number;
  readonly metricSeries: number;
}

/**
 * One bucket of the store.
 *
 * `services` is what lets a screen offer a per-service filter whichever way the store buckets, and
 * it arrives with the row — so the Overview costs nothing per source.
 *
 * `oldestReceivedAt` / `newestReceivedAt` are what make "your window excludes what is buffered" a
 * distinguishable empty state rather than an indistinguishable one. Both are null for a bucket that
 * holds nothing.
 */
export interface TelemetrySourceDto {
  readonly key: string;
  readonly kind: SourceKind;
  readonly label: string;
  readonly repositoryId: string | null;
  readonly workspaceId: string | null;
  readonly services: readonly SourceServiceDto[];
  readonly spans: number;
  readonly logs: number;
  readonly metricSeries: number;
  readonly bytes: number;
  readonly oldestReceivedAt: string | null;
  readonly newestReceivedAt: string | null;
}

/** `GET /observability/api/telemetry/sources`. */
export interface SourcesResponse {
  readonly sources: readonly TelemetrySourceDto[];
}

/* ------------------------------------------------------------------------------------ the records
 */

/** OTel attribute maps arrive as string-keyed values of whatever the exporter stamped. */
export type Attributes = Readonly<Record<string, unknown>>;

/**
 * One event on a span. The interesting case is an exception, which carries `exception.type`,
 * `exception.message` and `exception.stacktrace` in its attributes.
 */
export interface SpanEventDto {
  readonly name: string;
  readonly epochNanos: number;
  readonly attributes: Attributes;
}

/**
 * One span.
 *
 * `parentSpanId` + `startEpochNanos` + `durationMs` is exactly a waterfall, which is why the trace
 * screen needs no chart library and does not have one.
 *
 * **`durationMs` is integer milliseconds.** A sub-millisecond span is `0`, so a bar drawn straight
 * from it is invisible; the renderer floors the width and prints the true value in the label.
 *
 * `parentSpanId` is empty on a root — and also on a span whose parent was evicted, which is common
 * in a bounded buffer and must be drawn as such rather than silently re-parented.
 */
export interface TelemetrySpanDto {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string;
  readonly serviceName: string;
  readonly scopeName: string;
  readonly name: string;
  readonly kind: string;
  readonly startEpochNanos: number;
  readonly durationMs: number;
  readonly status: string;
  readonly statusMessage: string;
  readonly attributes: Attributes;
  readonly events: readonly SpanEventDto[];
}

/**
 * One log record.
 *
 * `severityNumber` is the OTel scale, where **ERROR starts at 17**. `severityText` is the
 * exporter's own word for it and is what the service's `?query=` matches alongside the body.
 */
export interface TelemetryLogDto {
  readonly epochNanos: number;
  readonly severityNumber: number;
  readonly severityText: string;
  readonly body: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly serviceName: string;
  readonly attributes: Attributes;
}

/**
 * One metric series, at its latest value.
 *
 * There is exactly one point per series and it is replaced in place on arrival, so there is no
 * history and nothing to plot. `COUNTER` carries the latest cumulative total with no rate applied.
 */
export interface TelemetryMetricDto {
  readonly name: string;
  readonly description: string;
  readonly unit: string;
  readonly type: 'GAUGE' | 'COUNTER';
  readonly value: number;
  readonly epochNanos: number;
  readonly serviceName: string;
  readonly attributes: Attributes;
}

/**
 * The error spans and ERROR logs of one trace, grouped.
 *
 * **`traceId` may be empty**, and that is not a defect: evidence the service could not correlate to
 * a trace groups under an empty id. A UI must draw that group as "not correlated to a trace" and
 * must not link it to `/traces/`.
 */
export interface TelemetryErrorGroupDto {
  readonly traceId: string;
  readonly serviceName: string;
  readonly errorSpans: readonly TelemetrySpanDto[];
  readonly errorLogs: readonly TelemetryLogDto[];
}

/* ------------------------------------------------------------------------------------- the traces
 */

/**
 * One row of the trace list.
 *
 * `rootName` is the span with no parent. When no such span is buffered — because the root was
 * evicted, or belongs to a bucket this query did not ask for — it is the earliest span instead and
 * `rootMissing` is true. That condition is ordinary in a bounded buffer, and the row must say so
 * rather than present a plausible-looking wrong root.
 */
export interface TraceSummaryDto {
  readonly traceId: string;
  readonly rootName: string;
  readonly rootService: string;
  readonly services: readonly string[];
  readonly startEpochNanos: number;
  readonly durationMs: number;
  readonly spanCount: number;
  readonly errorSpanCount: number;
  readonly hasException: boolean;
  readonly rootMissing: boolean;
}

/** One whole trace: its spans and the logs correlated to them. */
export interface TraceDetailDto {
  readonly traceId: string;
  readonly spans: readonly TelemetrySpanDto[];
  readonly logs: readonly TelemetryLogDto[];
}

/**
 * The two lenses the store distinguishes.
 *
 * `recent` is "what just happened", `duration` is "what is slow". The service coerces anything it
 * does not recognise to `duration` **without complaining**, so a typo here is a silently wrong
 * screen; these are the only two strings this app ever sends.
 */
export type TraceSort = 'recent' | 'duration';

/* ---------------------------------------------------------------------------------- the envelopes
 */

/*
 * Every list endpoint answers `{ items…, total, truncated }`: `total` is how many matched, the array
 * is how many came back, and `truncated` says the two differ. The four envelopes below are that
 * shape under four different array names, which is the service's spelling and not this app's to
 * change. A response used to be the entire buffer — up to 5,000 spans or 10,000 logs in one body,
 * which is a budget no screen can hold.
 */

/** `GET …/telemetry/traces`. */
export interface TracesResponse {
  readonly traces: readonly TraceSummaryDto[];
  readonly total: number;
  readonly truncated: boolean;
}

/** `GET …/telemetry/traces/{traceId}`. Answers 200 with an empty trace for an id that never was. */
export interface TraceResponse {
  readonly trace: TraceDetailDto;
}

/** `GET …/telemetry/errors`. */
export interface ErrorsResponse {
  readonly groups: readonly TelemetryErrorGroupDto[];
  readonly total: number;
  readonly truncated: boolean;
}

/** `GET …/telemetry/logs`. Oldest-first by construction; a tail reverses for display, at no cost. */
export interface LogsResponse {
  readonly logs: readonly TelemetryLogDto[];
  readonly total: number;
  readonly truncated: boolean;
}

/** `GET …/telemetry/slow-spans`. */
export interface SpansResponse {
  readonly spans: readonly TelemetrySpanDto[];
  readonly total: number;
  readonly truncated: boolean;
}

/** `GET …/telemetry/metrics`. Unbounded, and it can be: there is one point per series, capped at 500. */
export interface MetricsResponse {
  readonly metrics: readonly TelemetryMetricDto[];
}

/* ------------------------------------------------------------------------------------- the shapes
 * of a query
 */

/**
 * What every screen's read has in common.
 *
 * `source` is the opaque key. **Sending none is not an error and answers an empty bucket** — the
 * service keys on `"null/null"` and finds nothing there — so a screen that loses its source looks
 * exactly like a service with no telemetry. Nothing here sends a request without one.
 */
export interface SourceQuery {
  readonly source: string;
  readonly service?: string | null;
}

/** A read that can be windowed and bounded. `sinceMinutes` null means everything still buffered. */
export interface ListQuery extends SourceQuery {
  readonly sinceMinutes?: number | null;
  readonly limit?: number | null;
}

/** The trace list's own lens. */
export interface TraceListQuery extends ListQuery {
  readonly sort?: TraceSort;
}

/** The log tail's substring, matched case-insensitively over the body **and** the severity text. */
export interface LogQuery extends ListQuery {
  readonly query?: string | null;
}

/** The slow-span lens. `thresholdMs: 0` admits every buffered span, which is the honest default. */
export interface SlowSpanQuery extends ListQuery {
  readonly thresholdMs?: number | null;
  readonly sort?: TraceSort;
}

/** The metric table's name filter. There is no limit here and no envelope. */
export interface MetricQuery extends SourceQuery {
  readonly name?: string | null;
}

/** The list default. Two hundred rows is more than any screen here draws at once. */
export const DEFAULT_LIMIT = 200;
