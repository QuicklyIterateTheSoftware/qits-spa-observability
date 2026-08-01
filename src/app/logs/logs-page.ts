import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink, convertToParamMap } from '@angular/router';
import { QitsBadge, QitsButton } from '@qits/ui-components';
import { DEFAULT_LIMIT, type LogsResponse, type TelemetryLogDto } from '../api/dto';
import { ObservabilityApi } from '../api/observability-api';
import { selectedSource } from '../buffer/selected-source';
import { SourceStrip } from '../buffer/source-strip';
import { TelemetryBuffer } from '../buffer/telemetry-buffer';
import { Async } from '../ui/async';
import { Empty } from '../ui/empty';
import { formatCount, formatElapsed, formatStamp } from '../ui/format';
import { IDLE, LOADING, describeError, failed, ready, type Loadable } from '../ui/loadable';
import { severityOf } from '../ui/severity';
import { tickingNow } from '../ui/ticker';
import { SINCE_PARAM, WINDOW_PRESETS, readWindow, windowLabel } from '../ui/window';

/**
 * How often the tail re-reads itself **while Follow is on**.
 *
 * Five seconds, and this is the one place in the application that goes faster than ten. It is the
 * only screen whose subject is the arrival of records rather than the records themselves: a trace
 * is a finished thing and an error list is a summary, but a tail that is five seconds behind is not
 * a tail. The cost is bounded by the toggle — with Follow off this screen polls **not at all**, so
 * the quicker cadence is something a reader asks for rather than something the app spends by
 * default on a screen nobody is watching.
 */
export const LOG_TAIL_FOLLOW_INTERVAL_MS = 5_000;

/** What a failed poll falls back to. The last good tail stays on screen and is marked stale. */
export const LOG_TAIL_BACKOFF_INTERVAL_MS = 30_000;

/** How recent a restart has to be for it to be the whole explanation of an empty tail. */
export const RECENT_RESTART_MS = 5 * 60 * 1000;

/** The substring search, as a query parameter. It reaches the wire as `?query=`. */
export const QUERY_PARAM = 'q';

/** The per-service narrowing, as a query parameter. */
export const SERVICE_PARAM = 'service';

/**
 * How far from the bottom counts as "still following".
 *
 * A few pixels of slack rather than an exact equality: a fractional scroll offset, a zoom level and
 * a sub-pixel row height each put a pinned view a hair off the bottom, and turning Follow off
 * because of a rounding error would look like the toggle switching itself off at random.
 */
export const AT_BOTTOM_SLACK_PX = 8;

/**
 * The log tail — the buffered records of one bucket, oldest at the top and newest at the bottom.
 *
 * **Load budget: `2 + 1`.** The two are the shell's, held by {@link TelemetryBuffer} and shared by
 * every screen. The one is this:
 *
 * - `GET /observability/api/telemetry/logs?source=&service=&query=&sinceMinutes=&limit=200`
 *
 * and it stays one request whatever the reader does. The search, the service filter and the window
 * each change *that* request rather than adding another; the service chips are drawn from the source
 * row the band already holds. **With no source selected the count is `2 + 0`**: a sourceless read
 * answers `200` with an empty list, so firing one would spend a request to draw a screen
 * indistinguishable from a service that has never logged. Both halves are asserted in the spec.
 *
 * **Follow mode is the one quickened poll in this application**, at
 * {@link LOG_TAIL_FOLLOW_INTERVAL_MS}, and it is off the moment the toggle is off — this screen then
 * makes no timed request at all. It **defaults on**, because a tail nobody asked to follow is just a
 * list, and it **switches itself off the moment the reader scrolls up**: scrolling away from the
 * bottom is how a person says "hold still, I am reading this", and a view that kept yanking itself
 * back down would be answering a question nobody asked.
 *
 * **Follow is component state, not URL state, and that is a considered exception.** The house rule
 * puts anything that costs a request in the URL, and this does cost requests. But it changes the
 * *cadence*, never the answer — every read it makes is byte-for-byte the read the screen would make
 * anyway — and it turns itself off from a scroll, so putting it in the URL would rewrite a reader's
 * address bar and their history under their hands as they read. The lenses that change *what comes
 * back* — the source, the search, the service and the window — are all in the URL, so the link is
 * still the list somebody meant to send.
 *
 * **The order is the service's own.** Logs come back oldest-first by construction and a tail wants
 * exactly that, so nothing is reversed here: the newest record is the bottom one, which is where a
 * reader following a tail is already looking. And a limited answer keeps the **newest** N rather
 * than the first — measured against the live service, not assumed — so a truncated tail is still a
 * tail rather than a stale prefix of one.
 */
