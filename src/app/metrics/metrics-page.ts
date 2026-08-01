import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink, convertToParamMap } from '@angular/router';
import { QitsBadge, QitsButton } from '@qits/ui-components';
import type { TelemetryMetricDto } from '../api/dto';
import { ObservabilityApi } from '../api/observability-api';
import { selectedSource } from '../buffer/selected-source';
import { SourceStrip } from '../buffer/source-strip';
import { TelemetryBuffer } from '../buffer/telemetry-buffer';
import { Async } from '../ui/async';
import { Empty } from '../ui/empty';
import { formatCount, formatStamp, plural } from '../ui/format';
import { IDLE, LOADING, describeError, failed, ready, type Loadable } from '../ui/loadable';
import { restartEmptied } from '../ui/restart';
import { tickingNow } from '../ui/ticker';
import { NO_GROUPS, groupMetrics, seriesCount, unitGloss, type MetricKind } from './metric-series';

/**
 * How often the table re-reads itself.
 *
 * Ten seconds, the app's ordinary screen cadence and the same one the band above it keeps, because
 * the two describe one moment: a source's series count in the band beside values read ten seconds
 * earlier would be two readings presented as one. The tail is the only screen here that goes
 * faster, and only while it is following.
 */
export const METRIC_TABLE_POLL_INTERVAL_MS = 10_000;

/** What a failed poll falls back to. The last good table stays on screen and is marked stale. */
export const METRIC_TABLE_BACKOFF_INTERVAL_MS = 30_000;

/** The metric-name substring, as a query parameter. Applied in the browser — see {@link groupMetrics}. */
export const NAME_PARAM = 'name';

/** The per-service narrowing, as a query parameter. */
export const SERVICE_PARAM = 'service';

/**
 * The metric table — every series one bucket holds, at the last value that arrived for it.
 *
 * **Load budget: `2 + 1`.** The two are the shell's, held by {@link TelemetryBuffer} and shared by
 * every screen. The one is this:
 *
 * - `GET /observability/api/telemetry/metrics?source=&service=`
 *
 * and it stays one request whatever the reader does here. **The name filter adds no request at
 * all**: one read holds every series in a bucket — there is a single point per series and the store
 * caps a bucket at 500 of them — so the box narrows what is already on the page. **With no source
 * selected the count is `2 + 0`**, as on every screen here: a sourceless read answers `200` with an
 * empty list, so firing one would spend a request to draw a service that has never exported a
 * metric. Both halves are asserted in the spec, because neither is visible on screen when it
 * regresses.
 *
 * **There is no chart, and the reason is a measurement.** The store keeps one `MetricPoint` per
 * series and replaces it in place on every arrival, so there is no series to draw — a time-series
 * chart needs history and this buffer keeps none. The screen says so where a reader would look for
 * one, rather than leaving the absence to be discovered. The client-side alternative — accumulating
 * points from successive polls — was considered and declined: ten minutes of polling would give
 * sixty points of "what this browser tab happened to observe", it would vanish on navigation, and it
 * would be the only thing on this page the service could not confirm.
 *
 * **There is no time window here either**, and that is the endpoint rather than an omission:
 * `/telemetry/metrics` takes no `sinceMinutes`, because a latest value has no window to be inside.
 * The `?since=` the errors list and the log tail carry is meaningless on this screen and is not
 * offered, so the "your window excludes what is buffered" answer cannot arise here.
 *
 * **The name filter is applied in the browser, and the endpoint's own `?name=` is deliberately not
 * used.** Measured against the live service: `?name=` is an exact, case-sensitive match, so
 * `name=memory` answered zero against a bucket holding five `jvm.memory.used` series. A search box
 * wired to that would require its reader to already know the answer.
 */
@Component({
  selector: 'app-metrics-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Empty, QitsBadge, QitsButton, RouterLink, SourceStrip],
  templateUrl: './metrics-page.html',
  styleUrls: ['../ui/page.css', './metrics-page.css'],
})
export class MetricsPage {
  private readonly api = inject(ObservabilityApi);
  private readonly buffer = inject(TelemetryBuffer);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly now = tickingNow();

