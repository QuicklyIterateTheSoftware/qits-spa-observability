import type { TelemetryLogDto, TelemetrySpanDto } from '../api/dto';
import { EMPTY_WATERFALL, formatDuration, layOutTrace } from './trace-layout';

/**
 * The waterfall's rules, asserted on the function rather than through the DOM.
 *
 * Every case here is a shape the live buffer actually produces — a client span whose server parent
 * sits in another source's bucket, a span the service reported as `0` ms, a trace whose root was
 * evicted — and every one of them fails silently on screen: a re-parented orphan draws a perfectly
 * plausible tree, and a sub-millisecond span with an honest 0% width draws nothing at all. A pure
 * function is what lets a spec put the shape in and read the decision out.
 */
describe('layOutTrace', () => {
  const NANOS = 1_000_000;
  const START = 1_785_592_193_983_999_744;

  const span = (over: Partial<TelemetrySpanDto> = {}): TelemetrySpanDto => ({
    traceId: 'aa00bb11',
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
    /* Carried because every record on the wire carries it. The layout is geometry and reads none of
       it — which build a span came from is the detail pane's business, not a bar's. */
    resourceAttributes: { 'service.version': '2026.802.164102' },
    events: [],
    ...over,
  });

  const log = (over: Partial<TelemetryLogDto> = {}): TelemetryLogDto => ({
    epochNanos: START,
    severityNumber: 9,
    severityText: 'INFO',
    body: 'writing blob 41ab to the store',
    traceId: 'aa00bb11',
    spanId: '2222222222222222',
    serviceName: 'qits-fixture',
    attributes: {},
    resourceAttributes: { 'service.version': '2026.802.164102' },
    ...over,
  });

  /** The trace the fixture posts to the live service: a root, two children, and an orphan. */
  function measuredTrace(): readonly TelemetrySpanDto[] {
    return [
      span(),
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
        events: [
          {
            name: 'exception',
            epochNanos: START + 799 * NANOS,
            exception: true,
            attributes: {
              'exception.type': 'java.lang.IllegalStateException',
              'exception.stacktrace': 'java.lang.IllegalStateException: the blob store said no',
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

  it('nests by parentSpanId and orders siblings by when they started', () => {
    const layout = layOutTrace(measuredTrace());
    const names = layout.rows.map((row) => `${'  '.repeat(row.depth)}${row.span.name}`);

    // The root, then its children in start order, then the orphan at the top level.
    expect(names).toEqual([
      'POST /fixture/uploads',
      '  cache lookup',
      '  BlobStore.put',
      'GET /fixture/blob',
    ]);
  });

  it('draws a span whose parent is not buffered at the top level, and never re-parents it', () => {
    const layout = layOutTrace(measuredTrace());
    const orphan = layout.rows.find((row) => row.span.spanId === '4444444444444444');

    expect(orphan?.depth).toBe(0);
    expect(orphan?.parentMissing).toBe(true);
    // The named parent stays on the span. Inventing one would draw a plausible, wrong tree.
    expect(orphan?.span.parentSpanId).toBe('9999999999999999');

    // And the real children are not flagged: the marker means something or it means nothing.
    const child = layout.rows.find((row) => row.span.spanId === '2222222222222222');
    expect(child?.parentMissing).toBe(false);
    expect(child?.depth).toBe(1);
  });

  it('keeps a sub-millisecond span in the list with an honest zero width', () => {
    const layout = layOutTrace(measuredTrace());
    const tiny = layout.rows.find((row) => row.span.name === 'cache lookup');

    // The service reported 0 ms, so the geometry says 0% — the CSS floor is what makes it visible,
    // rather than a lie about the proportion.
    expect(tiny?.span.durationMs).toBe(0);
    expect(tiny?.widthPercent).toBe(0);
    expect(formatDuration(0)).toBe('<1 ms');
  });

  it('places bars as percentages of the trace’s own window', () => {
    const layout = layOutTrace(measuredTrace());
    expect(layout.windowMs).toBeCloseTo(812, 3);

    const root = layout.rows[0];
    expect(root.leftPercent).toBe(0);
    expect(root.widthPercent).toBeCloseTo(100, 6);

    const child = layout.rows.find((row) => row.span.spanId === '2222222222222222')!;
    expect(child.leftPercent).toBeCloseTo((4 / 812) * 100, 6);
    expect(child.widthPercent).toBeCloseTo((796 / 812) * 100, 6);
  });

  it('never lets a bar run past the right edge of its track', () => {
    // A child that outlives its parent is possible when the parent's own span was clipped.
    const layout = layOutTrace([
      span({ durationMs: 10 }),
      span({
        spanId: '2222222222222222',
        parentSpanId: '1111111111111111',
        startEpochNanos: START + 9 * NANOS,
        durationMs: 1,
      }),
    ]);

    for (const row of layout.rows) {
      expect(row.leftPercent).toBeGreaterThanOrEqual(0);
      expect(row.leftPercent + row.widthPercent).toBeLessThanOrEqual(100.000001);
    }
  });

  it('flags a trace with no root span, rather than presenting the earliest as one', () => {
    const withoutRoot = measuredTrace().filter((one) => one.parentSpanId !== '');
    const layout = layOutTrace(withoutRoot);

    expect(layout.rootMissing).toBe(true);
    // Every survivor is drawn, all of them at the top level, all of them marked.
    expect(layout.rows).toHaveLength(3);
    expect(layout.rows.every((row) => row.parentMissing)).toBe(true);
  });

  it('does not flag rootMissing when a root is buffered, even beside an orphan', () => {
    const layout = layOutTrace(measuredTrace());
    expect(layout.rootMissing).toBe(false);
    // The two conditions are independent, and the live buffer produces exactly this combination.
    expect(layout.rows.some((row) => row.parentMissing)).toBe(true);
  });

  it('lays out a single-span trace without dividing by zero', () => {
    const layout = layOutTrace([span({ durationMs: 0, events: [] })]);

    expect(layout.rows).toHaveLength(1);
    expect(layout.windowMs).toBe(0);
    expect(layout.rows[0].leftPercent).toBe(0);
    expect(layout.rows[0].widthPercent).toBe(0);
    expect(layout.rootMissing).toBe(false);
  });

  it('gives a single-span trace with a real duration a full-width bar', () => {
    const layout = layOutTrace([span({ durationMs: 42 })]);

    expect(layout.windowMs).toBeCloseTo(42, 3);
    // Not exactly 100: the window is measured from nanosecond stamps that lost their low bits in
    // JSON, so it is 42.000128 ms and the bar is 99.9997% of it. See the precision spec below.
    expect(layout.rows[0].widthPercent).toBeCloseTo(100, 2);
  });

  it('absorbs the precision a nanosecond epoch loses in a JSON number', () => {
    // A real stamp from this service is a 61-bit figure and JSON hands it to a double, so the low
    // bits are gone before this code ever sees it: 42 ms of nanos measures back as 42.000128 ms.
    // That is 128 ns of error on a bar drawn in milliseconds, and it is recorded here rather than
    // defended against — but a spec asserting exact equality would fail on the real data, which is
    // how this got written down in the first place.
    expect(Number.isSafeInteger(START)).toBe(false);
    const layout = layOutTrace([span({ durationMs: 42 })]);
    expect(Math.abs(layout.windowMs - 42)).toBeLessThan(0.001);
  });

  it('draws every buffered span even when the parents form a cycle', () => {
    // Nothing here is reachable from a root. Dropping these would hide records the buffer holds,
    // which is the one failure on this screen that nobody could see.
    const layout = layOutTrace([
      span({ spanId: 'aaaa', parentSpanId: 'bbbb', name: 'A' }),
      span({ spanId: 'bbbb', parentSpanId: 'aaaa', name: 'B' }),
    ]);

    expect(layout.rows.map((row) => row.span.name).sort()).toEqual(['A', 'B']);
    expect(layout.rows.every((row) => row.parentMissing)).toBe(true);
  });

  it('treats a span that names itself as its own parent as top level', () => {
    const layout = layOutTrace([span({ spanId: 'aaaa', parentSpanId: 'aaaa' })]);

    expect(layout.rows).toHaveLength(1);
    expect(layout.rows[0].depth).toBe(0);
    expect(layout.rows[0].parentMissing).toBe(true);
  });

  it('reads the exception flag from the service rather than from the event name', () => {
    const layout = layOutTrace(measuredTrace());
    const failing = layout.rows.find((row) => row.span.spanId === '2222222222222222');

    expect(failing?.hasException).toBe(true);
    expect(failing?.isError).toBe(true);
    expect(layout.errorCount).toBe(1);
  });

  it('counts the logs that name each span, and ignores the ones that name none', () => {
    const layout = layOutTrace(measuredTrace(), [
      log(),
      log({ severityNumber: 17, severityText: 'ERROR' }),
      log({ spanId: '' }),
    ]);

    const failing = layout.rows.find((row) => row.span.spanId === '2222222222222222');
    expect(failing?.logCount).toBe(2);
    expect(layout.rows.find((row) => row.span.name === 'cache lookup')?.logCount).toBe(0);
  });

  it('lists the services in the order they first appear', () => {
    const layout = layOutTrace([
      span({ serviceName: 'qits-gateway' }),
      span({ spanId: '2222', parentSpanId: '1111111111111111', serviceName: 'qits-artifacts' }),
      span({ spanId: '3333', parentSpanId: '1111111111111111', serviceName: 'qits-gateway' }),
    ]);

    expect(layout.services).toEqual(['qits-gateway', 'qits-artifacts']);
  });

  it('answers the empty layout for a trace with no spans', () => {
    expect(layOutTrace([])).toBe(EMPTY_WATERFALL);
  });

  it('says <1 ms for a zero, and never a bare 0 ms', () => {
    expect(formatDuration(0)).toBe('<1 ms');
    expect(formatDuration(1)).toBe('1 ms');
    expect(formatDuration(812)).toBe('812 ms');
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(65_000)).toBe('65.0 s');
  });
});
