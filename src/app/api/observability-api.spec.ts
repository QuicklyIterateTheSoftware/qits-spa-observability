import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ObservabilityApi } from './observability-api';
import type { TelemetrySourceDto } from './dto';

/**
 * The paths, the parameters and the envelopes, asserted once here so the screens' specs can be
 * about rendering.
 *
 * These are same-origin absolute paths on purpose — the SPA is served at `/observability/` behind
 * the gateway that also authenticates `/observability/api/telemetry/…`, and that is what carries
 * the browser's session cookie to both with no machine token.
 *
 * Two of these assertions are negatives, and they are the ones worth having. A window this app did
 * not set must not be sent, because the store is bounded already and a `sinceMinutes` nobody asked
 * for hides records the buffer still holds. And a source key must reach the wire **verbatim** — it
 * is opaque, it contains a slash today, and an app that normalised or split it would address a
 * bucket that does not exist and be answered `200` with nothing.
 */
describe('ObservabilityApi', () => {
  let api: ObservabilityApi;
  let http: HttpTestingController;

  const source = (over: Partial<TelemetrySourceDto> = {}): TelemetrySourceDto => ({
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
    ...over,
  });

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(ObservabilityApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('reads the buffer state as it comes, with no parameters at all', async () => {
    const store = api.store();
    const request = http.expectOne('/observability/api/telemetry/store');
    expect(request.request.params.keys()).toEqual([]);
    request.flush({
      startedAt: '2026-08-01T09:24:20Z',
      totalBytes: 18234112,
      maxTotalBytes: 67108864,
      caps: { spansPerSource: 2000, logsPerSource: 10000, metricSeriesPerSource: 500 },
      sourceCount: 10,
      evictedSpans: 41233,
      evictedLogs: 0,
      droppedMetricSeries: 0,
    });
    await expect(store).resolves.toMatchObject({ sourceCount: 10, evictedSpans: 41233 });
  });

  it('unwraps the sources listing', async () => {
    const sources = api.sources();
    http.expectOne('/observability/api/telemetry/sources').flush({ sources: [source()] });
    await expect(sources).resolves.toMatchObject([{ key: '_service/qits-ci', kind: 'SERVICE' }]);
  });

  it('sends the source key verbatim, slash and all', async () => {
    const traces = api.traces({ source: '_service/qits-ci' });
    const request = http.expectOne(
      (candidate) => candidate.url === '/observability/api/telemetry/traces',
    );
    expect(request.request.params.get('source')).toBe('_service/qits-ci');
    request.flush({ traces: [], total: 0, truncated: false });
    await expect(traces).resolves.toMatchObject({ total: 0 });
  });

  it('defaults the trace list to the Recent lens and sends no window it was not given', async () => {
    const traces = api.traces({ source: 'repo-1/wt-9', limit: 200 });
    const request = http.expectOne(
      (candidate) => candidate.url === '/observability/api/telemetry/traces',
    );
    expect(request.request.params.get('sort')).toBe('recent');
    expect(request.request.params.get('limit')).toBe('200');
    expect(request.request.params.has('sinceMinutes')).toBe(false);
    expect(request.request.params.has('service')).toBe(false);
    request.flush({ traces: [], total: 0, truncated: false });
    await traces;
  });

  it('sends the Slowest lens when it is asked for, and a service filter beside it', async () => {
    const traces = api.traces({ source: 's', service: 'qits-gateway', sort: 'duration' });
    const request = http.expectOne(
      (candidate) => candidate.url === '/observability/api/telemetry/traces',
    );
    expect(request.request.params.get('sort')).toBe('duration');
    expect(request.request.params.get('service')).toBe('qits-gateway');
    request.flush({ traces: [], total: 0, truncated: false });
    await traces;
  });

  it('encodes the trace id into the path and unwraps the trace', async () => {
    const trace = api.trace('4bf92f/35', { source: 's' });
    const request = http.expectOne(
      (candidate) => candidate.url === '/observability/api/telemetry/traces/4bf92f%2F35',
    );
    request.flush({ trace: { traceId: '4bf92f/35', spans: [], logs: [] } });
    await expect(trace).resolves.toMatchObject({ spans: [], logs: [] });
  });

  it('keeps the errors envelope whole — total and truncated are what a screen budgets against', async () => {
    const errors = api.errors({ source: 's', sinceMinutes: 15, limit: 200 });
    const request = http.expectOne(
      (candidate) => candidate.url === '/observability/api/telemetry/errors',
    );
    expect(request.request.params.get('sinceMinutes')).toBe('15');
    request.flush({ groups: [], total: 340, truncated: true });
    await expect(errors).resolves.toMatchObject({ total: 340, truncated: true });
  });

  it('sends the log search only when there is one', async () => {
    const logs = api.logs({ source: 's', query: 'ERROR' });
    const withQuery = http.expectOne(
      (candidate) => candidate.url === '/observability/api/telemetry/logs',
    );
    expect(withQuery.request.params.get('query')).toBe('ERROR');
    withQuery.flush({ logs: [], total: 0, truncated: false });
    await logs;

    const plain = api.logs({ source: 's', query: '' });
    const request = http.expectOne(
      (candidate) => candidate.url === '/observability/api/telemetry/logs',
    );
    expect(request.request.params.has('query')).toBe(false);
    request.flush({ logs: [], total: 0, truncated: false });
    await plain;
  });

  it('sends thresholdMs 0 rather than dropping it — zero is the lens, not an absence', async () => {
    const spans = api.slowSpans({ source: 's', thresholdMs: 0 });
    const request = http.expectOne(
      (candidate) => candidate.url === '/observability/api/telemetry/slow-spans',
    );
    expect(request.request.params.get('thresholdMs')).toBe('0');
    expect(request.request.params.get('sort')).toBe('duration');
    request.flush({ spans: [], total: 0, truncated: false });
    await spans;
  });

  it('unwraps the metrics, which carry no envelope because they carry no limit', async () => {
    const metrics = api.metrics({ source: 's', name: 'http.server.requests' });
    const request = http.expectOne(
      (candidate) => candidate.url === '/observability/api/telemetry/metrics',
    );
    expect(request.request.params.get('name')).toBe('http.server.requests');
    expect(request.request.params.has('limit')).toBe(false);
    request.flush({ metrics: [{ name: 'http.server.requests', type: 'COUNTER', value: 12 }] });
    await expect(metrics).resolves.toHaveLength(1);
  });
});