@Component({
  selector: 'app-logs-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Empty, QitsBadge, QitsButton, RouterLink, SourceStrip],
  templateUrl: './logs-page.html',
  styleUrls: ['../ui/page.css', './logs-page.css'],
})
export class LogsPage {
  private readonly api = inject(ObservabilityApi);
  private readonly buffer = inject(TelemetryBuffer);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly now = tickingNow();

  private readonly params = toSignal(this.route.queryParamMap, {
    initialValue: convertToParamMap({}),
  });

  /** The scrolling rail itself, so following can keep it pinned and a scroll can turn following off. */
  private readonly rail = viewChild<ElementRef<HTMLElement>>('tail');

  protected readonly windows = WINDOW_PRESETS;
  protected readonly windowLabel = windowLabel;
  protected readonly followSeconds = LOG_TAIL_FOLLOW_INTERVAL_MS / 1000;
  protected readonly severity = severityOf;

  protected readonly source = selectedSource();

  /** The substring, or the empty string. It matches the body **and** the severity text upstream. */
  protected readonly search = computed<string>(() => this.params().get(QUERY_PARAM) ?? '');

  /** The service narrowing, or null for every service in the bucket. */
  protected readonly service = computed<string | null>(() => this.params().get(SERVICE_PARAM));

  /** The window in minutes, or null for everything still buffered. */
  protected readonly since = computed<number | null>(() =>
    readWindow(this.params().get(SINCE_PARAM)),
  );

  private readonly state = signal<Loadable<LogsResponse>>(IDLE);
  private readonly pollProblem = signal('');

  /** On by default — see this class's note on why it is not URL state. */
  private readonly follow = signal(true);

  protected readonly tailState = this.state.asReadonly();
  protected readonly problem = this.pollProblem.asReadonly();
  protected readonly following = this.follow.asReadonly();

  /** The records, in the order they arrive: oldest first, so the newest is the bottom row. */
  protected readonly logs = computed<readonly TelemetryLogDto[]>(() => {
    const state = this.state();
    return state.kind === 'ready' ? state.value.logs : [];
  });

  /** The selected source's own row, which is where the service chips come from — at no cost. */
  protected readonly sourceRow = computed(() => this.buffer.source(this.source()));

  /** The services that have reported into this bucket. Arrived with the source; costs nothing. */
  protected readonly services = computed<readonly string[]>(
    () => this.sourceRow()?.services.map((service) => service.name) ?? [],
  );

  /** How many records on screen carry no severity at all, so the tail can say it once. */
  private readonly unsetCount = computed(
    () => this.logs().filter((log) => severityOf(log).unset).length,
  );

  /**
   * The sentence under the tail about records with no severity, or the empty string.
   *
   * Written here rather than in the template because it has to agree with itself: one record and
   * forty need different verbs, and a screen whose job is to be exact about what a record does not
   * say cannot afford "1 records".
   */
  protected readonly unsetNote = computed(() => {
    const count = this.unsetCount();
    if (count === 0) {
      return '';
    }
    const subject =
      count === 1
        ? 'One record here carries no severity at all'
        : `${formatCount(count)} records here carry no severity at all`;
    return (
      `${subject} — neither a number nor a word. The severity field is optional in OTLP, so they ` +
      'are drawn as an absence: filling one in would turn an exporter’s omission into a claim ' +
      'about the record.'
    );
  });

