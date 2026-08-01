import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink, convertToParamMap } from '@angular/router';
import { QitsBadge, QitsButton } from '@qits/ui-components';
import type { SpanEventDto, TelemetryLogDto, TelemetrySpanDto, TraceDetailDto } from '../api/dto';
import { ObservabilityApi } from '../api/observability-api';
import { SOURCE_PARAM, selectedSource } from '../buffer/selected-source';
import { SourceStrip } from '../buffer/source-strip';
import { TelemetryBuffer } from '../buffer/telemetry-buffer';
import { Async } from '../ui/async';
import { Empty } from '../ui/empty';
import { formatCount, formatStamp, plural } from '../ui/format';
import { IDLE, LOADING, failed, ready, type Loadable } from '../ui/loadable';
import { severityOf } from '../ui/severity';
import { tickingNow } from '../ui/ticker';
import { EMPTY_WATERFALL, formatDuration, layOutTrace, type WaterfallRow } from './trace-layout';

/**
 * One trace, as a waterfall.
 *
 * **Load budget: `2 + 1`, and the 1 is read once.** The two are the shell's. The one is
 * `GET /observability/api/telemetry/traces/{traceId}?source=`, which answers the spans *and* the
 * correlated logs in a single body — so the rail below the waterfall and the log counts on its rows
 * cost nothing beyond the read that drew the bars.
 *
 * **This screen does not poll, and that is a rule rather than an omission.** A trace is a finished
 * thing: its spans were exported when it ended, and re-reading it on a timer would spend a request
 * every ten seconds to receive the same body. Late spans do arrive — an exporter batches — so there
 * is a Refresh control, which is the honest shape for "this may have changed" on something that
 * usually has not. The band above still polls, because the buffer around this trace does change.
 *
 * **Selecting a span costs nothing and so is not URL state.** The house rule puts anything that
 * costs a request in the URL; the detail pane is drawn from spans already on the page, so it stays
 * in the component and the link stays about the trace rather than about where somebody clicked.
 *
 * **An unknown id and an evicted one are the same answer**, and this screen will not guess between
 * them: the service answers `200` with an empty trace for both. It says so, and it only offers
 * eviction as an explanation while the store reports having evicted something — see
 * {@link missingReason}.
 */
@Component({
  selector: 'app-trace-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Empty, QitsBadge, QitsButton, RouterLink, SourceStrip],
  templateUrl: './trace-page.html',
  styleUrls: ['../ui/page.css', './trace-page.css'],
})
export class TracePage {
  private readonly api = inject(ObservabilityApi);
  private readonly buffer = inject(TelemetryBuffer);
  private readonly route = inject(ActivatedRoute);
  private readonly now = tickingNow();

  private readonly params = toSignal(this.route.paramMap, {
    initialValue: convertToParamMap({}),
  });

  protected readonly formatCount = formatCount;
  protected readonly formatDuration = formatDuration;
  protected readonly sourceParam = SOURCE_PARAM;

  protected readonly source = selectedSource();
  protected readonly traceId = computed(() => this.params().get('traceId') ?? '');

  private readonly state = signal<Loadable<TraceDetailDto>>(IDLE);
  protected readonly detailState = this.state.asReadonly();

  /** Which span the detail pane describes. Component state: choosing one costs no request. */
  private readonly chosen = signal<string | null>(null);

  protected readonly trace = computed<TraceDetailDto | null>(() => {
    const state = this.state();
    return state.kind === 'ready' ? state.value : null;
  });

  /** The whole layout — nesting, percentages, markers — from one pure function over the spans. */
  protected readonly waterfall = computed(() => {
    const trace = this.trace();
    return trace ? layOutTrace(trace.spans, trace.logs) : EMPTY_WATERFALL;
  });

  protected readonly rows = computed(() => this.waterfall().rows);

  protected readonly isEmpty = computed(
    () => this.state().kind === 'ready' && this.rows().length === 0,
  );

  /** The root's own name, or the earliest span's, said as what it is. */
  protected readonly heading = computed(() => {
    const rows = this.rows();
    if (rows.length === 0) {
      return '';
    }
    const root = rows.find((row) => !row.span.parentSpanId) ?? rows[0];
    return root.span.name || '(unnamed span)';
  });

  /** How many spans arrived under this id, and how many of them the service marked ERROR. */
  protected readonly summary = computed(() => {
    const layout = this.waterfall();
    const parts = [
      plural(layout.rows.length, 'span'),
      plural(layout.services.length, 'service'),
      formatDuration(Math.round(layout.windowMs)),
    ];
    if (layout.errorCount > 0) {
      parts.push(plural(layout.errorCount, 'error span'));
    }
    return parts.join(' · ');
  });

  /** When the trace began, absolute and relative, per this app's no-bare-relative-time rule. */
  protected readonly started = computed(() => {
    const layout = this.waterfall();
    if (layout.rows.length === 0) {
      return '';
    }
    return formatStamp(new Date(layout.startEpochNanos / 1_000_000).toISOString(), this.now());
  });

  /** How many spans were drawn at the top level because their named parent is not buffered. */
  protected readonly orphanCount = computed(
    () => this.rows().filter((row) => row.parentMissing).length,
  );

