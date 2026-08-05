import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { StoreStateDto, TelemetryLogDto, TelemetrySourceDto } from '../api/dto';
import { routes } from '../app.routes';
import { LOG_TAIL_FOLLOW_INTERVAL_MS } from './logs-page';

/**
 * The log tail, driven through `HttpTestingController`.
 *
 * **The budget is the first assertion and its negative half is the one that goes quiet.** The page
 * costs the shell's two plus exactly one, and the shell's two plus *nothing* when no source is
 * named — a sourceless read answers `200` with an empty list, which draws exactly like a service
 * that has never logged.
 *
 * The rest is follow mode and honesty. Follow is the one quickened poll in this application, so its
 * cadence, its silence when it is off and its auto-off on a scroll are all asserted on a fake clock
 * rather than described. And the two claims this screen makes in prose — that the search matches
 * severity text as well as body, and that a truncated tail keeps the **newest** records — are both
 * facts about the service, so both are pinned to what the service actually answered when it was
 * asked.
 */
describe('LogsPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;

  const SOURCE = '_service/qits-fixture';
  const ENCODED = '_service%2Fqits-fixture';

  /* Built rather than typed: a nanosecond epoch is a 61-bit figure and the linter rejects the
     literal outright. */
  const BASE_MILLIS = Date.UTC(2026, 7, 1, 13, 48, 13);
  const nanosAt = (offsetMs: number) => (BASE_MILLIS + offsetMs) * 1_000_000;

  const store = (over: Partial<StoreStateDto> = {}): StoreStateDto => ({
    startedAt: new Date(Date.now() - 6 * 3600_000).toISOString(),
    totalBytes: 6535512,
    maxTotalBytes: 67108864,
    caps: { spansPerSource: 2000, logsPerSource: 10000, metricSeriesPerSource: 500 },
    sourceCount: 1,
    evictedSpans: 0,
    evictedLogs: 812,
    droppedMetricSeries: 0,
    ...over,
  });

  const source = (over: Partial<TelemetrySourceDto> = {}): TelemetrySourceDto => ({
    key: SOURCE,
    kind: 'SERVICE',
    label: 'qits-fixture',
    repositoryId: null,
    workspaceId: null,
    services: [
      { name: 'qits-fixture', spans: 12, logs: 6, metricSeries: 0 },
      { name: 'qits-artifacts', spans: 4, logs: 0, metricSeries: 0 },
    ],
    spans: 12,
    logs: 6,
    metricSeries: 0,
    bytes: 11244,
    oldestReceivedAt: new Date(Date.now() - 3600_000).toISOString(),
    newestReceivedAt: new Date(Date.now() - 120_000).toISOString(),
    ...over,
  });

  const log = (over: Partial<TelemetryLogDto> = {}): TelemetryLogDto => ({
    epochNanos: nanosAt(0),
    severityNumber: 9,
    severityText: 'INFO',
    body: 'writing blob 41ab to the store',
    traceId: 'aa00bb11cc22dd33ee44ff5566778899',
    spanId: '2222222222222222',
    serviceName: 'qits-fixture',
    attributes: {},
    /* Every record on the wire carries what its process said about itself. The tail draws none of
       it — its rows are one line each and a build repeated down two hundred of them is noise; the
       waterfall's detail pane and the errors screen's evidence are where it is read. */
    resourceAttributes: {
      'service.name': 'qits-fixture',
      'service.version': '2026.802.164102',
    },
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
  function logRead() {
    return http.expectOne((request) => request.url === '/observability/api/telemetry/logs');
  }

  function flushLogs(
    logs: readonly TelemetryLogDto[] = [log()],
    envelope: { total?: number; truncated?: boolean } = {},
  ): void {
    logRead().flush({
      logs,
      total: envelope.total ?? logs.length,
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

  /** The rail, given a geometry jsdom does not lay out, so a scroll can be a real one. */
  function rail(scrollTop: number): HTMLElement {
    const element = page().querySelector('ol.tail') as HTMLElement;
    expect(element, 'no tail rail').toBeTruthy();
    Object.defineProperty(element, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(element, 'clientHeight', { value: 300, configurable: true });
    element.scrollTop = scrollTop;
    return element;
  }

  it('costs the shell’s two plus exactly one', async () => {
    await open(`/logs?source=${ENCODED}`);
    const requests = http.match(() => true);

    expect(requests.map((request) => request.request.url)).toEqual([
      '/observability/api/telemetry/store',
      '/observability/api/telemetry/sources',
      '/observability/api/telemetry/logs',
    ]);

    requests[0].flush(store());
    requests[1].flush({ sources: [source()] });
    requests[2].flush({ logs: [log()], total: 1, truncated: false });
    await settle();

    expect(text()).toContain('writing blob 41ab to the store');
    http.verify();
  });

  it('costs nothing beyond the shell when no source is named', async () => {
    await open('/logs');
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

  it('sends the source and the limit it is allowed to send, and no search or window by default', async () => {
    await open(`/logs?source=${ENCODED}`);
    shell();
    const pending = logRead();

    expect(pending.request.params.get('source')).toBe(SOURCE);
    // 400 outside 1..1000 rather than a clamp, so it is a constant and never a field.
    expect(pending.request.params.get('limit')).toBe('200');
    expect(pending.request.params.has('query')).toBe(false);
    expect(pending.request.params.has('sinceMinutes')).toBe(false);
    expect(pending.request.params.has('service')).toBe(false);

    pending.flush({ logs: [log()], total: 1, truncated: false });
    await settle();
  });

  it('puts the search on the endpoint and in the URL, and says what it matches', async () => {
    await open(`/logs?source=${ENCODED}`);
    shell();
    flushLogs();
    await settle();

    const field = page().querySelector('#log-search') as HTMLInputElement;
    field.value = 'erro';
    field.dispatchEvent(new Event('change'));
    await settle();

    expect(TestBed.inject(Router).url).toContain('q=erro');
    const request = logRead();
    expect(request.request.params.get('query')).toBe('erro');

    // Measured live: "erro" matched three records whose bodies never contain it, because the
    // service matches the severity text too. The placeholder claims that, so the claim is pinned
    // to the shape the service actually answered with.
    request.flush({
      logs: [
        log({ severityText: 'ERROR', severityNumber: 17, body: 'blob write failed: no' }),
        log({ severityText: 'ERROR', severityNumber: 17, body: 'blob write failed: no' }),
      ],
      total: 2,
      truncated: false,
    });
    await settle();

    expect(text()).toContain('blob write failed: no');
    expect(text()).toContain('and its severity text');
  });

  it('reads its lenses back out of a shared link rather than starting from defaults', async () => {
    await open(`/logs?source=${ENCODED}&q=blob&since=60&service=qits-artifacts`);
    shell();
    const pending = logRead();

    expect(pending.request.params.get('query')).toBe('blob');
    expect(pending.request.params.get('sinceMinutes')).toBe('60');
    expect(pending.request.params.get('service')).toBe('qits-artifacts');

    pending.flush({ logs: [log()], total: 1, truncated: false });
    await settle();
  });

  it('narrows to one service without spending a request on the service list', async () => {
    await open(`/logs?source=${ENCODED}`);
    shell();
    flushLogs();
    await settle();

    expect(text()).toContain('qits-artifacts');
    await click('qits-artifacts');

    expect(TestBed.inject(Router).url).toContain('service=qits-artifacts');
    const request = logRead();
    expect(request.request.params.get('service')).toBe('qits-artifacts');
    request.flush({ logs: [], total: 0, truncated: false });
    await settle();
  });

  it('follows on a five-second clock by default, and only while Follow is on', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    await open(`/logs?source=${ENCODED}`);
    shell();
    flushLogs();
    await settle();

    // On by default: a tail nobody asked to follow is just a list.
    expect(text()).toContain('Re-reading every 5 s');

    await vi.advanceTimersByTimeAsync(LOG_TAIL_FOLLOW_INTERVAL_MS);
    await settle();
    logRead().flush({ logs: [log()], total: 1, truncated: false });
    await settle();

    await click('Off');

    // With Follow off this screen makes no timed request at all — not slower, none. The band above
    // keeps its own ten-second cadence, which is why the store/sources pair still ticks.
    await vi.advanceTimersByTimeAsync(LOG_TAIL_FOLLOW_INTERVAL_MS * 6);
    await settle();
    expect(http.match((request) => request.url.endsWith('/telemetry/logs')).length).toBe(0);
    http
      .match((request) => !request.url.endsWith('/telemetry/logs'))
      .forEach((pending) =>
        pending.flush(pending.request.url.endsWith('/store') ? store() : { sources: [source()] }),
      );
    await settle();

    expect(text()).toContain('Not reading on a timer at all');
  });

  it('switches Follow off when the reader scrolls up, and leaves the rows where they are', async () => {
    await open(`/logs?source=${ENCODED}`);
    shell();
    flushLogs();
    await settle();

    expect(text()).toContain('Re-reading every 5 s');

    const element = rail(0);
    element.dispatchEvent(new Event('scroll'));
    await settle();

    // Scrolling up is how a person says "hold still". The toggle answers that and nothing else
    // moves.
    expect(text()).toContain('Not reading on a timer at all');
    expect(text()).toContain('writing blob 41ab to the store');
  });

  it('does not switch Follow off for a scroll that stays at the bottom', async () => {
    await open(`/logs?source=${ENCODED}`);
    shell();
    flushLogs();
    await settle();

    // 1000 - 700 - 300 = 0 from the bottom: this is the programmatic scroll following performs on
    // itself, and a toggle that turned itself off on its own scroll would never stay on.
    const element = rail(700);
    element.dispatchEvent(new Event('scroll'));
    await settle();

    expect(text()).toContain('Re-reading every 5 s');
  });

  it('scrolling back down does not switch Follow on again; the button does', async () => {
    await open(`/logs?source=${ENCODED}`);
    shell();
    flushLogs();
    await settle();

    const element = rail(0);
    element.dispatchEvent(new Event('scroll'));
    await settle();
    expect(text()).toContain('Not reading on a timer at all');

    rail(700).dispatchEvent(new Event('scroll'));
    await settle();
    // Coming to rest near the bottom while reading is not a request to be moved.
    expect(text()).toContain('Not reading on a timer at all');

    await click('On');
    expect(text()).toContain('Re-reading every 5 s');

    // And it starts the clock again, so put it back down before the harness goes away.
    await click('Off');
  });

  it('draws the newest record last, in the order the service holds them', async () => {
    await open(`/logs?source=${ENCODED}`);
    shell();
    flushLogs([
      log({ epochNanos: nanosAt(0), body: 'the older line' }),
      log({ epochNanos: nanosAt(5000), body: 'the newer line' }),
    ]);
    await settle();

    const bodies = Array.from(page().querySelectorAll('.record .body')).map((node) =>
      (node.textContent ?? '').trim(),
    );
    expect(bodies).toEqual(['the older line', 'the newer line']);
  });

  it('says a truncated tail kept the newest records, and names the eviction behind the total', async () => {
    await open(`/logs?source=${ENCODED}`);
    shell();
    flushLogs([log()], { total: 4820, truncated: true });
    await settle();

    // Measured: limit=2 over six records returned the newest two. A tail that kept the oldest
    // would stop updating while claiming to follow, and no row on screen would show it.
    expect(text()).toContain('Showing the newest 1 of 4,820 matching records.');
    expect(text()).toContain('812 older logs');
  });

  it('does not blame eviction for a truncation on a buffer that has evicted no logs', async () => {
    await open(`/logs?source=${ENCODED}`);
    shell([source()], store({ evictedLogs: 0 }));
    flushLogs([log()], { total: 4820, truncated: true });
    await settle();

    expect(text()).toContain('Showing the newest 1 of 4,820 matching records.');
    expect(text()).not.toContain('at its cap');
  });

  it('draws a record with no severity as no severity, and says so once below the tail', async () => {
    await open(`/logs?source=${ENCODED}`);
    shell();
    // Measured on the live service against a posted fixture: an OTLP record with no severity set
    // answers with 0 and an empty string. Filling that in would turn an omission into a claim.
    flushLogs([log({ severityNumber: 0, severityText: '', body: 'a line with no severity set' })]);
    await settle();

    // The chip itself, not the prose around it: an invented INFO here is invisible beside a real
    // one, which is the whole reason this case has a spec.
    const chips = Array.from(page().querySelectorAll('.record .sev')).map((node) =>
      (node.textContent ?? '').trim(),
    );
    expect(chips).toEqual(['no severity']);
    expect(text()).toContain('One record here carries no severity at all');
  });

  it('counts the unsevered records rather than saying "1 records"', async () => {
    await open(`/logs?source=${ENCODED}`);
    shell();
    flushLogs([
      log({ severityNumber: 0, severityText: '', body: 'one' }),
      log({ severityNumber: 0, severityText: '', body: 'two', epochNanos: nanosAt(1) }),
      log({ body: 'three', epochNanos: nanosAt(2) }),
    ]);
    await settle();

    expect(text()).toContain('2 records here carry no severity at all');
  });

  it('links a correlated record to its waterfall and draws no link where there is no trace id', async () => {
    await open(`/logs?source=${ENCODED}`);
    shell();
    flushLogs([
      log(),
      log({ traceId: '', spanId: '', body: 'written outside any span', epochNanos: nanosAt(1) }),
    ]);
    await settle();

    const links = Array.from(page().querySelectorAll('.record a')).map(
      (anchor) => anchor.getAttribute('href') ?? '',
    );
    expect(links.length).toBe(1);
    expect(links[0]).toContain('/traces/aa00bb11cc22dd33ee44ff5566778899');
    expect(links[0]).toContain(`source=${ENCODED}`);
  });

  it('names a window that excludes what the buffer holds', async () => {
    await open(`/logs?source=${ENCODED}&since=15`);
    shell();
    const pending = logRead();
    expect(pending.request.params.get('sinceMinutes')).toBe('15');
    pending.flush({ logs: [], total: 0, truncated: false });
    await settle();

    expect(text()).toContain('No records in the last 15 minutes');
    expect(text()).toContain('clear the window to see them');
  });

  it('says what a search matched nothing means, including what it cannot match', async () => {
    await open(`/logs?source=${ENCODED}&q=qits-fixture`);
    shell();
    flushLogs([]);
    await settle();

    expect(text()).toContain('Nothing in qits-fixture matches');
    // The surprise runs both ways, and the empty state says the second half too.
    expect(text()).toContain('a service name, a trace id or an attribute will not match');
  });

  it('tells "this source logs nothing" apart from "this source has received nothing"', async () => {
    await open(`/logs?source=${ENCODED}`);
    shell([source({ logs: 0, spans: 12 })]);
    flushLogs([]);
    await settle();

    expect(text()).toContain('No logs have arrived from qits-fixture');
    expect(text()).toContain('It has exported 12 spans, so it is reporting');
  });

  it('blames a fresh restart for an empty tail, when there was one', async () => {
    await open(`/logs?source=${ENCODED}`);
    shell([source({ logs: 4 })], store({ startedAt: new Date(Date.now() - 60_000).toISOString() }));
    flushLogs([]);
    await settle();

    expect(text()).toContain('when qits-observability restarted');
  });

  it('names a service filter that matches no reporting service', async () => {
    await open(`/logs?source=${ENCODED}&service=qits-nope`);
    shell();
    flushLogs([]);
    await settle();

    expect(text()).toContain('No service called qits-nope has reported into qits-fixture');
  });

  it('keeps the last good tail on screen when a refresh fails, and says it is stale', async () => {
    await open(`/logs?source=${ENCODED}`);
    shell();
    flushLogs();
    await settle();

    await click('Refresh');
    logRead().flush({ message: 'boom' }, { status: 503, statusText: 'Service Unavailable' });
    await settle();

    expect(text()).toContain('writing blob 41ab to the store');
    expect(text()).toContain('The last refresh failed');
  });
});
