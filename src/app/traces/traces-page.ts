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
import { DEFAULT_LIMIT, type TraceSort, type TracesResponse } from '../api/dto';
import { ObservabilityApi } from '../api/observability-api';
import { SOURCE_PARAM, selectedSource } from '../buffer/selected-source';
import { SourceStrip } from '../buffer/source-strip';
import { TelemetryBuffer } from '../buffer/telemetry-buffer';
import { Async } from '../ui/async';
import { Empty } from '../ui/empty';
import { formatCount, formatElapsed, formatStamp, plural, shortId } from '../ui/format';
import { LOADING, describeError, failed, ready, IDLE, type Loadable } from '../ui/loadable';
import { tickingNow } from '../ui/ticker';
import { formatDuration } from './trace-layout';

/**
 * How often the list re-reads itself.
 *
 * Ten seconds, the same cadence as the band above it, because they describe the same moment: a
 * source's span count in the band and a trace list from ten seconds earlier would be two readings
 * presented as one. It is one request — the whole point of the server-side grouping is that this
 * screen costs a single read rather than the several megabytes that grouping in the browser would
 * pull to draw fifty rows.
 */
export const TRACE_LIST_POLL_INTERVAL_MS = 10_000;

/** What a failed poll falls back to. The last good list stays on screen and is marked stale. */
export const TRACE_LIST_BACKOFF_INTERVAL_MS = 30_000;

/** How recent a restart has to be for it to be the whole explanation of an empty list. */
export const RECENT_RESTART_MS = 5 * 60 * 1000;

/** The lens, as a query parameter. `?sort=recent` and `?sort=duration`, and nothing else. */
export const SORT_PARAM = 'sort';

/** The duration floor, in milliseconds, as a query parameter. */
export const THRESHOLD_PARAM = 'threshold';

/** The per-service narrowing, as a query parameter. */
export const SERVICE_PARAM = 'service';

/** The floors the toggle offers. Zero is first and is the default: it admits everything. */
export const THRESHOLD_PRESETS = [0, 10, 100, 500, 1000] as const;

/**
 * The trace list — what just happened in one bucket, or what was slow in it.
 *
 * **Load budget: `2 + 1`.** The two are the shell's, held by {@link TelemetryBuffer} and shared with
 * every screen. The one is this:
 *
 * - `GET /observability/api/telemetry/traces?source=&service=&sort=&thresholdMs=&limit=200`
 *
 * and it is one request whatever the reader does on this page. Flipping the lens, moving the
 * threshold and narrowing to a service all change *that* request rather than adding another, and
 * the service chips are drawn from the source row the band already holds, so the filter itself
 * costs nothing. **With no source selected the count is `2 + 0`**: a read with no `source` answers
 * `200` with an empty list, so a page that fired one anyway would spend a request to draw a screen
 * indistinguishable from a service with no telemetry. Both the positive and that negative are
 * asserted in the spec, because a regression in either is silent on screen.
 *
 * **Every lens is URL state.** The source, the sort, the threshold and the service each change what
 * comes back, so by the house rule none of them hides in the component: this screen is a link
 * somebody can send, and the back button means "the list I was looking at".
 *
 * **The threshold is on the endpoint.** It was once only on `slow-spans`; it is on `traces` too,
 * measured rather than assumed, so the floor is applied where the grouping happens instead of
 * filtering rows the browser already paid to receive. Zero is the default because the filter is
 * `>=` and zero therefore admits everything — in a buffer this short, "everything" is a reasonable
 * list, and a tidier-looking default would hide the fast traces that prove the exporter works.
 */
@Component({
  selector: 'app-traces-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Empty, QitsBadge, QitsButton, RouterLink, SourceStrip],
  templateUrl: './traces-page.html',
  styleUrls: ['../ui/page.css', './traces-page.css'],
})
export class TracesPage {
  private readonly api = inject(ObservabilityApi);
  private readonly buffer = inject(TelemetryBuffer);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly now = tickingNow();

  private readonly params = toSignal(this.route.queryParamMap, {
    initialValue: convertToParamMap({}),
  });

  protected readonly formatCount = formatCount;
  protected readonly formatDuration = formatDuration;
  protected readonly shortId = shortId;
  protected readonly sourceParam = SOURCE_PARAM;
  protected readonly presets = THRESHOLD_PRESETS;

  protected readonly source = selectedSource();

  /** The lens. Anything that is not `duration` is `recent`, because the service will not object. */
  protected readonly sort = computed<TraceSort>(() =>
    this.params().get(SORT_PARAM) === 'duration' ? 'duration' : 'recent',
  );