  private readonly params = toSignal(this.route.queryParamMap, {
    initialValue: convertToParamMap({}),
  });

  protected readonly unitGloss = unitGloss;

  protected readonly source = selectedSource();

  /** The name substring, or the empty string. Applied here, never on the wire. */
  protected readonly name = computed<string>(() => this.params().get(NAME_PARAM) ?? '');

  /** The service narrowing, or null for every service in the bucket. */
  protected readonly service = computed<string | null>(() => this.params().get(SERVICE_PARAM));

  private readonly state = signal<Loadable<readonly TelemetryMetricDto[]>>(IDLE);

  /** Why the last *poll* failed, or the empty string. The table on screen is kept either way. */
  private readonly pollProblem = signal('');

  protected readonly tableState = this.state.asReadonly();
  protected readonly problem = this.pollProblem.asReadonly();

  /** Everything the read returned, before the name filter. */
  private readonly metrics = computed<readonly TelemetryMetricDto[]>(() => {
    const state = this.state();
    return state.kind === 'ready' ? state.value : [];
  });

  /** The rows, grouped by metric name and narrowed by the name box. */
  protected readonly groups = computed(() =>
    this.state().kind === 'ready' ? groupMetrics(this.metrics(), this.name()) : NO_GROUPS,
  );

  /** How many series are drawn, and how many arrived — the same number until the box is used. */
  protected readonly shown = computed(() => seriesCount(this.groups()));
  protected readonly received = computed(() => this.metrics().length);

  /** The selected source's own row, which is where the service chips come from — at no cost. */
  protected readonly sourceRow = computed(() => this.buffer.source(this.source()));

  /** The services that have reported into this bucket. Arrived with the source; costs nothing. */
  protected readonly services = computed<readonly string[]>(
    () => this.sourceRow()?.services.map((service) => service.name) ?? [],
  );

  /**
   * What the name box left out, in the two numbers that say it.
   *
   * Drawn only while the box is narrowing something. Unlike every other screen here this is not a
   * truncation — nothing was left on the server — so it never says "showing N of M" in the register
   * the other screens use for a cut-off answer, and it never blames the buffer for it.
   */
  protected readonly filtered = computed(() => {
    const name = this.name().trim();
    if (!name || this.state().kind !== 'ready') {
      return '';
    }
    const shown = this.shown();
    const received = this.received();
    if (shown === received) {
      return '';
    }
    return (
      `Showing ${formatCount(shown)} of ${formatCount(received)} series — the rest have names that ` +
      `do not contain “${name}”. Nothing was left on the server: the read brought back every series ` +
      'in this bucket and the filter is applied here.'
    );
  });

  /**
   * What the *series cap* has taken, which is the only truncation this screen can suffer.
   *
   * Metric series are never evicted — the store replaces a point in place and its footprint is
   * already bounded — so the counter to read here is `droppedMetricSeries`, which counts **new**
   * series refused once a bucket is at its cap. That failure is invisible in a table: every row
   * present is current and correct, and the missing ones simply never appear. So it is stated
   * whenever the counter is non-zero, and again whenever this bucket is sitting at the cap.
   */
  protected readonly capacity = computed(() => {
    const store = this.buffer.storeValue();
    if (!store) {
      return '';
    }
    const row = this.sourceRow();
    const atCap = row !== null && row.metricSeries >= store.caps.metricSeriesPerSource;
    const dropped = store.droppedMetricSeries;
    if (dropped === 0 && !atCap) {
      return '';
    }
    const cap = `Each source holds at most ${formatCount(store.caps.metricSeriesPerSource)} series.`;
    if (dropped > 0 && atCap) {
      return (
        `${cap} This one is at that cap, and ${plural(dropped, 'new series has', 'new series have')} ` +
        'been refused across the buffer since it came up. A series refused at the cap is not a stale ' +
        'row here — it is a row that never appears at all.'
      );
    }
    if (atCap) {
      return (
        `${cap} This one is at that cap, so a metric it has not exported yet will be refused rather ` +
        'than replacing one below.'
      );
    }
    return (
      `${cap} ${plural(dropped, 'new series has', 'new series have')} been refused at it since this ` +
      'buffer came up — somewhere in the buffer, a metric exists that has no row anywhere.'
    );
  });

