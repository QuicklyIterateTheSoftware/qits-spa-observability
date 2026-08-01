import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { ObservabilityApi } from '../api/observability-api';
import type { StoreStateDto, TelemetrySourceDto } from '../api/dto';
import { LOADING, describeError, failed, ready, type Loadable } from '../ui/loadable';

/**
 * How often the buffer's own state and its source list are re-read.
 *
 * Ten seconds, and this is the **app-level** poll — the one that always runs, on every screen, for
 * as long as a tab is open. Both reads are tiny: `store` is nine numbers and a timestamp, `sources`
 * is one row per bucket with a per-service breakdown inside it, and neither carries a record. Ten
 * seconds against an in-memory map in a process with no database costs twelve tiny requests a
 * minute on a visible tab and nothing at all on a hidden one.
 */
export const BUFFER_POLL_INTERVAL_MS = 10_000;

/**
 * The cadence a failed poll falls back to.
 *
 * A failure does **not** clear the screen. Data you know is forty seconds old beats an empty page,
 * so the last good answer stays up, {@link TelemetryBuffer.problem} says the last read failed, and
 * the interval slows down rather than hammering a service that just said no. The first success puts
 * it back to ten.
 */
export const BUFFER_BACKOFF_INTERVAL_MS = 30_000;

/**
 * The buffer, held once for the whole application.
 *
 * **This is the shell's two-request cost, and it is the only shared cost.** `GET /telemetry/store`
 * and `GET /telemetry/sources` are read here and by nothing else, so every screen in this SPA adds
 * exactly one request on top and no page costs more than three cold. A page that read the source
 * list for itself would double the app's steady-state traffic to tell it something it was already
 * being told.
 *
 * **Why it polls, and why it does not stream.** qits-observability has no SSE, no WebSocket and no
 * long-poll route. It does fire an internal change hint, but that hint fires only for
 * workspace-scoped records — which is none of the telemetry that exists today — so a stream wired to
 * it would look live and never fire, which is worse than no stream at all. So: polling, with the
 * platform's own quartet, and the platform's own rule that a hidden tab reads nothing.
 *
 * The two reads go out together on every tick because they are read together: a source count in the
 * band beside a `startedAt` from ten seconds earlier would describe two different moments as one.
 */
@Injectable({ providedIn: 'root' })
export class TelemetryBuffer {
  private readonly api = inject(ObservabilityApi);
  private readonly document = inject(DOCUMENT);

  private readonly storeState = signal<Loadable<StoreStateDto>>(LOADING);
  private readonly sourcesState = signal<Loadable<readonly TelemetrySourceDto[]>>(LOADING);
  private readonly pollProblem = signal('');

  /** What the buffer says about itself. */
  readonly store = this.storeState.asReadonly();

  /** What is in the buffer, one entry per bucket. */
  readonly sources = this.sourcesState.asReadonly();

  /**
   * Why the last *poll* failed, or the empty string. A failed **first** read is an error state on
   * {@link store} and {@link sources} instead, because there is nothing on screen to keep.
   */
  readonly problem = this.pollProblem.asReadonly();

  /** The rows, once they are here; an empty list otherwise, so the templates stay flat. */
  readonly sourceList = computed<readonly TelemetrySourceDto[]>(() => {
    const state = this.sourcesState();
    return state.kind === 'ready' ? state.value : [];
  });

  /** The store, once it is here. Null before that, and after a failed first read. */
  readonly storeValue = computed<StoreStateDto | null>(() => {
    const state = this.storeState();
    return state.kind === 'ready' ? state.value : null;
  });

  private handle: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  /** The cadence the next interval should use: ten seconds, or thirty while the last read failed. */
  private interval = BUFFER_POLL_INTERVAL_MS;

  /** The cadence the live interval was created with, so a re-sync only rebuilds it when it moved. */
  private running = 0;

  constructor() {
    void this.load();

    const onVisibilityChange = () => this.onVisibilityChange();
    this.document.addEventListener('visibilitychange', onVisibilityChange);
    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('visibilitychange', onVisibilityChange);
      this.stopPolling();
    });

    this.syncPolling();
  }

  /**
   * One source by its key, or null. This is the only lookup on a key anything does — the key itself
   * is opaque and is never parsed.
   */
  source(key: string | null): TelemetrySourceDto | null {
    if (!key) {
      return null;
    }
    return this.sourceList().find((source) => source.key === key) ?? null;
  }

  /**
   * The first read, and the one a retry re-issues. This one is allowed to blank the band, because
   * before it there is nothing on the band to lose.
   */
  async load(): Promise<void> {
    this.storeState.set(LOADING);
    this.sourcesState.set(LOADING);
    this.pollProblem.set('');
    const [store, sources] = await Promise.allSettled([this.api.store(), this.api.sources()]);
    this.storeState.set(
      store.status === 'fulfilled' ? ready(store.value) : failed(store.reason as unknown),
    );
    this.sourcesState.set(
      sources.status === 'fulfilled' ? ready(sources.value) : failed(sources.reason as unknown),
    );
  }

  /**
   * One tick. Both reads, together, and a failure keeps what is already on screen.
   *
   * `inFlight` is what keeps a slow answer from stacking ticks behind it, and `syncPolling` runs in
   * the `finally` so the backoff — or the recovery from it — takes effect on the very next interval
   * rather than one tick later.
   */
  private async poll(): Promise<void> {
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      const [store, sources] = await Promise.all([this.api.store(), this.api.sources()]);
      this.storeState.set(ready(store));
      this.sourcesState.set(ready(sources));
      this.pollProblem.set('');
      this.interval = BUFFER_POLL_INTERVAL_MS;
    } catch (error) {
      this.pollProblem.set(describeError(error));
      this.interval = BUFFER_BACKOFF_INTERVAL_MS;
    } finally {
      this.inFlight = false;
      this.syncPolling();
    }
  }

  /**
   * A hidden tab reads nothing at all.
   *
   * Unlike the sibling SPAs there is no terminal state to stop on here: a buffer is never finished,
   * and an empty one is not a reason to give up — discovering the first record that arrives is half
   * of what this band is for.
   */
  private shouldPoll(): boolean {
    return !this.document.hidden;
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

  /**
   * Coming back is worth one immediate read rather than up to ten seconds of stale band, and then
   * the interval takes over again.
   */
  private onVisibilityChange(): void {
    if (this.shouldPoll()) {
      void this.poll();
    }
    this.syncPolling();
  }
}
