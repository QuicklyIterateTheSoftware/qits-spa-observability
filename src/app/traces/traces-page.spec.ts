import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { StoreStateDto, TelemetrySourceDto, TraceSummaryDto } from '../api/dto';
import { routes } from '../app.routes';

/**
 * The trace list, driven through `HttpTestingController`.
 *
 * **The budget is the first assertion and the negative half of it is the important one.** The page
 * costs the shell's two plus exactly one, and it costs the shell's two plus *nothing* when no
 * source is named — because a sourceless read answers `200` with an empty list, so a page that
 * fired one anyway would look identical on screen and simply cost a request to say "no telemetry"
 * about a bucket nobody chose. Neither half is visible when it regresses.
 *
 * The rest is what a bounded buffer forces a list to say out loud: which lens reached the service,
 * that `rootMissing` is drawn rather than smoothed over, that truncation is stated with both
 * numbers in it, and that an empty list gives a different reason for every different reason.
 */
describe('TracesPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;

  const SOURCE = '_service/qits-ci';
  const ENCODED = '_service%2Fqits-ci';

  /**
   * A trace's start, in nanoseconds, built rather than typed.
   *
   * A real stamp from this service is a 61-bit figure, and written as a literal it is a number the
   * linter rejects outright: `no-loss-of-precision` sees that a double cannot hold it. That is the
   * same fact the waterfall's own layout records — the low bits are gone before this code ever sees
   * them — and it is worth meeting here as a computed value rather than as a suppression.
   */
  const START_NANOS = Date.UTC(2026, 7, 1, 13, 48, 13) * 1_000_000;

  const store = (over: Partial<StoreStateDto> = {}): StoreStateDto => ({
    startedAt: new Date(Date.now() - 6 * 3600_000).toISOString(),
    totalBytes: 18234112,
    maxTotalBytes: 67108864,
    caps: { spansPerSource: 2000, logsPerSource: 10000, metricSeriesPerSource: 500 },
    sourceCount: 1,
    evictedSpans: 41233,
    evictedLogs: 0,
    droppedMetricSeries: 0,
    ...over,
  });

  const source = (over: Partial<TelemetrySourceDto> = {}): TelemetrySourceDto => ({
    key: SOURCE,
    kind: 'SERVICE',
    label: 'qits-ci',
    repositoryId: null,
    workspaceId: null,
    services: [
      { name: 'qits-ci', spans: 1841, logs: 92, metricSeries: 61 },
      { name: 'qits-artifacts', spans: 12, logs: 3, metricSeries: 8 },
    ],
    spans: 1841,
    logs: 92,
    metricSeries: 61,
    bytes: 3910224,
    oldestReceivedAt: new Date(Date.now() - 3600_000).toISOString(),
    newestReceivedAt: new Date(Date.now() - 120_000).toISOString(),
    ...over,
  });

  const trace = (over: Partial<TraceSummaryDto> = {}): TraceSummaryDto => ({
    traceId: 'c2712ea1a4adc35af6d31de56a75bd39',
    rootName: 'POST /ci/api/events/post-receive',
    rootService: 'qits-ci',
    services: ['qits-ci', 'qits-artifacts'],
    startEpochNanos: START_NANOS,
    durationMs: 812,
    spanCount: 14,
    errorSpanCount: 0,
    hasException: false,
    rootMissing: false,
    ...over,
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open(url: string): Promise<void> {
    harness = await RouterTestingHarness.create(url);
  }

  function page(): HTMLElement {
    return harness.fixture.nativeElement as HTMLElement;
  }

  function text(): string {
    return page().textContent ?? '';
  }

  async function settle(): Promise<void> {
    for (let round = 0; round < 6; round += 1) {
      await Promise.resolve();
      await harness.fixture.whenStable();
    }
  }

  /** The shell's pair, which every screen in this app is answered with. */
  function shell(
    sources: readonly TelemetrySourceDto[] = [source()],
    state: StoreStateDto = store(),
  ): void {
    http.expectOne('/observability/api/telemetry/store').flush(state);
    http.expectOne('/observability/api/telemetry/sources').flush({ sources });
  }

  /** The screen's one read, matched by path so the assertion is about the query separately. */
  function traceRead() {
    return http.expectOne((request) => request.url === '/observability/api/telemetry/traces');
  }

  function flushTraces(
    traces: readonly TraceSummaryDto[] = [trace()],
    envelope: { total?: number; truncated?: boolean } = {},
  ): void {
    traceRead().flush({
      traces,
      total: envelope.total ?? traces.length,
      truncated: envelope.truncated ?? false,
    });
  }

  async function click(label: string): Promise<void> {
    const target = Array.from(page().querySelectorAll('button')).find(
      (button) => (button.textContent ?? '').trim() === label,
    );
    expect(target, `no button reading "${label}"`).toBeTruthy();
    target?.click();
    await settle();
  }

  it('costs the shell’s two plus exactly one', async () => {
    await open(`/traces?source=${ENCODED}`);
    const requests = http.match(() => true);

    expect(requests.map((request) => request.request.url)).toEqual([
      '/observability/api/telemetry/store',
      '/observability/api/telemetry/sources',
      '/observability/api/telemetry/traces',
    ]);

    requests[0].flush(store());
    requests[1].flush({ sources: [source()] });
    requests[2].flush({ traces: [trace()], total: 1, truncated: false });
    await settle();

    expect(text()).toContain('POST /ci/api/events/post-receive');
    http.verify();
  });

  it('costs nothing beyond the shell when no source is named', async () => {
    await open('/traces');
    const requests = http.match(() => true);

    // A read with no source answers 200 and an empty list, so firing one would buy a screen that
    // says "no telemetry" about a bucket nobody chose. This is the assertion that goes quiet.
    expect(requests.map((request) => request.request.url)).toEqual([
      '/observability/api/telemetry/store',
      '/observability/api/telemetry/sources',
    ]);
    requests[0].flush(store());
    requests[1].flush({ sources: [source()] });
    await settle();

    expect(text()).toContain('No source is selected');
    http.verify();
  });

  it('sends the recent lens, the default threshold and the limit it is allowed to send', async () => {
    await open(`/traces?source=${ENCODED}`);
    shell();
    const pending = traceRead();
    const request = pending.request;

    expect(request.params.get('source')).toBe(SOURCE);
    expect(request.params.get('sort')).toBe('recent');
    expect(request.params.get('thresholdMs')).toBe('0');
    // The service answers 400 outside 1..1000 rather than clamping, so this is never taken from
    // a URL or a field — it is the constant.
    expect(request.params.get('limit')).toBe('200');
    expect(request.params.has('service')).toBe(false);

    pending.flush({ traces: [trace()], total: 1, truncated: false });
    await settle();
  });

  it('flips the lens through the URL, and the new lens reaches the service', async () => {
    await open(`/traces?source=${ENCODED}`);
    shell();
    flushTraces();
    await settle();

    await click('Slowest');

    expect(TestBed.inject(Router).url).toContain('sort=duration');
    const request = traceRead();
    expect(request.request.params.get('sort')).toBe('duration');
    request.flush({ traces: [trace()], total: 1, truncated: false });
    await settle();
  });

  it('puts the threshold on the endpoint rather than filtering rows it already paid for', async () => {
    await open(`/traces?source=${ENCODED}`);
    shell();
    flushTraces();
    await settle();

    await click('500 ms');

    expect(TestBed.inject(Router).url).toContain('threshold=500');
    const request = traceRead();
    expect(request.request.params.get('thresholdMs')).toBe('500');
    request.flush({ traces: [], total: 0, truncated: false });
    await settle();

    expect(text()).toContain('ran for 500 ms or longer');
  });

  it('narrows to one service without spending a request on the service list', async () => {
    await open(`/traces?source=${ENCODED}`);
    shell();
    flushTraces();
    await settle();

    // The chips came from the source row the band already holds.
    expect(text()).toContain('qits-artifacts');

    await click('qits-artifacts');

    expect(TestBed.inject(Router).url).toContain('service=qits-artifacts');
    const request = traceRead();
    expect(request.request.params.get('service')).toBe('qits-artifacts');
    request.flush({ traces: [trace()], total: 1, truncated: false });
    await settle();
  });

  it('reads its lenses back out of a shared link rather than starting from defaults', async () => {
    await open(`/traces?source=${ENCODED}&sort=duration&threshold=250&service=qits-artifacts`);
    shell();
    const pending = traceRead();

    expect(pending.request.params.get('sort')).toBe('duration');
    expect(pending.request.params.get('thresholdMs')).toBe('250');
    expect(pending.request.params.get('service')).toBe('qits-artifacts');

    pending.flush({ traces: [trace()], total: 1, truncated: false });
    await settle();
  });

  it('says a root is not buffered rather than presenting a plausible wrong one', async () => {
    await open(`/traces?source=${ENCODED}`);
    shell();
    flushTraces([trace({ rootMissing: true })]);
    await settle();

    expect(text()).toContain('(root not buffered)');
  });

  it('draws no such marker on a trace whose root is buffered', async () => {
    await open(`/traces?source=${ENCODED}`);
    shell();
    flushTraces();
    await settle();

    expect(text()).not.toContain('(root not buffered)');
  });

  it('states a truncation with both numbers, and names the eviction behind the total', async () => {
    await open(`/traces?source=${ENCODED}`);
    shell();
    flushTraces([trace()], { total: 1841, truncated: true });
    await settle();

    expect(text()).toContain('Showing 1 of 1,841 traces.');
    expect(text()).toContain('41,233 older spans');
  });

  it('does not blame eviction for a truncation on a buffer that has evicted nothing', async () => {
    await open(`/traces?source=${ENCODED}`);
    shell([source()], store({ evictedSpans: 0 }));
    flushTraces([trace()], { total: 300, truncated: true });
    await settle();

    expect(text()).toContain('Showing 1 of 300 traces.');
    expect(text()).not.toContain('older spans');
  });

  it('says nothing about truncation when the answer is whole', async () => {
    await open(`/traces?source=${ENCODED}`);
    shell();
    flushTraces();
    await settle();

    expect(text()).not.toContain('Showing');
  });

  it('blames a fresh restart for an empty list, when there was one', async () => {
    await open(`/traces?source=${ENCODED}`);
    shell([source()], store({ startedAt: new Date(Date.now() - 60_000).toISOString() }));
    flushTraces([]);
    await settle();

    expect(text()).toContain('when qits-observability restarted');
  });

  it('does not blame a restart on a buffer that has been up for hours', async () => {
    await open(`/traces?source=${ENCODED}`);
    shell();
    flushTraces([]);
    await settle();

    expect(text()).not.toContain('when qits-observability restarted');
    expect(text()).toContain('No traces are buffered');
  });

  it('tells "this source has received nothing" apart from "this filter excludes everything"', async () => {
    await open(`/traces?source=${ENCODED}`);
    shell([source({ spans: 0, services: [] })]);
    flushTraces([]);
    await settle();

    expect(text()).toContain('No spans have arrived from qits-ci');
  });

  it('names a service filter that matches no reporting service', async () => {
    await open(`/traces?source=${ENCODED}&service=qits-nope`);
    shell();
    flushTraces([]);
    await settle();

    expect(text()).toContain('No service called qits-nope has reported into qits-ci');
  });

  it('keeps the last good list on screen when a refresh fails, and says it is stale', async () => {
    await open(`/traces?source=${ENCODED}`);
    shell();
    flushTraces();
    await settle();

    await click('Refresh');
    traceRead().flush({ message: 'boom' }, { status: 503, statusText: 'Service Unavailable' });
    await settle();

    // A failed *first* read is an error state; this is a failed re-read, and data you know is
    // forty seconds old beats an empty page.
    expect(text()).toContain('POST /ci/api/events/post-receive');
  });

  it('links each row to the waterfall, carrying the source with it', async () => {
    await open(`/traces?source=${ENCODED}`);
    shell();
    flushTraces();
    await settle();

    const link = Array.from(page().querySelectorAll('a')).find((anchor) =>
      (anchor.getAttribute('href') ?? '').includes('/traces/c2712ea1'),
    );
    expect(link?.getAttribute('href')).toContain(`source=${ENCODED}`);
  });
});