  /**
   * What the answer left out, with both numbers in it, and which end was kept.
   *
   * "The newest" is not decoration: a truncated tail that kept the *oldest* 200 would be a screen
   * that stops updating while claiming to follow, and a reader has no way to tell from the rows
   * which end they are looking at. The eviction half is appended only while the store has actually
   * evicted logs — a truncation that is purely this screen's own limit must not be blamed on the
   * buffer, and a buffer that has evicted nothing must not be made to look like it has.
   */
  protected readonly truncation = computed(() => {
    const state = this.state();
    if (state.kind !== 'ready' || !state.value.truncated) {
      return '';
    }
    const shown =
      `Showing the newest ${formatCount(state.value.logs.length)} of ` +
      `${formatCount(state.value.total)} matching records.`;
    const store = this.buffer.storeValue();
    if (store && store.evictedLogs > 0) {
      return (
        `${shown} The buffer has also dropped ${formatCount(store.evictedLogs)} older logs at its ` +
        'cap, so the total itself is what survived.'
      );
    }
    return `${shown} Search, narrow to one service or shorten the window to see fewer.`;
  });

  /**
   * Why the tail is empty, and never the same sentence for two different reasons.
   *
   * The narrowest explanation the reader can act on comes first; the blunt one about the buffer
   * comes last. The search case says what the search actually matches, because the surprise runs
   * both ways: "error" finds records whose *severity* says so, and a service name or a trace id
   * finds nothing at all however plainly it appears on the rows.
   */
  protected readonly emptyReason = computed(() => {
    const search = this.search().trim();
    const service = this.service();
    const since = this.since();
    const row = this.sourceRow();
    const label = row?.label ?? this.source() ?? 'this source';

    if (service && !this.services().includes(service)) {
      return (
        `No service called ${service} has reported into ${label}. The filter is still applied — ` +
        'clear it to see every record in this source.'
      );
    }
    if (search) {
      return (
        `Nothing in ${label} matches “${search}”. The search is a case-insensitive substring of a ` +
        "record's body and of its severity text, and of nothing else — a service name, a trace id " +
        'or an attribute will not match however plainly it is drawn on the rows.'
      );
    }
    if (since !== null) {
      const held = this.range();
      return (
        `No records in the last ${windowLabel(since)}. ` +
        (held
          ? `This source holds records from ${held} — clear the window to see them.`
          : 'Clear the window to see everything the buffer still holds.')
      );
    }
    if (service) {
      return (
        `${service} has reported into ${label}, but none of what it sent is a log record. It may ` +
        'export spans only — a service reports traces and logs through separate bridges.'
      );
    }
    if (row && row.logs === 0) {
      return (
        `No logs have arrived from ${label}. It has exported ${formatCount(row.spans)} spans, so ` +
        'it is reporting — its logging bridge may not be exporting, or its records have been ' +
        'evicted; the band above says whether this buffer has evicted anything.'
      );
    }

    const store = this.buffer.storeValue();
    if (store) {
      const elapsed = this.now() - new Date(store.startedAt).getTime();
      if (elapsed < RECENT_RESTART_MS) {
        return (
          `The buffer was emptied ${formatElapsed(elapsed)} ago when qits-observability ` +
          'restarted. Anything logged before that is gone.'
        );
      }
    }
    return (
      `No logs are buffered for ${label}. Nothing it has exported since this process came up is a ` +
      'log record.'
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
  private interval = LOG_TAIL_FOLLOW_INTERVAL_MS;
  private running = 0;

  constructor() {
    /*
     * One effect over every lens: the source, the search, the service and the window are all URL
     * state, so a change to any of them is a navigation, and the read that answers it belongs here
     * rather than in four handlers that would each have to remember to fire it.
     */
    effect(() => {
      const query = {
        source: this.source(),
        service: this.service(),
        query: this.search(),
        sinceMinutes: this.since(),
      };
      void this.load(query);
    });

    /*
     * Following means staying at the bottom, and the bottom moves when records arrive. This runs
     * after the rows are rendered rather than after the read returns, which is the difference
     * between scrolling to where the content is and scrolling to where it was.
     */
    effect(() => {
      this.logs();
      if (this.follow()) {
        this.pinToBottom();
      }
    });

    /*
     * Follow decides whether this screen polls at all, so a change to it has to re-sync the
     * interval — turning it on must start reading without waiting for a tick that is not running.
     */
    effect(() => {
      this.follow();
      this.syncPolling();
    });

    const onVisibilityChange = () => this.onVisibilityChange();
    this.document.addEventListener('visibilitychange', onVisibilityChange);
    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('visibilitychange', onVisibilityChange);
      this.stopPolling();
    });
  }

  /** Turn following on or off by hand. Turning it on jumps back to the newest record. */
  protected setFollow(on: boolean): void {
    this.follow.set(on);
    if (on) {
      this.pinToBottom();
    }
  }

  protected toggleFollow(): void {
    this.setFollow(!this.follow());
  }

  /**
   * The reader scrolled the rail.
   *
   * Scrolling away from the bottom turns following off, and that is the whole rule: it is how a
   * person says "hold still". Scrolling back down does **not** turn it on again — coming to rest
   * near the bottom while reading is not a request to be moved, and a toggle that flipped itself
   * both ways would be a control nobody can predict. The button is how it comes back.
   */
  protected onScroll(): void {
    if (this.follow() && !this.atBottom()) {
      this.follow.set(false);
    }
  }

  /** The search, as a navigation. Applied on Enter or on leaving the field, never per keystroke. */
  protected async onSearch(event: Event): Promise<void> {
    const value = (event.target as HTMLInputElement).value.trim();
    await this.merge({ [QUERY_PARAM]: value || null });
  }

  protected async clearSearch(): Promise<void> {
    await this.merge({ [QUERY_PARAM]: null });
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

  protected stamp(epochNanos: number): string {
    return formatStamp(new Date(epochNanos / 1_000_000).toISOString(), this.now());
  }

  /**
   * Re-issue the read by hand, which is what the screen offers instead of a poll while Follow is
   * off. A refresh over a tail that is already up keeps it if the read fails.
   */
  protected async refresh(): Promise<void> {
    if (this.state().kind === 'ready') {
      await this.poll();
      return;
    }
    await this.load({
      source: this.source(),
      service: this.service(),
      query: this.search(),
      sinceMinutes: this.since(),
    });
  }

  /**
   * The screen's one read.
   *
   * **With no source there is no request** — a sourceless read answers `200` with an empty list, and
   * a screen drawn from it is indistinguishable from a service that has never logged. `idle` rather
   * than `ready([])` is what lets the template tell "not asked" from "asked and empty".
   */
  private async load(query: {
    source: string | null;
    service: string | null;
    query: string;
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
          await this.api.logs({
            source: query.source,
            service: query.service,
            query: query.query || null,
            sinceMinutes: query.sinceMinutes,
            limit: DEFAULT_LIMIT,
          }),
        ),
      );
    } catch (error) {
      this.state.set(failed(error));
    }
  }

