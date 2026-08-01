import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { StoreStateDto, TelemetrySourceDto } from '../api/dto';
import {
  BUFFER_BACKOFF_INTERVAL_MS,
  BUFFER_POLL_INTERVAL_MS,
  TelemetryBuffer,
} from './telemetry-buffer';

/**
 * The app-level poll, with fake timers, because a cadence written down is not a cadence.
 *
 * Three properties, and every one of them is silent when it breaks. A hidden tab that keeps polling
 * looks identical on screen and simply costs. A failed poll that clears the band replaces data you
 * know is 40 s old with nothing at all, which is worse. And a poll that keeps its 30 s backoff after
 * the service comes back is a UI that stays stale for no reason.
 */
describe('TelemetryBuffer', () => {
  let http: HttpTestingController;
  let buffer: TelemetryBuffer;

  const STORE: StoreStateDto = {
    startedAt: '2026-08-01T09:24:20Z',
    totalBytes: 18234112,
    maxTotalBytes: 67108864,
    caps: { spansPerSource: 2000, logsPerSource: 10000, metricSeriesPerSource: 500 },
    sourceCount: 1,
    evictedSpans: 41233,
    evictedLogs: 0,
    droppedMetricSeries: 0,
  };

  const SOURCE: TelemetrySourceDto = {
    key: '_service/qits-ci',
    kind: 'SERVICE',
    label: 'qits-ci',
    repositoryId: null,
    workspaceId: null,
    services: [{ name: 'qits-ci', spans: 1841, logs: 92, metricSeries: 61 }],
    spans: 1841,
    logs: 92,
    metricSeries: 61,
    bytes: 3910224,
    oldestReceivedAt: '2026-08-01T13:02:11Z',
    newestReceivedAt: '2026-08-01T15:40:02Z',
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
  });

  /**
   * `document.hidden` is a getter on the prototype and jsdom does not let a test assign it, so the
   * visibility a spec needs is defined onto the document itself.
   */
  function setHidden(hidden: boolean): void {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  }

  /**
   * Only `setInterval` is faked, and that is deliberate: Angular's zoneless scheduler races a
   * `setTimeout` against a `requestAnimationFrame`, so faking those would freeze the harness itself.
   * It has to happen before the service is constructed, because the interval starts in its
   * constructor.
   */
  function useIntervalFakes(): void {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  }

  function mount(): void {
    buffer = TestBed.inject(TelemetryBuffer);
  }

  /**
   * Drain the microtasks. There is no component here, so there is nothing to stabilise — what a
   * spec is waiting for is a promise chain two links long settling into a signal.
   */
  async function settle(): Promise<void> {
    for (let round = 0; round < 8; round += 1) {
      await Promise.resolve();
    }
  }

  /** One tick's worth of answers. Both reads go out together, so a spec answers both or neither. */
  function flush(sources: readonly TelemetrySourceDto[] = [SOURCE], store: StoreStateDto = STORE) {
    http.expectOne('/observability/api/telemetry/store').flush(store);
    http.expectOne('/observability/api/telemetry/sources').flush({ sources });
  }

  async function tick(millis: number): Promise<void> {
    vi.advanceTimersByTime(millis);
    await settle();
  }

  it('costs exactly two requests on arrival, and they are the store and the sources', async () => {
    mount();
    const requests = http.match(() => true);
    expect(requests.map((request) => request.request.url)).toEqual([
      '/observability/api/telemetry/store',
      '/observability/api/telemetry/sources',
    ]);
    requests[0].flush(STORE);
    requests[1].flush({ sources: [SOURCE] });
    await settle();

    expect(buffer.storeValue()).toMatchObject({ evictedSpans: 41233 });
    expect(buffer.sourceList()).toHaveLength(1);
    http.verify();
  });

  it('finds a source by its opaque key and returns null for one it does not hold', async () => {
    mount();
    flush();
    await settle();

    expect(buffer.source('_service/qits-ci')?.label).toBe('qits-ci');
    expect(buffer.source('_service/nope')).toBeNull();
    expect(buffer.source(null)).toBeNull();
  });

  it('re-reads both every ten seconds and keeps going on an empty buffer', async () => {
    useIntervalFakes();
    mount();
    flush([]);
    await settle();

    // An empty buffer is not a terminal state: discovering the first record is half the job.
    await tick(BUFFER_POLL_INTERVAL_MS);
    flush([]);
    await settle();

    await tick(BUFFER_POLL_INTERVAL_MS);
    flush([SOURCE]);
    await settle();
    expect(buffer.sourceList()).toHaveLength(1);
    http.verify();
  });

  it('reads nothing while the tab is hidden and once as soon as it comes back', async () => {
    useIntervalFakes();
    mount();
    flush();
    await settle();

    setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();

    await tick(BUFFER_POLL_INTERVAL_MS * 3);
    http.verify(); // a hidden tab polls nothing

    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    flush();
    await settle();

    // …and the interval takes over again from there.
    await tick(BUFFER_POLL_INTERVAL_MS);
    flush();
    await settle();
    http.verify();
  });

  it('keeps the last good answer when a poll fails, says so, and backs off to thirty seconds', async () => {
    useIntervalFakes();
    mount();
    flush();
    await settle();

    await tick(BUFFER_POLL_INTERVAL_MS);
    http.expectOne('/observability/api/telemetry/store').flush('down', {
      status: 503,
      statusText: 'Service Unavailable',
    });
    http.expectOne('/observability/api/telemetry/sources').flush('down', {
      status: 503,
      statusText: 'Service Unavailable',
    });
    await settle();

    // The band still has numbers on it, and it knows they are old.
    expect(buffer.sourceList()).toHaveLength(1);
    expect(buffer.store().kind).toBe('ready');
    expect(buffer.problem()).toContain('503');

    // Ten seconds later there is nothing in flight — the cadence moved.
    await tick(BUFFER_POLL_INTERVAL_MS);
    http.verify();

    await tick(BUFFER_BACKOFF_INTERVAL_MS - BUFFER_POLL_INTERVAL_MS);
    flush();
    await settle();
    expect(buffer.problem()).toBe('');

    // And recovery puts it back to ten.
    await tick(BUFFER_POLL_INTERVAL_MS);
    flush();
    await settle();
    http.verify();
  });

  it('reports a failed first read as an error state rather than as a stale band', async () => {
    mount();
    http.expectOne('/observability/api/telemetry/store').flush('nope', {
      status: 503,
      statusText: 'Service Unavailable',
    });
    http.expectOne('/observability/api/telemetry/sources').flush('nope', {
      status: 503,
      statusText: 'Service Unavailable',
    });
    await settle();

    expect(buffer.store().kind).toBe('error');
    expect(buffer.sources().kind).toBe('error');
    expect(buffer.problem()).toBe('');
  });
});