  /** The floor in milliseconds. A URL carrying nonsense reads as 0, which is "no floor". */
  protected readonly threshold = computed<number>(() => {
    const raw = Number(this.params().get(THRESHOLD_PARAM));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  });

  /** The service narrowing, or null for every service in the bucket. */
  protected readonly service = computed<string | null>(() => this.params().get(SERVICE_PARAM));

  private readonly state = signal<Loadable<TracesResponse>>(IDLE);

  /** Why the last *poll* failed, or the empty string. The list on screen is kept either way. */
  private readonly pollProblem = signal('');

  protected readonly listState = this.state.asReadonly();
  protected readonly problem = this.pollProblem.asReadonly();

  /** The rows, once they are here. An empty list otherwise, so the template stays flat. */
  protected readonly traces = computed(() => {
    const state = this.state();
    return state.kind === 'ready' ? state.value.traces : [];
  });

  /** The selected source's own row, which is where the service chips come from — at no cost. */
  protected readonly sourceRow = computed(() => this.buffer.source(this.source()));

  /** The services that have reported into this bucket. Arrived with the source; costs nothing. */
  protected readonly services = computed<readonly string[]>(
    () => this.sourceRow()?.services.map((service) => service.name) ?? [],
  );

  /**
   * What the answer left out, said with both numbers in it.
   *
   * The eviction half is only appended while the store has actually evicted something: "the buffer
   * has dropped 0" is noise, and worse, it invites the reader to discount a truncation that is
   * purely this screen's own limit.
   */
  protected readonly truncation = computed(() => {
    const state = this.state();
    if (state.kind !== 'ready' || !state.value.truncated) {
      return '';
    }
    const shown = `Showing ${formatCount(state.value.traces.length)} of ${formatCount(state.value.total)} traces.`;
    const store = this.buffer.storeValue();
    if (store && store.evictedSpans > 0) {
      return `${shown} The buffer has also dropped ${formatCount(store.evictedSpans)} older spans at its cap, so the total itself is what survived.`;
    }
    return `${shown} Raise the threshold or narrow to one service to see fewer, more specific rows.`;
  });

  /**
   * Why the list is empty, and never the same sentence for two different reasons.
   *
   * The order is deliberate: the narrowest explanation the reader can act on comes first, and the
   * blunt one about the buffer itself comes last. Collapsing these into "No traces" is precisely
   * the failure this app is written to avoid — a service that is working and idle, a filter that
   * excludes everything, and a process that came up thirty seconds ago are three different facts
   * that draw the same blank table.
   */
  protected readonly emptyReason = computed(() => {
    const service = this.service();
    const threshold = this.threshold();
    const row = this.sourceRow();
    const label = row?.label ?? this.source() ?? 'this source';

    if (service && !this.services().includes(service)) {
      return (
        `No service called ${service} has reported into ${label}. The filter is still applied — ` +
        'clear it to see every trace in this source.'
      );
    }
    if (threshold > 0 && service) {
      return (
        `No trace involving ${service} ran for ${formatCount(threshold)} ms or longer. ` +
        'Lower the threshold, or clear the service filter.'
      );
    }
    if (threshold > 0) {
      return (
        `No trace in ${label} ran for ${formatCount(threshold)} ms or longer. Set the threshold ` +
        'back to 0 to see every buffered trace, however fast.'
      );
    }
    if (service) {
      return (
        `${service} has reported into ${label}, but none of its spans is in a buffered trace ` +
        'right now. Clear the filter to see the rest of the source.'
      );
    }
    if (row && row.spans === 0) {
      return (
        `No spans have arrived from ${label}. Either it has been idle, or its spans have all been ` +
        'evicted — the band above says whether this buffer has evicted anything.'
      );
    }

    const store = this.buffer.storeValue();
    if (store) {
      const since = this.now() - new Date(store.startedAt).getTime();
      if (since < RECENT_RESTART_MS) {
        return (
          `The buffer was emptied ${formatElapsed(since)} ago when qits-observability restarted. ` +
          'Anything from before that is gone.'
        );
      }
    }
    return (
      `No traces are buffered for ${label}. Its spans may all have been evicted, or nothing it ` +
      'exports has produced a trace since this process came up.'
    );
  });

  /** A source's buffered range, so "your window excludes it" stays a distinguishable answer. */
  protected readonly range = computed(() => {
    const row = this.sourceRow();
    if (!row || !row.oldestReceivedAt || !row.newestReceivedAt) {
      return '';
    }
    return `${formatStamp(row.oldestReceivedAt, this.now())} → ${formatStamp(row.newestReceivedAt, this.now())}`;
  });

  private handle: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private interval = TRACE_LIST_POLL_INTERVAL_MS;
  private running = 0;

