import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { QITS_API_BASE } from './api-base';
import type {
  ErrorsResponse,
  ListQuery,
  LogQuery,
  LogsResponse,
  MetricQuery,
  MetricsResponse,
  SlowSpanQuery,
  SourceQuery,
  SourcesResponse,
  SpansResponse,
  StoreStateDto,
  TelemetryMetricDto,
  TelemetrySourceDto,
  TraceDetailDto,
  TraceListQuery,
  TraceResponse,
  TracesResponse,
} from './dto';

/**
 * Everything this app reads, and it reads from exactly one upstream: qits-observability, through
 * the gateway, at `/observability/api/telemetry`. There is no second service to join against — the
 * buffer carries no project and no repository row — so this repository has one `@Injectable` rather
 * than the two spa-ci and spa-cd carry.
 *
 * Every call is a `GET`, every call is one-shot, and `firstValueFrom` unwraps the observable
 * immediately because a promise is what the pages' `async` methods want. `HttpClient` on the fetch
 * backend rather than bare `fetch()` buys two things — `HttpTestingController`, which is the whole
 * basis of this repository's specs, and a call that goes through `window.fetch`, where OTLP browser
 * instrumentation can see it. On *this* application in particular that second reason is not a
 * preference: a telemetry UI that is itself invisible to telemetry would be a joke at its own
 * expense.
 *
 * `httpResource()` would suit these reads and is deliberately not used: it is still marked
 * experimental in the pinned `@angular/common`, and this service is the seam that makes adopting it
 * later a change inside the page components rather than a rewrite.
 *
 * **Two rules about the wire, both of which have bitten somebody already.**
 *
 * A **missing scope is not an error**. Ask for logs with no `source` and the service answers `200`
 * with an empty list, because the bucket key it built matches nothing. So does asking for a trace id
 * that never existed. Every method below therefore takes its source as a required field rather than
 * an optional one — a request this app cannot name a bucket for is a bug, and it must fail in the
 * type system rather than render as "no telemetry".
 *
 * The **trace id goes in the path**, so it is `encodeURIComponent`'d. Everything else is an
 * `HttpParams` value and is encoded by `HttpClient`.
 */
@Injectable({ providedIn: 'root' })
export class ObservabilityApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(QITS_API_BASE);

  private get root(): string {
    return `${this.base}/observability/api/telemetry`;
  }

  /**
   * The buffer's own state: when this process came up, what it is holding, what its caps are, and
   * how much it has already evicted.
   *
   * Read app-wide rather than per screen. It is one of the two requests every page in this SPA
   * costs, and it is what makes the ephemerality statement a reading rather than a claim.
   */
  store(): Promise<StoreStateDto> {
    return firstValueFrom(this.http.get<StoreStateDto>(`${this.root}/store`));
  }

  /**
   * What is in the buffer, one entry per bucket, with a per-service breakdown inside each.
   *
   * This is the listing the old surface had no equivalent of at all: before it, a caller had to
   * already know a `repositoryId` and a `workspaceId` to ask anything. The `key` of an entry here is
   * the `?source=` every other call takes.
   */
  async sources(): Promise<readonly TelemetrySourceDto[]> {
    const response = await firstValueFrom(this.http.get<SourcesResponse>(`${this.root}/sources`));
    return response.sources;
  }

  /**
   * The trace list, grouped on the server over an index the store already maintains.
   *
   * Grouping this in the browser instead would mean pulling up to the whole span cap over the wire
   * to draw fifty rows. `sort` is the Recent/Slowest lens, and the service coerces an unrecognised
   * value to `duration` in silence — see {@link TraceSort}.
   */
  traces(query: TraceListQuery): Promise<TracesResponse> {
    const params = this.list(query).set('sort', query.sort ?? 'recent');
    return firstValueFrom(this.http.get<TracesResponse>(`${this.root}/traces`, { params }));
  }

  /**
   * One trace: its spans and its correlated logs, in one answer.
   *
   * **An unknown id is `200` with an empty trace**, and so is an evicted one — the response cannot
   * tell them apart and neither may the screen. The caller has the store's `evictedSpans` to hand
   * and should say "it may have been evicted, or the id may be wrong" only while that is non-zero.
   */
  async trace(traceId: string, query: SourceQuery): Promise<TraceDetailDto> {
    const response = await firstValueFrom(
      this.http.get<TraceResponse>(`${this.root}/traces/${encodeURIComponent(traceId)}`, {
        params: this.scope(query),
      }),
    );
    return response.trace;
  }

  /** The error groups: error spans and ERROR logs, per trace. Some groups have an empty trace id. */
  errors(query: ListQuery): Promise<ErrorsResponse> {
    return firstValueFrom(
      this.http.get<ErrorsResponse>(`${this.root}/errors`, { params: this.list(query) }),
    );
  }

  /**
   * The log tail, oldest-first as the store holds it.
   *
   * `query` matches case-insensitively over the body **and** the severity text, which surprises
   * anyone who searches for "error" — so the field that feeds this says so in its placeholder.
   */
  logs(query: LogQuery): Promise<LogsResponse> {
    let params = this.list(query);
    if (query.query) {
      params = params.set('query', query.query);
    }
    return firstValueFrom(this.http.get<LogsResponse>(`${this.root}/logs`, { params }));
  }

  /**
   * Every buffered span over a duration threshold.
   *
   * `thresholdMs: 0` admits everything — the filter is `durationMs >= thresholdMs` — which is how
   * this endpoint enumerates rather than filters.
   */
  slowSpans(query: SlowSpanQuery): Promise<SpansResponse> {
    let params = this.list(query).set('sort', query.sort ?? 'duration');
    if (query.thresholdMs !== null && query.thresholdMs !== undefined) {
      params = params.set('thresholdMs', String(query.thresholdMs));
    }
    return firstValueFrom(this.http.get<SpansResponse>(`${this.root}/slow-spans`, { params }));
  }

  /** The metric series at their latest values. One point each; there is no history to ask for. */
  async metrics(query: MetricQuery): Promise<readonly TelemetryMetricDto[]> {
    let params = this.scope(query);
    if (query.name) {
      params = params.set('name', query.name);
    }
    const response = await firstValueFrom(
      this.http.get<MetricsResponse>(`${this.root}/metrics`, { params }),
    );
    return response.metrics;
  }

  /** `?source=` and an optional `?service=` — what every read below the listings has in common. */
  private scope(query: SourceQuery): HttpParams {
    let params = new HttpParams().set('source', query.source);
    if (query.service) {
      params = params.set('service', query.service);
    }
    return params;
  }

  /**
   * The scope plus the window and the bound.
   *
   * A null `sinceMinutes` is **not sent**, and that is the honest default: the store is bounded
   * already, so "everything still buffered" is a smaller answer than the parameter suggests and is
   * the only window that never hides a record the buffer still holds.
   */
  private list(query: ListQuery): HttpParams {
    let params = this.scope(query);
    if (query.sinceMinutes !== null && query.sinceMinutes !== undefined) {
      params = params.set('sinceMinutes', String(query.sinceMinutes));
    }
    if (query.limit !== null && query.limit !== undefined) {
      params = params.set('limit', String(query.limit));
    }
    return params;
  }
}
