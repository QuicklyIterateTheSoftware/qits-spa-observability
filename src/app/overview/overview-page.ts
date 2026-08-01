import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { QitsBadge, QitsButton } from '@qits/ui-components';
import type { SourceKind, TelemetrySourceDto } from '../api/dto';
import { SOURCE_PARAM, selectedSource } from '../buffer/selected-source';
import { SourceStrip } from '../buffer/source-strip';
import { TelemetryBuffer } from '../buffer/telemetry-buffer';
import { Async } from '../ui/async';
import { Empty } from '../ui/empty';
import { formatBytes, formatCount, formatElapsed, formatInstant, formatStamp } from '../ui/format';
import { bufferAge, restartEmptied } from '../ui/restart';
import { tickingNow } from '../ui/ticker';

/**
 * The landing page: what is arriving, from whom, and what the thing holding it actually is.
 *
 * **Load budget: `2 + 0`.** Both requests are the shell's, held by {@link TelemetryBuffer} and
 * shared with every other screen:
 *
 * - `GET /observability/api/telemetry/store` — the buffer's own state.
 * - `GET /observability/api/telemetry/sources` — one row per bucket, with its per-service
 *   breakdown inside it.
 *
 * The variable term is genuinely zero and stays zero. A source's counts and its per-service
 * breakdown arrive **with** the row, so expanding one costs nothing and selecting one costs
 * nothing: selection is a query parameter that the next screen reads, not a request this page
 * makes. That is the negative the spec asserts, because it is silent when it regresses — a page
 * that fanned out per source would look identical.
 *
 * **This is the landing page on purpose.** On a platform whose telemetry was invisible until now,
 * "is anything arriving at all" is the first question, and it is the one this screen answers. It is
 * also where the ephemerality is stated in full rather than in the band's one line — see the
 * template's "What this is" section, which is information and not an apology. The store empties on
 * every restart of qits-observability, by design: it is a bounded in-memory buffer with no database
 * behind it, and a page that let a reader discover that by being confused would have failed at the
 * only job it has before the first record arrives.
 *
 * **Empty is a family of answers, not one.** A buffer that came up two minutes ago and a buffer
 * that has been running six hours and received nothing are the same blank screen and completely
 * different facts, so this page never draws "No data" — see {@link emptyReason}.
 */
@Component({
  selector: 'app-overview-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Empty, QitsBadge, QitsButton, RouterLink, SourceStrip],
  templateUrl: './overview-page.html',
  styleUrls: ['../ui/page.css', './overview-page.css'],
})
export class OverviewPage {
  protected readonly buffer = inject(TelemetryBuffer);
  private readonly router = inject(Router);
  private readonly selected = selectedSource();
  private readonly now = tickingNow();

  protected readonly formatBytes = formatBytes;
  protected readonly formatCount = formatCount;
  protected readonly formatInstant = formatInstant;
  protected readonly sourceParam = SOURCE_PARAM;

  /** Which sources have their per-service breakdown open. Pure view state, so it stays local. */
  private readonly expanded = signal<ReadonlySet<string>>(new Set());

  protected readonly sources = this.buffer.sourceList;
  protected readonly store = this.buffer.storeValue;
  protected readonly selectedKey = this.selected;

  /** How long this process has been up, ticking locally. */
  protected readonly uptime = computed(() => {
    const age = bufferAge(this.buffer.storeValue(), this.now());
    return age === null ? '' : formatElapsed(age);
  });

  /**
   * What the count caps are, said as one clause.
   *
   * Counts and not bytes, and that ordering is a measurement rather than a preference: a full
   * buffer of spans and logs estimates well under the byte ceiling, so the count caps bind first,
   * every time. A pressure figure drawn from bytes would sit near the same fraction forever.
   */
  protected readonly caps = computed(() => {
    const store = this.buffer.storeValue();
    if (!store) {
      return '';
    }
    const caps = store.caps;
    return (
      `${formatCount(caps.spansPerSource)} spans, ${formatCount(caps.logsPerSource)} logs and ` +
      `${formatCount(caps.metricSeriesPerSource)} metric series per source`
    );
  });

  /** Whether the bounds have taken anything yet, which changes what every count below means. */
  protected readonly hasEvicted = computed(() => {
    const store = this.buffer.storeValue();
    return store !== null && store.evictedSpans + store.evictedLogs + store.droppedMetricSeries > 0;
  });

