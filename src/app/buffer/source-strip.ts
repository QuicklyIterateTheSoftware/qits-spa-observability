import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { formatBytes, formatClock, formatCount, formatElapsed } from '../ui/format';
import { tickingNow } from '../ui/ticker';
import { selectedSource } from './selected-source';
import { TelemetryBuffer } from './telemetry-buffer';

/**
 * The band that says what this thing is, on every screen, always.
 *
 * **It is not dismissible and it is not a warning.** A store that empties on restart is a
 * surprising product, and the first job of this UI is to say so before anyone concludes the service
 * is broken. So the sentence is stated as information, in ordinary weight, in the same place every
 * time: held in memory since a stated instant, emptied by a restart, never written to disk.
 *
 * The second line is the selected source's own counts, or the whole buffer's when nothing is
 * selected — so the numbers under the band always describe the same bucket the screen below it is
 * reading.
 *
 * **The eviction count is shown whenever it is non-zero**, in the same weight as the rest. Not
 * hidden, because it is the difference between "the buffer is showing you everything" and "the
 * buffer is showing you what survived"; not styled as an alarm, because eviction is the bound doing
 * exactly what it was built to do.
 *
 * The uptime ticks locally from a 1 s clock signal. Re-reading the store to learn what a
 * subtraction already knows would turn a sentence into traffic.
 *
 * It is a component each page includes rather than something wrapped around the router outlet:
 * `QitsMainLayout` is the shared library's, and this feature does not edit the shared library.
 */
@Component({
  selector: 'app-source-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <aside class="strip">
      <p class="line">
        <strong>Live buffer.</strong>
        @if (startedAt()) {
          Held in qits-observability's memory since <strong>{{ startedAt() }} UTC</strong> ({{
            uptime()
          }}). A restart empties it. Nothing here is written to disk.
        } @else {
          Held in qits-observability's memory. A restart empties it. Nothing here is written to
          disk.
        }
      </p>

      <p class="line counts">
        <span class="scope">{{ scope() }}</span>
        @for (figure of figures(); track figure) {
          <span class="sep" aria-hidden="true">·</span>
          <span>{{ figure }}</span>
        }
        @for (loss of losses(); track loss) {
          <span class="sep" aria-hidden="true">·</span>
          <strong>{{ loss }}</strong>
        }
      </p>

      @if (buffer.problem()) {
        <p class="line stale" role="status">
          The last read failed ({{ buffer.problem() }}). These figures are the last ones that
          arrived, and they are being retried every 30 s.
        </p>
      }
    </aside>
  `,
  styles: `
    :host {
      display: block;
    }
    .strip {
      margin: 0 0 1.25rem;
      padding: 0.6rem 0.85rem;
      border: 1px solid #e5e7eb;
      border-left: 3px solid #4338ca;
      border-radius: 0.375rem;
      background: #f9fafb;
      font-size: 0.88rem;
      color: #374151;
    }
    .line {
      margin: 0;
    }
    .line + .line {
      margin-top: 0.2rem;
    }
    .counts {
      font-variant-numeric: tabular-nums;
      color: #4b5563;
    }
    .scope {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.92em;
    }
    .sep {
      padding: 0 0.4rem;
      color: #9ca3af;
    }
    .stale {
      color: #b45309;
    }
  `,
})
export class SourceStrip {
  protected readonly buffer = inject(TelemetryBuffer);
  private readonly selected = selectedSource();
  private readonly now = tickingNow();

  /** `09:24:20` — the clock reading of the process start, or the empty string before it is known. */
  protected readonly startedAt = computed(() => {
    const store = this.buffer.storeValue();
    return store ? formatClock(store.startedAt) : '';
  });

  /** How long this buffer has been filling. Ticks locally; costs nothing. */
  protected readonly uptime = computed(() => {
    const store = this.buffer.storeValue();
    if (!store) {
      return '';
    }
    return formatElapsed(this.now() - new Date(store.startedAt).getTime());
  });

  /** Which bucket the figures below describe: one source, or the whole buffer. */
  protected readonly scope = computed(() => {
    const source = this.buffer.source(this.selected());
    if (source) {
      return source.label;
    }
    return this.selected() ? this.selected() : 'All sources';
  });

  /**
   * The counts, for the selected source or summed over every source.
   *
   * Summing per-source counts is safe here and is not the kind of addition the sibling explorers
   * refuse: these are record counts in disjoint buckets, not a deduplicated byte store.
   */
  protected readonly figures = computed<readonly string[]>(() => {
    const source = this.buffer.source(this.selected());
    const sources = this.buffer.sourceList();
    if (!source && sources.length === 0) {
      return [];
    }
    const spans = source ? source.spans : sum(sources, (one) => one.spans);
    const logs = source ? source.logs : sum(sources, (one) => one.logs);
    const series = source ? source.metricSeries : sum(sources, (one) => one.metricSeries);
    const bytes = source ? source.bytes : sum(sources, (one) => one.bytes);
    return [
      `${formatCount(spans)} spans`,
      `${formatCount(logs)} logs`,
      `${formatCount(series)} series`,
      formatBytes(bytes),
    ];
  });

  /**
   * What the bounds have already taken, store-wide.
   *
   * Store-wide rather than per source, and it has to be: the counters live on the buffer, not on a
   * bucket. A zero counter is drawn as nothing at all — "0 evicted" is noise on a buffer that has
   * never filled.
   */
  protected readonly losses = computed<readonly string[]>(() => {
    const store = this.buffer.storeValue();
    if (!store) {
      return [];
    }
    const losses: string[] = [];
    if (store.evictedSpans > 0) {
      losses.push(`${formatCount(store.evictedSpans)} spans evicted`);
    }
    if (store.evictedLogs > 0) {
      losses.push(`${formatCount(store.evictedLogs)} logs evicted`);
    }
    if (store.droppedMetricSeries > 0) {
      losses.push(`${formatCount(store.droppedMetricSeries)} metric series dropped`);
    }
    return losses;
  });
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  return items.reduce((total, item) => total + of(item), 0);
}