  /**
   * What an empty answer means, without pretending to know which.
   *
   * The service returns `200` with an empty trace for an id that never existed **and** for one whose
   * spans have been evicted, so the response cannot tell them apart and neither may this screen. The
   * eviction half is offered only while the store reports a non-zero `evictedSpans`: on a buffer
   * that has never dropped anything, "it may have been evicted" would be a false alternative that
   * makes a plain typo look like a retention problem.
   */
  protected readonly missingReason = computed(() => {
    const store = this.buffer.storeValue();
    const base = 'No spans are buffered for this trace.';
    if (store && store.evictedSpans > 0) {
      return (
        `${base} It may have been evicted — this buffer has dropped ${formatCount(store.evictedSpans)} ` +
        'spans at its cap — or the id may be wrong. The service answers both the same way and this ' +
        'screen will not guess between them.'
      );
    }
    return (
      `${base} This buffer has evicted nothing since it came up, so the id is the likelier ` +
      'explanation — though a trace in a different source would also answer this way.'
    );
  });

  /** The correlated logs, oldest first, as the rail beneath the waterfall renders them. */
  protected readonly logs = computed<readonly TelemetryLogDto[]>(() => {
    const trace = this.trace();
    return trace ? [...trace.logs].sort((left, right) => left.epochNanos - right.epochNanos) : [];
  });

  /** The span the pane is describing, or the first one, so the pane is never blank with rows up. */
  protected readonly selected = computed<WaterfallRow | null>(() => {
    const rows = this.rows();
    if (rows.length === 0) {
      return null;
    }
    const chosen = this.chosen();
    return rows.find((row) => row.span.spanId === chosen) ?? rows[0];
  });

  /** The selected span's attributes as pairs, since a template cannot iterate a record directly. */
  protected readonly attributes = computed<readonly { key: string; value: string }[]>(() => {
    const span = this.selected()?.span;
    if (!span) {
      return [];
    }
    return Object.entries(span.attributes).map(([key, value]) => ({ key, value: String(value) }));
  });

  protected readonly events = computed<readonly SpanEventDto[]>(
    () => this.selected()?.span.events ?? [],
  );

  constructor() {
    /*
     * The id is a path parameter and the source a query one, so a navigation between two traces
     * reuses this component: the read has to hang off both rather than off construction.
     */
    effect(() => {
      const traceId = this.traceId();
      const source = this.source();
      this.chosen.set(null);
      void this.load(traceId, source);
    });
  }

  protected choose(spanId: string): void {
    this.chosen.set(spanId);
  }

  protected isChosen(spanId: string): boolean {
    return this.selected()?.span.spanId === spanId;
  }

  /** The trace's own window, which is what every bar is a percentage of. */
  protected readonly rowWindowMs = computed(() => Math.round(this.waterfall().windowMs));

  /** An indent, in the one place a template cannot express one: a nested list would break the bars. */
  protected indent(depth: number): string {
    return `${Math.min(depth, 12) * 0.9}rem`;
  }

  /**
   * A bar's classes: the shape, the service it belongs to, and whether it failed.
   *
   * The service class is an index into six hues rather than a hash, so two services in one trace are
   * always told apart and the same service keeps its colour down the whole waterfall. It is
   * decoration over data that is already labelled in the row — nobody has to read the colour.
   */
  protected barClass(row: WaterfallRow): string {
    const index = this.waterfall().services.indexOf(row.span.serviceName);
    const service = `svc-${index < 0 ? 0 : index % 6}`;
    return row.isError ? `bar ${service} bar-error` : `bar ${service}`;
  }

  /** An event's attributes as pairs, for the events that are not exceptions. */
  protected eventPairs(event: SpanEventDto): readonly { key: string; value: string }[] {
    return Object.entries(event.attributes).map(([key, value]) => ({ key, value: String(value) }));
  }

  /**
   * A log's severity chip, from the one function that draws them everywhere here.
   *
   * This screen used to carry its own copy of the OTel floors and its own tone ladder, and drew a
   * record with no severity as `LOG` — an invented word for an absence, sitting in the rail with the
   * same weight as a reported one. {@link severityOf} answers "no severity" for that case, keeps the
   * exporter's own word where there is one, and puts the log rail and the tail in agreement about
   * what a record said.
   */
  protected readonly severity = severityOf;

  /** Which span a log belongs to, by name, so the rail reads without cross-referencing ids. */
  protected spanName(spanId: string): string {
    const row = this.rows().find((candidate) => candidate.span.spanId === spanId);
    return row ? row.span.name || '(unnamed span)' : '';
  }

  protected stamp(epochNanos: number): string {
    return formatStamp(new Date(epochNanos / 1_000_000).toISOString(), this.now());
  }

  /** How far into the trace an instant is — the number a reader actually wants beside a log line. */
  protected offset(epochNanos: number): string {
    const layout = this.waterfall();
    if (layout.rows.length === 0) {
      return '';
    }
    const ms = Math.max(0, Math.round((epochNanos - layout.startEpochNanos) / 1_000_000));
    return `+${formatCount(ms)} ms`;
  }

  /** An event's exception attributes, when it has them. The stack trace is rendered verbatim. */
  protected detail(event: SpanEventDto, key: string): string {
    const value = event.attributes[key];
    return value === undefined || value === null ? '' : String(value);
  }

  /** Re-read the trace by hand. Late spans are the only reason this control exists. */
  protected async refresh(): Promise<void> {
    await this.load(this.traceId(), this.source());
  }

  /**
   * The screen's one read, and it happens once.
   *
   * With no source there is no request: a sourceless trace read answers `200` with an empty trace,
   * which is indistinguishable on screen from a trace that has been evicted, so this screen refuses
   * to buy that confusion with a request.
   */
  private async load(traceId: string, source: string | null): Promise<void> {
    if (!traceId || !source) {
      this.state.set(IDLE);
      return;
    }
    this.state.set(LOADING);
    try {
      this.state.set(ready(await this.api.trace(traceId, { source })));
    } catch (error) {
      this.state.set(failed(error));
    }
  }
}

/** Re-exported so the template's `@for` over spans keeps a name for what it is iterating. */
export type { TelemetrySpanDto, WaterfallRow };
