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
import { DEFAULT_LIMIT, type ErrorsResponse, type TelemetrySpanDto } from '../api/dto';
import { ObservabilityApi } from '../api/observability-api';
import { selectedSource } from '../buffer/selected-source';
import { SourceStrip } from '../buffer/source-strip';
import { TelemetryBuffer } from '../buffer/telemetry-buffer';
import { Async } from '../ui/async';
import { Empty } from '../ui/empty';
import { formatCount, formatElapsed, formatStamp, plural, shortId } from '../ui/format';
import { IDLE, LOADING, describeError, failed, ready, type Loadable } from '../ui/loadable';
import { severityOf } from '../ui/severity';
import { tickingNow } from '../ui/ticker';
import { SINCE_PARAM, WINDOW_PRESETS, readWindow, windowLabel } from '../ui/window';
import { formatDuration } from '../traces/trace-layout';
import { NO_GROUPS, attribute, firstException, viewErrorGroups } from './error-group';

/**
 * How often the list re-reads itself.
 *
 * Ten seconds, the app's ordinary screen cadence and the same one the band above it keeps, because
 * the two describe one moment: a source's counts in the band beside an error list from ten seconds
 * earlier would be two readings presented as one. The tail is the single screen in this app that
 * goes faster, and it does so only while it is following.
 */
export const ERROR_LIST_POLL_INTERVAL_MS = 10_000;

/** What a failed poll falls back to. The last good list stays on screen and is marked stale. */
export const ERROR_LIST_BACKOFF_INTERVAL_MS = 30_000;

/**
 * How recent a restart has to be for it to be the whole explanation of an empty screen.
 *
 * The trace list carries the same figure. Two screens, one number: the honesty pass owns making
 * §5's table true everywhere and is the right place to decide whether it wants one home for it.
 */
export const RECENT_RESTART_MS = 5 * 60 * 1000;

/** The per-service narrowing, as a query parameter. */
export const SERVICE_PARAM = 'service';

/**
 * The errors screen: one card per trace, its error spans and its ERROR logs together.
 *
 * **Load budget: `2 + 1`.** The two are the shell's, held by {@link TelemetryBuffer} and shared by
 * every screen. The one is this:
 *
 * - `GET /observability/api/telemetry/errors?source=&service=&sinceMinutes=&limit=200`
 *
 * and it stays one request whatever the reader does here. The service filter and the window each
 * change *that* request rather than adding another; the service chips are drawn from the source row
 * the band already holds, so offering them costs nothing; and expanding a card costs nothing at all,
 * because a group arrives with its members inside it. **With no source selected the count is
 * `2 + 0`**: a sourceless read answers `200` with an empty list, so firing one would spend a request
 * to say "no errors" about a bucket nobody chose. Both halves are asserted in the spec, because
 * neither is visible on screen when it regresses.
 *
 * **This is the REST twin of the `telemetryErrors` MCP tool**, and it is drawn to look like what
 * that tool returns: an agent and a human debugging one failure should be reading the same grouping
 * in the same order. The list keeps the service's order for that reason — see
 * {@link viewErrorGroups} for the single exception.
 *
 * **An empty errors screen is good news, and it is written that way.** Everywhere else in this app
 * an empty answer is a fact about the buffer; here it is usually a fact about the platform, and a
 * sentence that reads as a failure to load would be exactly backwards.
 */
@Component({
  selector: 'app-errors-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Empty, QitsBadge, QitsButton, RouterLink, SourceStrip],
  templateUrl: './errors-page.html',
  styleUrls: ['../ui/page.css', './errors-page.css'],
})
export class ErrorsPage {
  private readonly api = inject(ObservabilityApi);
  private readonly buffer = inject(TelemetryBuffer);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly now = tickingNow();

  private readonly params = toSignal(this.route.queryParamMap, {
    initialValue: convertToParamMap({}),
  });

  protected readonly formatDuration = formatDuration;
  protected readonly shortId = shortId;
  protected readonly windows = WINDOW_PRESETS;

  protected readonly source = selectedSource();

  /** The service narrowing, or null for every service in the bucket. */
  protected readonly service = computed<string | null>(() => this.params().get(SERVICE_PARAM));

  /** The window in minutes, or null for everything still buffered. Nonsense in a URL reads as null. */
  protected readonly since = computed<number | null>(() =>
    readWindow(this.params().get(SINCE_PARAM)),
  );

  private readonly state = signal<Loadable<ErrorsResponse>>(IDLE);

  /** Why the last *poll* failed, or the empty string. The list on screen is kept either way. */
  private readonly pollProblem = signal('');

