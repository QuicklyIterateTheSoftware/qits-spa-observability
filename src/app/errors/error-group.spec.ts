import type { SpanEventDto, TelemetryErrorGroupDto, TelemetryLogDto } from '../api/dto';
import { viewErrorGroup, viewErrorGroups } from './error-group';

/**
 * What a group says about itself, asserted on the function rather than through a card.
 *
 * The shapes here were measured live against the deployed service, one of them by posting an OTLP
 * body the platform's own services cannot produce: **an ERROR log with no trace id groups under an
 * empty trace id with no spans at all**. That group is the one card on this screen that must not
 * link anywhere, and it is also the one a headline drawn from `errorSpans[0]` would leave blank.
 */
describe('error groups', () => {
  /* Built rather than typed: a real nanosecond epoch is a 61-bit figure and `no-loss-of-precision`
     rejects the literal outright. */
  const START_MILLIS = Date.UTC(2026, 7, 1, 13, 48, 13);
  const START_NANOS = START_MILLIS * 1_000_000;

  const exception = (over: Partial<SpanEventDto> = {}): SpanEventDto => ({
    name: 'exception',
    epochNanos: START_NANOS,
    attributes: {
      'exception.type': 'java.lang.IllegalStateException',
      'exception.message': 'the blob store said no',
      'exception.stacktrace': 'java.lang.IllegalStateException: the blob store said no\n\tat X',
    },
    exception: true,
    ...over,
  });

  /** The exporting process's own map, carried by every record it sends. */
  const RESOURCE = {
    'service.name': 'qits-fixture',
    'service.version': '2026.802.164102',
    'deployment.environment.name': 'production',
    'service.instance.id': '8f2c41ae-6d18-4a90-9f0b-2ec3b7a51d44',
  };

  const span = (over: Partial<TelemetryErrorGroupDto['errorSpans'][number]> = {}) => ({
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
    resourceAttributes: RESOURCE,
    events: [exception()],
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
    resourceAttributes: RESOURCE,
    ...over,
  });

  const group = (over: Partial<TelemetryErrorGroupDto> = {}): TelemetryErrorGroupDto => ({
    traceId: 'bb11cc22dd33ee44ff556677889900aa',
    serviceName: 'qits-fixture',
    errorSpans: [span()],
    errorLogs: [log()],
    ...over,
  });

  it('takes its headline from the exception the service marked, type and message together', () => {
    const view = viewErrorGroup(group());

    expect(view.headlineKind).toBe('exception');
    expect(view.headline).toBe('java.lang.IllegalStateException: the blob store said no');
    expect(view.exceptionType).toBe('java.lang.IllegalStateException');
  });

  it('reads the service’s own exception verdict rather than the event’s name', () => {
    // An event named "exception" that the service did not mark as one is not an exception here.
    const view = viewErrorGroup(
      group({
        errorSpans: [span({ events: [exception({ exception: false })], statusMessage: 'nope' })],
        errorLogs: [],
      }),
    );

    expect(view.headlineKind).toBe('status');
    expect(view.headline).toBe('nope');
  });

  it('falls back to a status message, then to a log body, and says which it used', () => {
    const status = viewErrorGroup(group({ errorSpans: [span({ events: [] })], errorLogs: [] }));
    expect(status.headlineKind).toBe('status');
    expect(status.headline).toBe('the blob store said no');

    const body = viewErrorGroup(
      group({ errorSpans: [span({ events: [], statusMessage: '' })], errorLogs: [log()] }),
    );
    expect(body.headlineKind).toBe('log');
    expect(body.headline).toBe('blob write failed: the blob store said no');
  });

  it('says there is no message rather than drawing a blank line', () => {
    const view = viewErrorGroup(
      group({ errorSpans: [span({ events: [], statusMessage: '' })], errorLogs: [] }),
    );

    expect(view.headlineKind).toBe('none');
    expect(view.headline).toBe('');
  });

  it('draws the uncorrelated group from its logs, because it has no spans at all', () => {
    // Measured: a posted ERROR log with no trace id reads back as exactly this — an empty trace id,
    // an empty errorSpans, and one log. A card that reached for errorSpans[0] draws nothing here.
    const view = viewErrorGroup({
      traceId: '',
      serviceName: 'qits-ck-fixture',
      errorSpans: [],
      errorLogs: [
        log({ traceId: '', spanId: '', body: 'manifest rejected: no digest for layer 3' }),
      ],
    });

    expect(view.uncorrelated).toBe(true);
    expect(view.spanCount).toBe(0);
    expect(view.headlineKind).toBe('log');
    expect(view.headline).toBe('manifest rejected: no digest for layer 3');
  });

  it('keeps the service’s order and moves the uncorrelated group to the end', () => {
    const first = group({ traceId: 'aaaa' });
    const uncorrelated = group({ traceId: '', errorSpans: [] });
    const last = group({ traceId: 'bbbb' });

    const views = viewErrorGroups([first, uncorrelated, last]);

    expect(views.map((view) => view.traceId)).toEqual(['aaaa', 'bbbb', '']);
  });

  it('dates a group by when its evidence ended, not by when it started', () => {
    // A slow failure that began first ended last. Dating it by its start would file it in the
    // wrong place on a list read by recency.
    const view = viewErrorGroup(group({ errorSpans: [span({ durationMs: 796 })], errorLogs: [] }));

    expect(view.latestEpochMillis).toBe(START_MILLIS + 796);
  });

  it('takes the newest end of the evidence, whether that is a span or a log', () => {
    const view = viewErrorGroup(
      group({
        errorSpans: [span({ durationMs: 10 })],
        errorLogs: [log({ epochNanos: (START_MILLIS + 5000) * 1_000_000 })],
      }),
    );

    expect(view.latestEpochMillis).toBe(START_MILLIS + 5000);
  });

  it('counts both kinds of evidence separately, because they are different things', () => {
    const view = viewErrorGroup(group({ errorSpans: [span(), span()], errorLogs: [log()] }));

    expect(view.spanCount).toBe(2);
    expect(view.logCount).toBe(1);
  });
});