  /**
   * Why the table is empty, and never the same sentence for two different reasons.
   *
   * The narrowest explanation the reader can act on comes first and the blunt one about the buffer
   * comes last, as on every screen here. The name-filter rung says where the filter is applied,
   * because the surprise is specific to this screen: the box narrows what is already on the page, so
   * "no match" is a fact about this bucket's metric names and never about the request.
   */
  protected readonly emptyReason = computed(() => {
    const name = this.name().trim();
    const service = this.service();
    const row = this.sourceRow();
    const label = row?.label ?? this.source() ?? 'this source';

    if (service && !this.services().includes(service)) {
      return (
        `No service called ${service} has reported into ${label}. The filter is still applied — ` +
        'clear it to see every series in this source.'
      );
    }
    if (name && this.received() > 0) {
      return (
        `No metric name in ${label} contains “${name}”. The read brought back ` +
        `${plural(this.received(), 'series', 'series')} and the filter is applied here rather than on the ` +
        'wire, so this is a fact about the names in this bucket and not about the request.'
      );
    }
    if (service) {
      return (
        `${service} has reported into ${label}, but none of what it sent is a metric series. It ` +
        'may export traces or logs only — a service reports each signal through its own bridge.'
      );
    }
    if (row && row.metricSeries === 0) {
      return (
        `No metric series have arrived from ${label}. A metric series is not evicted once it ` +
        'exists — the store replaces its point in place — so this is a source that has not exported ' +
        'metrics rather than one whose metrics were dropped.'
      );
    }

    const restart = restartEmptied(
      this.buffer.storeValue(),
      this.now(),
      'Anything from before that is gone, and the first export after it will land here.',
    );
    if (restart) {
      return restart;
    }
    return (
      `No metric series are buffered for ${label}. Nothing it has exported since this process came ` +
      'up is a metric — and only gauges and sums are kept at all: histograms and summaries are ' +
      'dropped when the export is decoded.'
    );
  });

  /**
   * The warning that a bucket holding two services can hide a series behind another.
   *
   * A series is identified by its name and its attributes and **not** by the reporting service, so
   * two services exporting one metric with one attribute set into a shared bucket occupy a single
   * row and the later arrival wins. Every bucket on this platform today holds exactly one service,
   * which is why this is a sentence that usually does not draw rather than a defect being papered
   * over.
   */
  protected readonly collision = computed(() => {
    const row = this.sourceRow();
    if (!row || row.services.length < 2) {
      return '';
    }
    return (
      `${formatCount(row.services.length)} services report into this source, and a series is keyed ` +
      'by its name and attributes alone — the reporting service is not part of that identity. Two ' +
      'of them exporting one metric with the same attributes share one row, showing whichever ' +
      'reported last. Narrow to a single service to read one exporter’s own figures.'
    );
  });

  /** A source's buffered range, so what the counts describe stays a stated span rather than "now". */
  protected readonly range = computed(() => {
    const row = this.sourceRow();
    if (!row?.oldestReceivedAt || !row.newestReceivedAt) {
      return '';
    }
    return (
      `${formatStamp(row.oldestReceivedAt, this.now())} to ` +
      `${formatStamp(row.newestReceivedAt, this.now())}`
    );
  });

  private handle: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private interval = METRIC_TABLE_POLL_INTERVAL_MS;
  private running = 0;

