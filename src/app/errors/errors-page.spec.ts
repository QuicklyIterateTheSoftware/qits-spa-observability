import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type {
  StoreStateDto,
  TelemetryErrorGroupDto,
  TelemetryLogDto,
  TelemetrySourceDto,
  TelemetrySpanDto,
} from '../api/dto';
import { routes } from '../app.routes';

/**
 * The errors screen, driven through `HttpTestingController`.
 *
 * **The budget is the first assertion and its negative half is the one that matters.** The page
 * costs the shell's two plus exactly one, and the shell's two plus *nothing* when no source is
 * named — because a sourceless read answers `200` with an empty list, which this screen would draw
 * as "no errors". That is the most reassuring possible way to be wrong, and it is invisible.
 *
 * The rest is what a bounded buffer forces an error list to say out loud: which lens reached the
 * service, that the uncorrelated group is drawn as evidence rather than as a trace, that truncation
 * is stated with both numbers in it, and that an empty list gives a different reason for every
 * different reason — including the one where an empty list is simply good news.
 */
describe('ErrorsPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;

  const SOURCE = '_service/qits-fixture';
  const ENCODED = '_service%2Fqits-fixture';

  /* Built rather than typed: a real nanosecond epoch is a 61-bit figure and the linter rejects the
     literal outright — the same fact the waterfall's layout records. */
  const START_NANOS = Date.UTC(2026, 7, 1, 13, 48, 13) * 1_000_000;

  const store = (over: Partial<StoreStateDto> = {}): StoreStateDto => ({
    startedAt: new Date(Date.now() - 6 * 3600_000).toISOString(),
    totalBytes: 6535512,
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

  const span = (over: Partial<TelemetrySpanDto> = {}): TelemetrySpanDto => ({
    traceId: 'bb11cc22dd33ee44ff556677889900aa',
    spanId: '2222222222222222',
    parentSpanId: '1111111111111111',
    serviceName: 'qits-fixture',
    scopeName: 'fixture',
    name: 'BlobStore.put',
    kind: 'INTERNAL',
    startEpochNanos: START_NANOS,
    durationMs: 796,
    status: 'ERROR',
    statusMessage: 'the blob store said no',
    attributes: {},
    events: [
      {
        name: 'exception',
        epochNanos: START_NANOS,
        attributes: {
          'exception.type': 'java.lang.IllegalStateException',
          'exception.message': 'the blob store said no',
          'exception.stacktrace': 'java.lang.IllegalStateException: the blob store said no\n\tat X',
        },
        exception: true,
      },
    ],
    ...over,
  });

  const log = (over: Partial<TelemetryLogDto> = {}): TelemetryLogDto => ({
    epochNanos: START_NANOS,
    severityNumber: 17,
    severityText: 'ERROR',
    body: 'blob write failed: the blob store said no',
    traceId: 'bb11cc22dd33ee44ff556677889900aa',
    spanId: '2222222222222222',
    serviceName: 'qits-fixture',
    attributes: {},
    ...over,
  });

  const group = (over: Partial<TelemetryErrorGroupDto> = {}): TelemetryErrorGroupDto => ({
    traceId: 'bb11cc22dd33ee44ff556677889900aa',
    serviceName: 'qits-fixture',
    errorSpans: [span()],
    errorLogs: [log()],
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

  /** The screen's one read, matched by path so the query is asserted separately. */
  function errorRead() {
    return http.expectOne((request) => request.url === '/observability/api/telemetry/errors');
  }

  function flushGroups(
    groups: readonly TelemetryErrorGroupDto[] = [group()],
    envelope: { total?: number; truncated?: boolean } = {},
  ): void {
    errorRead().flush({
      groups,
      total: envelope.total ?? groups.length,
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
    await open(`/errors?source=${ENCODED}`);
    const requests = http.match(() => true);

    expect(requests.map((request) => request.request.url)).toEqual([
      '/observability/api/telemetry/store',
      '/observability/api/telemetry/sources',
      '/observability/api/telemetry/errors',
    ]);

    requests[0].flush(store());
    requests[1].flush({ sources: [source()] });
    requests[2].flush({ groups: [group()], total: 1, truncated: false });
    await settle();

    expect(text()).toContain('java.lang.IllegalStateException: the blob store said no');
    http.verify();
  });

  it('costs nothing beyond the shell when no source is named', async () => {
    await open('/errors');
    const requests = http.match(() => true);

    // A sourceless read answers 200 with an empty list, which this screen would draw as "no
    // errors". Saying that about a bucket nobody chose is the worst thing this page can do quietly.
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

  it('sends the source and the limit it is allowed to send, and no window by default', async () => {
    await open(`/errors?source=${ENCODED}`);
    shell();
    const pending = errorRead();

    expect(pending.request.params.get('source')).toBe(SOURCE);
    // The service answers 400 outside 1..1000 rather than clamping, so this is never taken from a
    // URL or a field — it is the constant.
    expect(pending.request.params.get('limit')).toBe('200');
    // "Everything still buffered" is an absent parameter, not a large number.
    expect(pending.request.params.has('sinceMinutes')).toBe(false);
    expect(pending.request.params.has('service')).toBe(false);

    pending.flush({ groups: [group()], total: 1, truncated: false });
    await settle();
  });

  it('puts the window on the endpoint and carries it in the URL', async () => {
    await open(`/errors?source=${ENCODED}`);
    shell();
    flushGroups();
    await settle();

    await click('15 minutes');

    expect(TestBed.inject(Router).url).toContain('since=15');
    const request = errorRead();
    expect(request.request.params.get('sinceMinutes')).toBe('15');
    request.flush({ groups: [], total: 0, truncated: false });
    await settle();

    // §5's window row: the reader is told what the buffer holds, not merely that the answer is
    // empty.
    expect(text()).toContain('No errors in the last 15 minutes');
    expect(text()).toContain('clear the window to see them');
  });

  it('narrows to one service without spending a request on the service list', async () => {
    await open(`/errors?source=${ENCODED}`);
    shell();
    flushGroups();
    await settle();

    // The chips came from the source row the band already holds.
    expect(text()).toContain('qits-artifacts');

    await click('qits-artifacts');

    expect(TestBed.inject(Router).url).toContain('service=qits-artifacts');
    const request = errorRead();
    expect(request.request.params.get('service')).toBe('qits-artifacts');
    request.flush({ groups: [group()], total: 1, truncated: false });
    await settle();
  });

  it('reads its lenses back out of a shared link rather than starting from defaults', async () => {
    await open(`/errors?source=${ENCODED}&since=60&service=qits-artifacts`);
    shell();
    const pending = errorRead();

    expect(pending.request.params.get('sinceMinutes')).toBe('60');
    expect(pending.request.params.get('service')).toBe('qits-artifacts');

    pending.flush({ groups: [group()], total: 1, truncated: false });
    await settle();
  });

  it('links a correlated group to the waterfall, carrying the source with it', async () => {
    await open(`/errors?source=${ENCODED}`);
    shell();
    flushGroups();
    await settle();

    const link = Array.from(page().querySelectorAll('a')).find((anchor) =>
      (anchor.getAttribute('href') ?? '').includes('/traces/bb11cc22'),
    );
    expect(link?.getAttribute('href')).toContain(`source=${ENCODED}`);
  });

  it('draws the uncorrelated group as evidence, with no link to a trace that is not there', async () => {
    await open(`/errors?source=${ENCODED}`);
    shell();
    flushGroups([
      {
        traceId: '',
        serviceName: 'qits-fixture',
        errorSpans: [],
        errorLogs: [log({ traceId: '', spanId: '', body: 'manifest rejected: no digest' })],
      },
    ]);
    await settle();

    expect(text()).toContain('Not correlated to a trace');
    expect(text()).toContain('manifest rejected: no digest');
    // Nothing on this card may point at /traces/ — there is nothing at the other end.
    const links = Array.from(page().querySelectorAll('a')).map(
      (anchor) => anchor.getAttribute('href') ?? '',
    );
    expect(links.some((href) => href.includes('/traces/'))).toBe(false);
  });

  it('expands a group without spending a request, because its members came with it', async () => {
    await open(`/errors?source=${ENCODED}`);
    shell();
    flushGroups();
    await settle();

    expect(text()).not.toContain('Error spans');

    const disclosure = page().querySelector('button.disclosure') as HTMLButtonElement;
    disclosure.click();
    await settle();

    expect(text()).toContain('Error spans');
    expect(text()).toContain('BlobStore.put');
    expect(text()).toContain('Error logs');
    expect(text()).toContain('blob write failed');
    // The stack trace is rendered verbatim where there is one.
    expect(text()).toContain('java.lang.IllegalStateException: the blob store said no');
    // And none of that cost anything: the only outstanding request is nothing at all.
    http.verify();
  });

  it('states a truncation with both numbers, and names the eviction behind the total', async () => {
    await open(`/errors?source=${ENCODED}`);
    shell();
    flushGroups([group()], { total: 340, truncated: true });
    await settle();

    expect(text()).toContain('Showing 1 of 340 groups.');
    expect(text()).toContain('41,233 spans');
  });

  it('does not blame eviction for a truncation on a buffer that has evicted nothing', async () => {
    await open(`/errors?source=${ENCODED}`);
    shell([source()], store({ evictedSpans: 0, evictedLogs: 0 }));
    flushGroups([group()], { total: 340, truncated: true });
    await settle();

    expect(text()).toContain('Showing 1 of 340 groups.');
    expect(text()).not.toContain('at its cap');
  });

  it('says nothing about truncation when the answer is whole', async () => {
    await open(`/errors?source=${ENCODED}`);
    shell();
    flushGroups();
    await settle();

    expect(text()).not.toContain('Showing');
  });

  it('reads an empty list as good news rather than as a failure to load', async () => {
    await open(`/errors?source=${ENCODED}`);
    shell();
    flushGroups([]);
    await settle();

    expect(text()).toContain('No errors are buffered for qits-fixture');
    expect(text()).toContain('on a service that is working is the answer to expect');
  });

  it('blames a fresh restart for an empty list, when there was one', async () => {
    await open(`/errors?source=${ENCODED}`);
    shell([source()], store({ startedAt: new Date(Date.now() - 60_000).toISOString() }));
    flushGroups([]);
    await settle();

    expect(text()).toContain('when qits-observability restarted');
  });

  it('tells "this source has received nothing" apart from "nothing here failed"', async () => {
    await open(`/errors?source=${ENCODED}`);
    shell([source({ spans: 0, logs: 0, services: [] })]);
    flushGroups([]);
    await settle();

    expect(text()).toContain('Nothing has arrived from qits-fixture');
  });

  it('names a service filter that matches no reporting service', async () => {
    await open(`/errors?source=${ENCODED}&service=qits-nope`);
    shell();
    flushGroups([]);
    await settle();

    expect(text()).toContain('No service called qits-nope has reported into qits-fixture');
  });

  it('keeps the last good list on screen when a refresh fails, and says it is stale', async () => {
    await open(`/errors?source=${ENCODED}`);
    shell();
    flushGroups();
    await settle();

    await click('Refresh');
    errorRead().flush({ message: 'boom' }, { status: 503, statusText: 'Service Unavailable' });
    await settle();

    // A failed *first* read is an error state; this is a failed re-read, and data you know is
    // forty seconds old beats an empty page.
    expect(text()).toContain('java.lang.IllegalStateException');
    expect(text()).toContain('The last refresh failed');
  });
});
