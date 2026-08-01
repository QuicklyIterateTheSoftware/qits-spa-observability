import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type {
  StoreStateDto,
  TelemetryLogDto,
  TelemetrySpanDto,
  TelemetrySourceDto,
} from '../api/dto';
import { routes } from '../app.routes';

/**
 * The waterfall, driven through `HttpTestingController`.
 *
 * **Budget: the shell's two plus one, and the one is read once.** The negative here is not "no
 * second endpoint" but "no timer": a trace is a finished thing, so this screen must not poll, and a
 * poll added later would be invisible on screen and would cost a request every ten seconds per open
 * tab. The fake-timer spec below is the only thing that would notice.
 *
 * The rest is the shapes the live buffer actually produces, every one of which draws something
 * plausible and wrong if it is handled carelessly: a span whose parent is not buffered, a trace
 * with no root at all, a sub-millisecond span, and an id that answers `200` with nothing for two
 * different reasons.
 */
describe('TracePage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;

  const SOURCE = '_service/qits-fixture';
  const ENCODED = '_service%2Fqits-fixture';
  const TRACE_ID = 'aa00bb11cc22dd33ee44ff5566778899';
  const NANOS = 1_000_000;
  const START = 1_785_592_193_983_999_744;

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

  const source = (): TelemetrySourceDto => ({
    key: SOURCE,
    kind: 'SERVICE',
    label: 'qits-fixture',
    repositoryId: null,
    workspaceId: null,
    services: [{ name: 'qits-fixture', spans: 4, logs: 2, metricSeries: 0 }],
    spans: 4,
    logs: 2,
    metricSeries: 0,
    bytes: 8192,
    oldestReceivedAt: new Date(Date.now() - 3600_000).toISOString(),
    newestReceivedAt: new Date(Date.now() - 120_000).toISOString(),
  });

  const span = (over: Partial<TelemetrySpanDto> = {}): TelemetrySpanDto => ({
    traceId: TRACE_ID,
    spanId: '1111111111111111',
    parentSpanId: '',
    serviceName: 'qits-fixture',
    scopeName: 'cj-fixture',
    name: 'POST /fixture/uploads',
    kind: 'SERVER',
    startEpochNanos: START,
    durationMs: 812,
    status: 'UNSET',
    statusMessage: '',
    attributes: {},
    events: [],
    ...over,
  });

  const STACK =
    'java.lang.IllegalStateException: the blob store said no\n' +
    '\tat eu.wohlben.qits.artifacts.control.BlobStore.put(BlobStore.java:118)\n' +
    '\tat java.base/java.lang.Thread.run(Thread.java:1583)';

  /** The trace the fixture posts to the live service, as it answers it back. */
  function spans(): TelemetrySpanDto[] {
    return [
      span({
        attributes: { 'http.request.method': 'POST', 'http.response.status_code': '500' },
        status: 'ERROR',
        statusMessage: 'the blob store said no',
      }),
      span({
        spanId: '3333333333333333',
        parentSpanId: '1111111111111111',
        name: 'cache lookup',
        kind: 'INTERNAL',
        startEpochNanos: START + 1 * NANOS,
        durationMs: 0,
      }),
      span({
        spanId: '2222222222222222',
        parentSpanId: '1111111111111111',
        name: 'BlobStore.put',
        kind: 'INTERNAL',
        startEpochNanos: START + 4 * NANOS,
        durationMs: 796,
        status: 'ERROR',
        statusMessage: 'the blob store said no',
        attributes: { 'db.system': 'h2' },
        events: [
          {
            name: 'exception',
            epochNanos: START + 799 * NANOS,
            exception: true,
            attributes: {
              'exception.type': 'java.lang.IllegalStateException',
              'exception.message': 'the blob store said no',
              'exception.stacktrace': STACK,
            },
          },
        ],
      }),
      span({
        spanId: '4444444444444444',
        parentSpanId: '9999999999999999',
        name: 'GET /fixture/blob',
        kind: 'CLIENT',
        startEpochNanos: START + 10 * NANOS,
        durationMs: 30,
      }),
    ];
  }

  const log = (over: Partial<TelemetryLogDto> = {}): TelemetryLogDto => ({
    epochNanos: START + 700 * NANOS,
    severityNumber: 9,
    severityText: 'INFO',
    body: 'writing blob 41ab to the store',
    traceId: TRACE_ID,
    spanId: '2222222222222222',
    serviceName: 'qits-fixture',
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

  afterEach(() => http.verify());

  async function open(url = `/traces/${TRACE_ID}?source=${ENCODED}`): Promise<void> {
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

  function shell(state: StoreStateDto = store()): void {
    http.expectOne('/observability/api/telemetry/store').flush(state);
    http.expectOne('/observability/api/telemetry/sources').flush({ sources: [source()] });
  }

  function traceRead() {
    return http.expectOne(
      (request) => request.url === `/observability/api/telemetry/traces/${TRACE_ID}`,
    );
  }

  async function load(
    detailSpans: TelemetrySpanDto[] = spans(),
    logs: TelemetryLogDto[] = [],
    state: StoreStateDto = store(),
  ): Promise<void> {
    await open();
    shell(state);
    traceRead().flush({ trace: { traceId: TRACE_ID, spans: detailSpans, logs } });
    await settle();
  }

  function bars(): HTMLElement[] {
    return Array.from(page().querySelectorAll('.bar'));
  }

  function rowLabels(): string[] {
    return Array.from(page().querySelectorAll('.waterfall .name')).map((node) =>
      (node.textContent ?? '').trim(),
    );
  }

  it('costs the shell’s two plus exactly one, and puts the id in the path', async () => {
    await open();
    const requests = http.match(() => true);

    expect(requests.map((request) => request.request.url)).toEqual([
      '/observability/api/telemetry/store',
      '/observability/api/telemetry/sources',
      `/observability/api/telemetry/traces/${TRACE_ID}`,
    ]);
    // The spans and the correlated logs arrive in one answer, so the rail below costs nothing.
    expect(requests[2].request.params.get('source')).toBe(SOURCE);

    requests[0].flush(store());
    requests[1].flush({ sources: [source()] });
    requests[2].flush({ trace: { traceId: TRACE_ID, spans: spans(), logs: [log()] } });
    await settle();

    expect(text()).toContain('BlobStore.put');
    http.verify();
  });

  it('does not poll: a trace is a finished thing', async () => {
    // Only `setInterval` is faked. Angular's zoneless scheduler races a `setTimeout` against a
    // `requestAnimationFrame`, so faking those would freeze the harness itself — the same reason
    // the buffer's own spec fakes exactly these two.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await load();

      // Well past the ten-second cadence every other screen in this app runs on.
      vi.advanceTimersByTime(120_000);
      await settle();

      // Nothing re-reads the trace. A timer added here would be invisible on screen and would
      // cost a request every ten seconds for every open tab, to receive the same body.
      http.expectNone(
        (request) => request.url === `/observability/api/telemetry/traces/${TRACE_ID}`,
      );

      // The band above it *did* keep polling, and should have: the buffer around this trace goes
      // on changing even though the trace itself is finished. That is the whole distinction this
      // screen makes, so both halves of it are asserted rather than only the quiet one.
      const banded = http.match(() => true).map((request) => request.request.url);
      expect(banded).toContain('/observability/api/telemetry/store');
      expect(banded).toContain('/observability/api/telemetry/sources');
    } finally {
      vi.useRealTimers();
    }
  });

  it('costs nothing beyond the shell when no source is named', async () => {
    await open(`/traces/${TRACE_ID}`);
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

  it('nests the waterfall by parentSpanId', async () => {
    await load();

    expect(rowLabels()).toEqual([
      'POST /fixture/uploads',
      'cache lookup',
      'BlobStore.put',
      'GET /fixture/blob',
    ]);
    // Depth is an indent, and the indent is a real one.
    const label = page().querySelectorAll('.waterfall .span-label')[2] as HTMLElement;
    expect(label.style.paddingLeft).toBe('0.9rem');
  });

  it('draws a span whose parent is not buffered at the top level, and says so', async () => {
    await load();

    expect(text()).toContain('(parent not buffered)');
    const orphanLabel = page().querySelectorAll('.waterfall .span-label')[3] as HTMLElement;
    expect(orphanLabel.style.paddingLeft).toBe('0rem');
    expect(text()).toContain('never re-parented');
  });

  it('gives a sub-millisecond span a visible bar and tells the truth in the label', async () => {
    await load();

    const tiny = bars()[1];
    // The percentage stays honest at 0; the CSS floor is what keeps the row visible.
    expect(tiny.style.width).toBe('0%');
    expect(text()).toContain('<1 ms');
  });

  it('draws bars as percentages of the trace’s own window', async () => {
    await load();

    const root = bars()[0];
    expect(root.style.left).toBe('0%');
    expect(parseFloat(root.style.width)).toBeCloseTo(100, 2);

    const child = bars()[2];
    expect(parseFloat(child.style.left)).toBeCloseTo((4 / 812) * 100, 2);
    expect(parseFloat(child.style.width)).toBeCloseTo((796 / 812) * 100, 2);
  });

  it('flags a trace whose root is not buffered rather than promoting the earliest span', async () => {
    await load(spans().filter((one) => one.parentSpanId !== ''));

    expect(text()).toContain('The root of this trace is not buffered.');
    expect(text()).toContain('earliest span that survived');
  });

  it('does not flag rootMissing when a root is buffered, even beside an orphan', async () => {
    await load();

    expect(text()).not.toContain('The root of this trace is not buffered.');
    expect(text()).toContain('(parent not buffered)');
  });

  it('renders a single-span trace without collapsing', async () => {
    await load([span()]);

    expect(rowLabels()).toEqual(['POST /fixture/uploads']);
    expect(text()).not.toContain('(parent not buffered)');
    expect(text()).not.toContain('The root of this trace is not buffered.');
  });

  it('renders a single orphan span at the top level with the marker', async () => {
    await load([span({ parentSpanId: '9999999999999999' })]);

    expect(rowLabels()).toEqual(['POST /fixture/uploads']);
    expect(text()).toContain('(parent not buffered)');
    expect(text()).toContain('The root of this trace is not buffered.');
  });

  it('renders the stack trace of an exception event verbatim', async () => {
    await load();

    // The failing span is not the first row, so this also proves selection reaches the pane.
    const target = Array.from(page().querySelectorAll('.waterfall button')).find((button) =>
      (button.textContent ?? '').includes('BlobStore.put'),
    ) as HTMLButtonElement;
    target.click();
    await settle();

    const block = page().querySelector('.stacktrace');
    expect(block?.textContent).toContain('java.lang.IllegalStateException: the blob store said no');
    expect(block?.textContent).toContain('BlobStore.java:118');
    expect(text()).toContain('the blob store said no');
  });

  it('reads the exception flag from the service rather than from the event name', async () => {
    const withRenamedEvent = spans().map((one) =>
      one.spanId === '2222222222222222'
        ? {
            ...one,
            events: [
              {
                name: 'something-else',
                epochNanos: START,
                exception: true,
                attributes: { 'exception.stacktrace': STACK },
              },
            ],
          }
        : one,
    );
    await load(withRenamedEvent);

    const target = Array.from(page().querySelectorAll('.waterfall button')).find((button) =>
      (button.textContent ?? '').includes('BlobStore.put'),
    ) as HTMLButtonElement;
    target.click();
    await settle();

    expect(page().querySelector('.stacktrace')).toBeTruthy();
  });

  it('shows the selected span’s attributes', async () => {
    await load();

    expect(text()).toContain('http.request.method');
    expect(text()).toContain('http.response.status_code');
  });

  it('renders the correlated logs in time order, anchored to their spans', async () => {
    await load(spans(), [
      log({
        epochNanos: START + 799 * NANOS,
        severityNumber: 17,
        severityText: 'ERROR',
        body: 'blob write failed',
      }),
      log(),
    ]);

    const rail = Array.from(page().querySelectorAll('.log-rail li')).map(
      (node) => node.textContent ?? '',
    );
    expect(rail).toHaveLength(2);
    expect(rail[0]).toContain('writing blob 41ab');
    expect(rail[1]).toContain('blob write failed');
    // Anchored by name, so the rail reads without cross-referencing span ids.
    expect(rail[0]).toContain('in BlobStore.put');
    expect(rail[0]).toContain('+700 ms');
  });

  it('says a log’s own span is not buffered rather than anchoring it to the wrong one', async () => {
    await load(spans(), [log({ spanId: 'ffffffffffffffff' })]);

    expect(text()).toContain('(its span is not buffered)');
  });

  it('names both explanations for an empty trace while the buffer has evicted something', async () => {
    await load([], []);

    expect(text()).toContain('No spans are buffered for this trace.');
    expect(text()).toContain('It may have been evicted');
    expect(text()).toContain('41,233');
    expect(text()).toContain('will not guess between them');
  });

  it('does not offer eviction as an explanation on a buffer that has evicted nothing', async () => {
    await load([], [], store({ evictedSpans: 0 }));

    expect(text()).toContain('No spans are buffered for this trace.');
    expect(text()).not.toContain('It may have been evicted');
    expect(text()).toContain('the id is the likelier');
  });

  it('re-reads when the id changes, because the component is reused between traces', async () => {
    await load();

    await harness.navigateByUrl(`/traces/beef0000?source=${ENCODED}`);
    const second = http.expectOne(
      (request) => request.url === '/observability/api/telemetry/traces/beef0000',
    );
    second.flush({ trace: { traceId: 'beef0000', spans: [span({ name: 'other' })], logs: [] } });
    await settle();

    expect(rowLabels()).toEqual(['other']);
  });
});