  constructor() {
    /*
     * One effect over every lens: the source, the sort, the threshold and the service are all URL
     * state, so a change to any of them is a navigation, and the read that answers it belongs here
     * rather than in four handlers that would each have to remember to fire it.
     */
    effect(() => {
      const query = {
        source: this.source(),
        sort: this.sort(),
        thresholdMs: this.threshold(),
        service: this.service(),
      };
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

  /** The lens, as a navigation. Two values, ever — see {@link TraceSort}. */
  protected async setSort(sort: TraceSort): Promise<void> {
    await this.merge({ [SORT_PARAM]: sort === 'recent' ? null : sort });
  }

  /** The floor, as a navigation. Zero is the default and is spelled as an absent parameter. */
  protected async setThreshold(ms: number): Promise<void> {
    await this.merge({ [THRESHOLD_PARAM]: ms > 0 ? String(ms) : null });
  }

  /** A typed floor. Non-numbers and negatives read as 0, which is "no floor". */
  protected async onThreshold(event: Event): Promise<void> {
    const raw = Number((event.target as HTMLInputElement).value);
    await this.setThreshold(Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0);
  }

  /** The service narrowing, as a navigation. Choosing the current one clears it. */
  protected async setService(name: string | null): Promise<void> {
    const next = name && name !== this.service() ? name : null;
    await this.merge({ [SERVICE_PARAM]: next });
  }

  protected isService(name: string | null): boolean {
    return this.service() === name;
  }

  /** What a trace's marker should say about itself, or the empty string. */
  protected tone(errorSpanCount: number): 'danger' | 'neutral' {
    return errorSpanCount > 0 ? 'danger' : 'neutral';
  }

  protected age(startEpochNanos: number): string {
    return formatStamp(new Date(startEpochNanos / 1_000_000).toISOString(), this.now());
  }

  protected spanSummary(spanCount: number, services: readonly string[]): string {
    return `${plural(spanCount, 'span')} · ${plural(services.length, 'service')}`;
  }

  /**
   * Re-issue the read by hand. The same one request; the band has its own Refresh.
   *
   * A refresh over a list that is already up goes through {@link poll}, so a failure keeps the rows
   * and marks them stale rather than replacing a working screen with an error. Asking to be brought
   * up to date is not a reason to lose what you were reading. With nothing on screen there is
   * nothing to protect, so a first read — or a retry after one failed — is the blanking kind.
   */
  protected async refresh(): Promise<void> {
    if (this.state().kind === 'ready') {
      await this.poll();
      return;
    }
    await this.load({
      source: this.source(),
      sort: this.sort(),
      thresholdMs: this.threshold(),
      service: this.service(),
    });
  }

  /**
   * The screen's one read.
   *
   * **With no source there is no request**, and that is the whole of it: the service answers a
   * sourceless query with `200` and an empty list, so firing one would buy a screen that says "no
   * telemetry" about a bucket nobody named. `idle` rather than `ready([])` is what lets the template
   * tell "not asked" from "asked and empty" — the distinction `Loadable` keeps two states for.
   */
  private async load(query: {
    source: string | null;
    sort: TraceSort;
    thresholdMs: number;
    service: string | null;
  }): Promise<void> {
    if (!query.source) {
      this.state.set(IDLE);
      this.pollProblem.set('');
      return;
    }
    this.state.set(LOADING);
    this.pollProblem.set('');
    try {
      this.state.set(
        ready(
          await this.api.traces({
            source: query.source,
            service: query.service,
            sort: query.sort,
            thresholdMs: query.thresholdMs,
            limit: DEFAULT_LIMIT,
          }),
        ),
      );
    } catch (error) {
      this.state.set(failed(error));
    }
  }

  /**
   * One tick. A failure keeps the list that is on screen and slows the cadence down.
   *
   * Data you know is forty seconds old beats an empty page, so this never writes an error state
   * over a list that already arrived — {@link problem} says the last read failed and the rows stay.
   */
  private async poll(): Promise<void> {
    const source = this.source();
    if (!source || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      this.state.set(
        ready(
          await this.api.traces({
            source,
            service: this.service(),
            sort: this.sort(),
            thresholdMs: this.threshold(),
            limit: DEFAULT_LIMIT,
          }),
        ),
      );
      this.pollProblem.set('');
      this.interval = TRACE_LIST_POLL_INTERVAL_MS;
    } catch (error) {
      this.pollProblem.set(describeError(error));
      this.interval = TRACE_LIST_BACKOFF_INTERVAL_MS;
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

  /** Coming back is worth one immediate read rather than up to ten seconds of a stale list. */
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