  /** One tick. A failure keeps the tail that is on screen and slows the cadence down. */
  private async poll(): Promise<void> {
    const source = this.source();
    if (!source || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      this.state.set(
        ready(
          await this.api.logs({
            source,
            service: this.service(),
            query: this.search() || null,
            sinceMinutes: this.since(),
            limit: DEFAULT_LIMIT,
          }),
        ),
      );
      this.pollProblem.set('');
      this.interval = LOG_TAIL_FOLLOW_INTERVAL_MS;
    } catch (error) {
      this.pollProblem.set(describeError(error));
      this.interval = LOG_TAIL_BACKOFF_INTERVAL_MS;
    } finally {
      this.inFlight = false;
      this.syncPolling();
    }
  }

  /**
   * Three conditions, and Follow is the one this screen adds.
   *
   * A hidden tab reads nothing and a screen with no bucket reads nothing, as everywhere else here.
   * On top of that, a tail nobody is following reads nothing at all — not slowly, not at ten
   * seconds: the toggle is what buys the five-second cadence, and switching it off has to buy the
   * silence back or the toggle is only a label.
   */
  private shouldPoll(): boolean {
    return !this.document.hidden && !!this.source() && this.follow();
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

  /** Coming back is worth one immediate read rather than up to five seconds of a stale tail. */
  private onVisibilityChange(): void {
    if (this.shouldPoll()) {
      void this.poll();
    }
    this.syncPolling();
  }

  /** Whether the rail is resting at its bottom, within {@link AT_BOTTOM_SLACK_PX}. */
  private atBottom(): boolean {
    const element = this.rail()?.nativeElement;
    if (!element) {
      return true;
    }
    return element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_SLACK_PX;
  }

  private pinToBottom(): void {
    const element = this.rail()?.nativeElement;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
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