  constructor() {
    /*
     * One effect over the two lenses that reach the wire. The name box is not among them: it
     * narrows rows already on the page, so a change to it re-renders and must not re-read.
     */
    effect(() => {
      const query = { source: this.source(), service: this.service() };
      void this.load(query);
    });

    const onVisibilityChange = () => this.onVisibilityChange();
    this.document.addEventListener('visibilitychange', onVisibilityChange);
    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('visibilitychange', onVisibilityChange);
      this.stopPolling();
    });

    this.syncPolling();
  }

  /** The name substring, as a navigation. Applied on Enter or on leaving the field. */
  protected async onName(event: Event): Promise<void> {
    const value = (event.target as HTMLInputElement).value.trim();
    await this.merge({ [NAME_PARAM]: value || null });
  }

  protected async clearName(): Promise<void> {
    await this.merge({ [NAME_PARAM]: null });
  }

  /** The service narrowing, as a navigation. Choosing the current one clears it. */
  protected async setService(name: string | null): Promise<void> {
    const next = name && name !== this.service() ? name : null;
    await this.merge({ [SERVICE_PARAM]: next });
  }

  protected isService(name: string | null): boolean {
    return this.service() === name;
  }

  /** What kind of instrument this is, as a badge tone. `MIXED` is a disagreement, so it is warned. */
  protected kindTone(kind: MetricKind): 'info' | 'neutral' | 'warning' {
    switch (kind) {
      case 'GAUGE':
        return 'info';
      case 'COUNTER':
        return 'neutral';
      default:
        return 'warning';
    }
  }

  /**
   * When a point was stamped, absolute with a relative suffix.
   *
   * **This is the exporter's own clock, not the service's ingest stamp**, and on this screen the
   * difference is worth knowing: a point whose age stops moving is an instrument that has stopped
   * reporting, while the row it sits in stays on screen looking exactly as current as its
   * neighbours. It is the only signal here that a value is stale.
   */
  protected stamp(epochNanos: number): string {
    return formatStamp(new Date(epochNanos / 1_000_000).toISOString(), this.now());
  }

  /** How many series are on screen, said with the noun. */
  protected readonly countLabel = computed(() => plural(this.shown(), 'series', 'series'));

  /**
   * Re-issue the read by hand. The same one request; the band has its own.
   *
   * A refresh over a table that is already up goes through {@link poll}, so a failure keeps the rows
   * and marks them stale rather than replacing a working screen with an error.
   */
  protected async refresh(): Promise<void> {
    if (this.state().kind === 'ready') {
      await this.poll();
      return;
    }
    await this.load({ source: this.source(), service: this.service() });
  }

  /**
   * The screen's one read.
   *
   * **With no source there is no request.** A sourceless read answers `200` with an empty list, so
   * firing one would draw a screen indistinguishable from a service that exports no metrics.
   * `idle` rather than `ready([])` is what lets the template tell "not asked" from "asked and empty".
   */
  private async load(query: { source: string | null; service: string | null }): Promise<void> {
    if (!query.source) {
      this.state.set(IDLE);
      this.pollProblem.set('');
      return;
    }
    this.state.set(LOADING);
    this.pollProblem.set('');
    try {
      this.state.set(
        ready(await this.api.metrics({ source: query.source, service: query.service })),
      );
    } catch (error) {
      this.state.set(failed(error));
    }
  }

  /** One tick. A failure keeps the table that is on screen and slows the cadence down. */
  private async poll(): Promise<void> {
    const source = this.source();
    if (!source || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      this.state.set(ready(await this.api.metrics({ source, service: this.service() })));
      this.pollProblem.set('');
      this.interval = METRIC_TABLE_POLL_INTERVAL_MS;
    } catch (error) {
      this.pollProblem.set(describeError(error));
      this.interval = METRIC_TABLE_BACKOFF_INTERVAL_MS;
    } finally {
      this.inFlight = false;
      this.syncPolling();
    }
  }

  /** A hidden tab reads nothing, and neither does a screen with no bucket to read. */
  private shouldPoll(): boolean {
    return !this.document.hidden && !!this.source();
  }

  private syncPolling(): void {
    if (!this.shouldPoll()) {
      this.stopPolling();
      return;
    }
    if (this.handle !== null && this.running === this.interval) {
      return;
    }
    this.stopPolling();
    this.running = this.interval;
    this.handle = setInterval(() => void this.poll(), this.interval);
  }

  private stopPolling(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
      this.running = 0;
    }
  }

  /** Coming back is worth one immediate read rather than up to ten seconds of a stale table. */
  private onVisibilityChange(): void {
    if (this.shouldPoll()) {
      void this.poll();
    }
    this.syncPolling();
  }

  /** A lens change is a navigation that keeps every other lens. `null` drops a parameter. */
  private async merge(params: Record<string, string | null>): Promise<void> {
    await this.router.navigate([], {
      relativeTo: this.route,
      queryParams: params,
      queryParamsHandling: 'merge',
    });
  }
}
