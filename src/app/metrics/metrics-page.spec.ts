import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { StoreStateDto, TelemetryMetricDto, TelemetrySourceDto } from '../api/dto';
import { routes } from '../app.routes';
import { METRIC_TABLE_POLL_INTERVAL_MS } from './metrics-page';

/**
 * The metric table, driven through `HttpTestingController`.
 *
 * **The budget is the first assertion and its two negatives are the ones that go quiet.** The page
 * costs the shell's two plus exactly one; the shell's two plus *nothing* when no source is named;
 * and typing in the name box costs nothing at all, because one read already holds every series the
 * bucket has. A regression in any of the three looks identical on screen.
 *
 * The rest is what this screen has to say that no other does: that there is no history and
 * therefore nothing to plot, that a metric series is dropped at a cap rather than evicted, and that
 * a series is keyed by name and attributes with the reporting service left out of the identity.
 */
describe('MetricsPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;

  const SOURCE = '_service/qits-ci';
  const ENCODED = '_service%2Fqits-ci';

  const store = (over: Partial<StoreStateDto> = {}): StoreStateDto => ({
    startedAt: new Date(Date.now() - 6 * 3600_000).toISOString(),
    totalBytes: 6995662,
    maxTotalBytes: 67108864,
    caps: { spansPerSource: 2000, logsPerSource: 10000, metricSeriesPerSource: 500 },
    sourceCount: 9,
    evictedSpans: 2204,
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
    services: [{ name: 'qits-ci', spans: 97, logs: 20, metricSeries: 36 }],
    spans: 97,
    logs: 20,
    metricSeries: 36,
    bytes: 272604,
    oldestReceivedAt: new Date(Date.now() - 3600_000).toISOString(),
    newestReceivedAt: new Date(Date.now() - 120_000).toISOString(),
    ...over,
  });

  /* Built rather than typed: a nanosecond epoch is a 61-bit figure and the linter rejects the
     literal outright. */
  const BASE_MILLIS = Date.UTC(2026, 7, 1, 15, 3, 0);
  const nanosAt = (offsetMs: number) => (BASE_MILLIS + offsetMs) * 1_000_000;

  const metric = (over: Partial<TelemetryMetricDto> = {}): TelemetryMetricDto => ({
    name: 'jvm.memory.used',
    description: 'Measure of memory used.',
    unit: 'By',
    type: 'COUNTER',
    value: 168296448,
    epochNanos: nanosAt(0),
    serviceName: 'qits-ci',
    attributes: { 'jvm.memory.type': 'heap', 'jvm.memory.pool.name': 'eden space' },
    ...over,
  });

  /** The live shape of the one gauge every qits service reports, attributes and all. */
  const gauge = (over: Partial<TelemetryMetricDto> = {}): TelemetryMetricDto =>
    metric({
      name: 'jvm.cpu.recent_utilization',
      description: 'Recent CPU utilization for the process.',
      unit: '1',
      type: 'GAUGE',
      value: 0.0021456,
      attributes: {},
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

  afterEach(() => {
    vi.useRealTimers();
    http.verify();
  });

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

  /** The screen's one read, matched by path so the query is asserted separately. */
  function metricRead() {
    return http.expectOne((request) => request.url === '/observability/api/telemetry/metrics');
  }

  function flushMetrics(metrics: readonly TelemetryMetricDto[] = [metric()]): void {
    metricRead().flush({ metrics });
  }

  async function click(label: string): Promise<void> {
    const target = Array.from(page().querySelectorAll('button')).find(
      (button) => (button.textContent ?? '').trim() === label,
    );
    expect(target, `no button reading "${label}"`).toBeTruthy();
    target?.click();
    await settle();
  }

  function rows(): string[][] {
    return Array.from(page().querySelectorAll('tbody tr:not(.group)')).map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) =>
        (cell.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ),
    );
  }

  it('costs the shell’s two plus exactly one', async () => {
    await open(`/metrics?source=${ENCODED}`);
    const requests = http.match(() => true);

    expect(requests.map((request) => request.request.url)).toEqual([
      '/observability/api/telemetry/store',
      '/observability/api/telemetry/sources',
      '/observability/api/telemetry/metrics',
    ]);

    requests[0].flush(store());
    requests[1].flush({ sources: [source()] });
    requests[2].flush({ metrics: [metric()] });
    await settle();

    expect(text()).toContain('jvm.memory.used');
    http.verify();
  });

  it('costs nothing beyond the shell when no source is named', async () => {
    await open('/metrics');
    const requests = http.match(() => true);

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

  it('sends the source, and no name and no window at all', async () => {
    await open(`/metrics?source=${ENCODED}`);
    shell();
    const pending = metricRead();

    expect(pending.request.params.get('source')).toBe(SOURCE);
    // The endpoint's `name` is an exact, case-sensitive match, so the box is not wired to it.
    expect(pending.request.params.has('name')).toBe(false);
    expect(pending.request.params.has('service')).toBe(false);
    // There is no window on this endpoint: a latest value has none to be inside.
    expect(pending.request.params.has('sinceMinutes')).toBe(false);
    expect(pending.request.params.has('limit')).toBe(false);

    pending.flush({ metrics: [metric()] });
    await settle();
  });

  it('narrows by name in the browser, at no request, and says where the filter is applied', async () => {
    await open(`/metrics?source=${ENCODED}`);
    shell();
    flushMetrics([metric(), gauge()]);
    await settle();

    expect(text()).toContain('jvm.cpu.recent_utilization');

    const field = page().querySelector('#metric-name') as HTMLInputElement;
    field.value = 'MEMORY';
    field.dispatchEvent(new Event('change'));
    await settle();

    // The lens is in the URL — this screen is a link somebody can send — and it costs nothing:
    // `http.verify()` in the afterEach would fail on a request that was never flushed.
    expect(TestBed.inject(Router).url).toContain('name=MEMORY');
    expect(text()).toContain('jvm.memory.used');
    expect(text()).not.toContain('jvm.cpu.recent_utilization');
    expect(text()).toContain('Showing 1 of 2 series');
    expect(text()).toContain('Nothing was left on the server');
  });

  it('reads its lenses back out of a shared link rather than starting from defaults', async () => {
    await open(`/metrics?source=${ENCODED}&name=cpu&service=qits-ci`);
    shell();
    const pending = metricRead();

    expect(pending.request.params.get('service')).toBe('qits-ci');
    pending.flush({ metrics: [metric(), gauge()] });
    await settle();

    expect(text()).toContain('jvm.cpu.recent_utilization');
    expect(text()).not.toContain('jvm.memory.used');
  });

  it('narrows to one service on the wire, without spending a request on the service list', async () => {
    await open(`/metrics?source=${ENCODED}`);
    shell([source({ services: [{ name: 'qits-ci', spans: 97, logs: 20, metricSeries: 36 }] })]);
    flushMetrics();
    await settle();

    await click('qits-ci');

    expect(TestBed.inject(Router).url).toContain('service=qits-ci');
    const request = metricRead();
    expect(request.request.params.get('service')).toBe('qits-ci');
    request.flush({ metrics: [metric()] });
    await settle();
  });

  it('says there is no history and therefore nothing to plot, where a chart would be', async () => {
    await open(`/metrics?source=${ENCODED}`);
    shell();
    flushMetrics();
    await settle();

    expect(text()).toContain(
      'Latest value only — the store keeps no history, so there is nothing to plot.',
    );
    // ⚖7, stated as a decision rather than left as an omission.
    expect(text()).toContain('what this browser tab happened to observe');
    expect(page().querySelector('svg')).toBeNull();
    expect(page().querySelector('canvas')).toBeNull();
  });

  it('draws a series as its attributes, its value in its unit, and the exporter’s own stamp', async () => {
    await open(`/metrics?source=${ENCODED}`);
    shell();
    flushMetrics([metric(), gauge()]);
    await settle();

    // Groups sort by name, so the gauge comes first and carries no attributes; the byte counter
    // follows with two, sorted by key as the store sorts them into its series identity.
    const drawn = rows();
    expect(drawn.map((cells) => cells.slice(0, 3))).toEqual([
      ['no attributes — one series for this metric', 'qits-ci', '0.0021456'],
      ['jvm.memory.pool.name=eden space jvm.memory.type=heap', 'qits-ci', '161 MiB'],
    ]);

    // Absolute first and relative second, on every stamp this app draws: a buffer whose contents may
    // predate your last page load by hours makes a bare "2 m ago" an invitation to the wrong
    // conclusion. The suffix itself moves against a live clock, so only its shape is asserted.
    expect(drawn[0][3]).toMatch(/^15:03:00 · .+ ago$/);
  });

  it('names the kind and the unit on the group rather than on every row', async () => {
    await open(`/metrics?source=${ENCODED}`);
    shell();
    flushMetrics([gauge()]);
    await settle();

    const group = page().querySelector('tbody .group')?.textContent ?? '';
    expect(group).toContain('jvm.cpu.recent_utilization');
    expect(group).toContain('GAUGE');
    // The raw UCUM spelling stays authoritative; the gloss sits beside it, because "1" is
    // otherwise indistinguishable from noise.
    expect(group).toContain('unit 1');
    expect(group).toContain('dimensionless');
    expect(group).toContain('Recent CPU utilization for the process.');
  });

  it('re-reads on the app’s ordinary cadence', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await open(`/metrics?source=${ENCODED}`);
    shell();
    flushMetrics();
    await settle();

    await vi.advanceTimersByTimeAsync(METRIC_TABLE_POLL_INTERVAL_MS);
    await settle();
    metricRead().flush({ metrics: [metric({ value: 175000000 })] });
    // The band keeps its own ten-second cadence and ticks on the same clock, so its pair comes due
    // here too. Answering it is what keeps this assertion about the table.
    http
      .match((request) => request.url.endsWith('/store'))
      .forEach((pending) => pending.flush(store()));
    http
      .match((request) => request.url.endsWith('/sources'))
      .forEach((pending) => pending.flush({ sources: [source()] }));
    await settle();

    expect(text()).toContain('167 MiB');
  });

  it('keeps the last good table on screen when a refresh fails, and says it is stale', async () => {
    await open(`/metrics?source=${ENCODED}`);
    shell();
    flushMetrics();
    await settle();

    await click('Refresh');
    metricRead().flush({ message: 'boom' }, { status: 503, statusText: 'Service Unavailable' });
    await settle();

    expect(text()).toContain('jvm.memory.used');
    expect(text()).toContain('The last refresh failed');
  });

  it('names a bucket that has never reported a metric, and says it was not evicted', async () => {
    await open(`/metrics?source=${ENCODED}`);
    shell([source({ metricSeries: 0 })]);
    flushMetrics([]);
    await settle();

    // A metric series is dropped at a cap, never evicted — so "it was here and got pushed out" is
    // the one explanation this screen must not offer.
    expect(text()).toContain('No metric series have arrived from qits-ci');
    expect(text()).toContain('not evicted once it exists');
  });

  it('blames a fresh restart for an empty table, when there was one', async () => {
    await open(`/metrics?source=${ENCODED}`);
    shell([source()], store({ startedAt: new Date(Date.now() - 60_000).toISOString() }));
    flushMetrics([]);
    await settle();

    expect(text()).toContain('when qits-observability restarted');
  });

  it('does not blame a restart for a table that has been empty for hours', async () => {
    await open(`/metrics?source=${ENCODED}`);
    shell();
    flushMetrics([]);
    await settle();

    expect(text()).not.toContain('when qits-observability restarted');
    expect(text()).toContain('histograms and summaries are dropped');
  });

  it('names a name filter that matches nothing, and says the read brought everything back', async () => {
    await open(`/metrics?source=${ENCODED}&name=nothing`);
    shell();
    flushMetrics([metric(), gauge()]);
    await settle();

    expect(text()).toContain('No metric name in qits-ci contains “nothing”');
    expect(text()).toContain('2 series');
  });

  it('names a service filter that matches no reporting service', async () => {
    await open(`/metrics?source=${ENCODED}&service=qits-nope`);
    shell();
    flushMetrics([]);
    await settle();

    expect(text()).toContain('No service called qits-nope has reported into qits-ci');
  });

  it('says what the series cap has refused, which is the only truncation this screen can suffer', async () => {
    await open(`/metrics?source=${ENCODED}`);
    shell([source({ metricSeries: 500 })], store({ droppedMetricSeries: 118 }));
    flushMetrics();
    await settle();

    expect(text()).toContain('Each source holds at most 500 series.');
    expect(text()).toContain('118 new series have been refused');
    // The failure is invisible in a table of rows that are all correct, which is why it is stated.
    expect(text()).toContain('a row that never appears at all');
  });

  it('says nothing about the cap on a buffer that has refused nothing and is nowhere near it', async () => {
    await open(`/metrics?source=${ENCODED}`);
    shell();
    flushMetrics();
    await settle();

    expect(text()).not.toContain('Each source holds at most');
  });

  it('warns that two services in one bucket share a series', async () => {
    await open(`/metrics?source=${ENCODED}`);
    shell([
      source({
        services: [
          { name: 'qits-ci', spans: 97, logs: 20, metricSeries: 36 },
          { name: 'qits-cd', spans: 20, logs: 16, metricSeries: 35 },
        ],
      }),
    ]);
    flushMetrics();
    await settle();

    // Measured in the service: `MetricPoint.seriesKey()` is the name plus the sorted attribute set,
    // and the reporting service is not in it — so the later arrival wins, silently.
    expect(text()).toContain('the reporting service is not part of that identity');
  });

  it('stays quiet about the collision where a bucket holds one service, which is every bucket today', async () => {
    await open(`/metrics?source=${ENCODED}`);
    shell();
    flushMetrics();
    await settle();

    expect(text()).not.toContain('the reporting service is not part of that identity');
  });
});