  /** Which cards are open. Component state: a group arrives with its members, so opening is free. */
  private readonly opened = signal<ReadonlySet<string>>(new Set<string>());

  protected readonly listState = this.state.asReadonly();
  protected readonly problem = this.pollProblem.asReadonly();

  /** The rows, with the uncorrelated group last. An empty list otherwise, so the template stays flat. */
  protected readonly groups = computed(() => {
    const state = this.state();
    return state.kind === 'ready' ? viewErrorGroups(state.value.groups) : NO_GROUPS;
  });

  /** The selected source's own row, which is where the service chips come from — at no cost. */
  protected readonly sourceRow = computed(() => this.buffer.source(this.source()));

  /** The services that have reported into this bucket. Arrived with the source; costs nothing. */
  protected readonly services = computed<readonly string[]>(
    () => this.sourceRow()?.services.map((service) => service.name) ?? [],
  );

  /**
   * What the answer left out, with both numbers in it.
   *
   * The eviction half is appended only while the store has actually evicted something. "The buffer
   * has dropped 0" is noise, and worse, it invites the reader to discount a truncation that is
   * purely this screen's own limit.
   */
  protected readonly truncation = computed(() => {
    const state = this.state();
    if (state.kind !== 'ready' || !state.value.truncated) {
      return '';
    }
    const shown =
      `Showing ${formatCount(state.value.groups.length)} of ` +
      `${formatCount(state.value.total)} groups.`;
    const store = this.buffer.storeValue();
    if (store && (store.evictedSpans > 0 || store.evictedLogs > 0)) {
      const dropped = [
        store.evictedSpans > 0 ? `${formatCount(store.evictedSpans)} spans` : '',
        store.evictedLogs > 0 ? `${formatCount(store.evictedLogs)} logs` : '',
      ]
        .filter(Boolean)
        .join(' and ');
      return (
        `${shown} The buffer has also dropped ${dropped} at its cap, so the total itself is what ` +
        'survived.'
      );
    }
    return `${shown} Narrow to one service or shorten the window to see fewer, more specific rows.`;
  });

  /**
   * Why the list is empty, and never the same sentence for two different reasons.
   *
   * The order is deliberate: the narrowest explanation the reader can act on comes first, and the
   * blunt one about the buffer itself comes last. The final sentence is the one this screen exists
   * to get right — on every other screen here an empty answer is a fact about the buffer, and on
   * this one it is usually a fact about a platform that is not failing.
   */
  protected readonly emptyReason = computed(() => {
    const service = this.service();
    const since = this.since();
    const row = this.sourceRow();
    const label = row?.label ?? this.source() ?? 'this source';

    if (service && !this.services().includes(service)) {
      return (
        `No service called ${service} has reported into ${label}. The filter is still applied — ` +
        'clear it to see every error in this source.'
      );
    }
    if (since !== null && service) {
      return (
        `Nothing from ${service} has failed in the last ${windowLabel(since)}. ` +
        'Widen the window, or clear the service filter.'
      );
    }
    if (since !== null) {
      const held = this.range();
      return (
        `No errors in the last ${windowLabel(since)}. ` +
        (held
          ? `This source holds records from ${held} — clear the window to see them.`
          : 'Clear the window to search everything the buffer still holds.')
      );
    }
    if (service) {
      return (
        `${service} has reported into ${label}, and nothing it exported carries an ERROR status ` +
        'or an ERROR log. Clear the filter to see the rest of the source.'
      );
    }
    if (row && row.spans === 0 && row.logs === 0) {
      return (
        `Nothing has arrived from ${label}. Either it has been idle, or everything it sent has ` +
        'been evicted — the band above says whether this buffer has evicted anything.'
      );
    }

    const store = this.buffer.storeValue();
    if (store) {
      const elapsed = this.now() - new Date(store.startedAt).getTime();
      if (elapsed < RECENT_RESTART_MS) {
        return (
          `The buffer was emptied ${formatElapsed(elapsed)} ago when qits-observability ` +
          'restarted. Anything from before that is gone, errors included.'
        );
      }
    }
    return (
      `No errors are buffered for ${label}. Nothing it has exported since this process came up ` +
      'carries an ERROR status or an ERROR log — which on a service that is working is the ' +
      'answer to expect.'
    );
  });

  /** A source's buffered range, so "your window excludes it" stays a distinguishable answer. */
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
  private interval = ERROR_LIST_POLL_INTERVAL_MS;
  private running = 0;