  /**
   * Why the source list is empty, in a sentence, and never the same sentence twice.
   *
   * Two conditions, and they are genuinely different facts. A restart inside the last few minutes
   * explains an empty buffer completely, and the page says so with the instant in it. Without one,
   * an empty buffer after hours of uptime means nothing is exporting — which is a real problem and
   * must not be dressed up as a fresh start.
   */
  protected readonly emptyReason = computed(() => {
    const store = this.buffer.storeValue();
    const since = bufferAge(store, this.now());
    if (!store || since === null) {
      return 'No sources have been read yet.';
    }
    const restart = restartEmptied(
      store,
      this.now(),
      'Anything from before that is gone, and whatever exports next will appear here.',
    );
    if (restart) {
      return restart;
    }
    return (
      `Nothing has arrived in ${formatElapsed(since)} of uptime. The buffer is reachable and ` +
      'empty, which means no process is currently exporting OTLP to this service.'
    );
  });

  /**
   * The workspace lens's own answer, which is the honest form of a parked item.
   *
   * The other lens on this service is keyed on a repository and a workspace, it is real, and it has
   * never had a subject: no workspace dev server exports OTLP, because the sender that would do it
   * was dropped during a daemon extraction and the live launch path never had it. That is recorded
   * in qits-observability's README and it is nobody's to fix from here.
   *
   * Saying so is the point. A reader who knows this platform runs workspaces will look for their
   * telemetry, find an empty row or no row at all, and conclude that this screen is broken — and the
   * sentence that prevents it has to name the gap, say where it is written down, and promise nothing
   * about when. When the sender lands, these buckets fill and this page needs no change.
   *
   * It is silent while a workspace bucket holds anything, and silent when the whole buffer is empty:
   * there the restart or the total silence is the explanation, and a paragraph about workspaces
   * would be a second answer to a question that already has one.
   */
  protected readonly workspaceNote = computed(() => {
    const sources = this.sources();
    if (sources.length === 0) {
      return '';
    }
    const workspaces = sources.filter((source) => source.kind === 'WORKSPACE');
    if (workspaces.some((source) => source.spans + source.logs + source.metricSeries > 0)) {
      return '';
    }
    const opening =
      workspaces.length === 0
        ? 'No workspace has exported telemetry, and no workspace bucket exists.'
        : `${formatCount(workspaces.length)} workspace buckets exist and none of them holds a ` +
          'record.';
    return (
      `${opening} Workspace dev servers do not send OTLP yet — the sender is a known gap, recorded ` +
      "in qits-observability's README. When it lands, workspace telemetry appears here with no " +
      'change to this page.'
    );
  });

  /** The age span of what a source holds — the window a query can actually reach. */
  protected span(source: TelemetrySourceDto): string {
    if (!source.oldestReceivedAt || !source.newestReceivedAt) {
      return 'nothing buffered';
    }
    return `${formatStamp(source.oldestReceivedAt, this.now())} → ${formatStamp(
      source.newestReceivedAt,
      this.now(),
    )}`;
  }

  /** What a bucket is, as a badge tone. Workspace buckets are real and, today, uniformly empty. */
  protected kindTone(kind: SourceKind): 'info' | 'neutral' | 'warning' {
    switch (kind) {
      case 'SERVICE':
        return 'info';
      case 'WORKSPACE':
        return 'neutral';
      default:
        return 'warning';
    }
  }

  protected isExpanded(key: string): boolean {
    return this.expanded().has(key);
  }

  /** Costs no request: the breakdown arrived with the row. */
  protected toggle(key: string): void {
    const next = new Set(this.expanded());
    if (!next.delete(key)) {
      next.add(key);
    }
    this.expanded.set(next);
  }

  protected isSelected(key: string): boolean {
    return this.selected() === key;
  }

  /**
   * Select a source, or clear the selection by choosing the one already selected.
   *
   * A navigation rather than a signal write, because the selection is URL state: it decides which
   * bucket every other screen reads, and a shared link that lands on the wrong bucket answers a
   * different question with the same confidence.
   */
  protected async select(key: string): Promise<void> {
    const source = this.isSelected(key) ? null : key;
    await this.router.navigate([], { queryParams: { [SOURCE_PARAM]: source } });
  }
}