  constructor() {
    /*
     * One effect over every lens: the source, the service and the window are all URL state, so a
     * change to any of them is a navigation, and the read that answers it belongs here rather than
     * in three handlers that would each have to remember to fire it.
     */
    effect(() => {
      const query = { source: this.source(), service: this.service(), sinceMinutes: this.since() };
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

  /** The service narrowing, as a navigation. Choosing the current one clears it. */
  protected async setService(name: string | null): Promise<void> {
    const next = name && name !== this.service() ? name : null;
    await this.merge({ [SERVICE_PARAM]: next });
  }

  protected isService(name: string | null): boolean {
    return this.service() === name;
  }

  /** The window, as a navigation. "Everything buffered" is spelled as an absent parameter. */
  protected async setSince(minutes: number | null): Promise<void> {
    await this.merge({ [SINCE_PARAM]: minutes === null ? null : String(minutes) });
  }

  /** A window's own label. `null` is not a long window; it is no window. */
  protected readonly windowLabel = windowLabel;

  /** Open or close one card. It costs nothing: the members came with the group. */
  protected toggle(key: string): void {
    const opened = new Set(this.opened());
    if (!opened.delete(key)) {
      opened.add(key);
    }
    this.opened.set(opened);
  }

  protected isOpen(key: string): boolean {
    return this.opened().has(key);
  }

  /** A group's key. The uncorrelated group's trace id is empty, so it needs a name of its own. */
  protected keyOf(traceId: string, serviceName: string): string {
    return traceId || `_uncorrelated/${serviceName}`;
  }

  /** When the newest piece of a group's evidence happened, absolute with a relative suffix. */
  protected latest(epochMillis: number): string {
    return epochMillis > 0 ? formatStamp(new Date(epochMillis).toISOString(), this.now()) : '';
  }

  /** How much evidence a group holds, said in the nouns it holds. */
  protected evidence(spanCount: number, logCount: number): string {
    const parts: string[] = [];
    if (spanCount > 0) {
      parts.push(plural(spanCount, 'error span'));
    }
    if (logCount > 0) {
      parts.push(plural(logCount, 'error log'));
    }
    return parts.join(' · ');
  }

  protected stamp(epochNanos: number): string {
    return formatStamp(new Date(epochNanos / 1_000_000).toISOString(), this.now());
  }

  protected severity = severityOf;

  /** A span's own exception message, for the member list under an open card. */
  protected exceptionOf(span: TelemetrySpanDto): string {
    const event = firstException([span]);
    if (!event) {
      return '';
    }
    const type = attribute(event, 'exception.type');
    const message = attribute(event, 'exception.message');
    return type && message ? `${type}: ${message}` : type || message;
  }

  /** A span's stack trace, rendered verbatim in a monospace block where there is one. */
  protected stacktraceOf(span: TelemetrySpanDto): string {
    const event = firstException([span]);
    return event ? attribute(event, 'exception.stacktrace') : '';
  }

  /**
   * Re-issue the read by hand. The same one request; the band has its own.
   *
   * A refresh over a list that is already up goes through {@link poll}, so a failure keeps the cards
   * and marks them stale rather than replacing a working screen with an error. With nothing on
   * screen there is nothing to protect, so a first read — or a retry after one failed — blanks.
   */
  protected async refresh(): Promise<void> {
    if (this.state().kind === 'ready') {
      await this.poll();
      return;
    }
    await this.load({
      source: this.source(),
      service: this.service(),
      sinceMinutes: this.since(),
    });
  }

  /**
   * The screen's one read.
   *
   * **With no source there is no request.** The service answers a sourceless query with `200` and an
   * empty list, so firing one would buy a screen that says "no errors" about a bucket nobody named —
   * which is the most reassuring possible way to be wrong. `idle` rather than `ready([])` is what
   * lets the template tell "not asked" from "asked and empty".
   */
  private async load(query: {
    source: string | null;
    service: string | null;
    sinceMinutes: number | null;
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
          await this.api.errors({
            source: query.source,
            service: query.service,
            sinceMinutes: query.sinceMinutes,
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
   * Data you know is forty seconds old beats an empty page, so this never writes an error state over
   * a list that already arrived — {@link problem} says the last read failed and the cards stay.
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
          await this.api.errors({
            source,
            service: this.service(),
            sinceMinutes: this.since(),
            limit: DEFAULT_LIMIT,
          }),
        ),
      );
      this.pollProblem.set('');
      this.interval = ERROR_LIST_POLL_INTERVAL_MS;
    } catch (error) {
      this.pollProblem.set(describeError(error));
      this.interval = ERROR_LIST_BACKOFF_INTERVAL_MS;
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
