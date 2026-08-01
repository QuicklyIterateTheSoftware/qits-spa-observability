import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { StoreStateDto, TelemetrySourceDto } from '../api/dto';
import { routes } from '../app.routes';

/**
 * The overview, driven through `HttpTestingController`.
 *
 * **The assertion that matters most is a negative one** — that this page costs the shell's two
 * requests and *nothing else*, whatever a reader does on it. Expanding a source and selecting one
 * both cost zero, and that is silent when it regresses: a page that fanned out per source, or
 * re-read the list on every selection, would look exactly the same on screen and simply cost.
 *
 * The rest is the empty-state family. A buffer that came up two minutes ago and a buffer that has
 * been up for hours and received nothing are the same blank table and completely different facts,
 * so both are asserted to say different things. Drawing them the same way is how a working, empty
 * service gets reported as broken.
 */
describe('OverviewPage', () => {
  let http: HttpTestingController;
  let harness: RouterTestingHarness;

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
    key: '_service/qits-ci',
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

  async function open(url = '/'): Promise<void> {
    harness = await RouterTestingHarness.create(url);
  }

  function page(): HTMLElement {
    return harness.fixture.nativeElement as HTMLElement;
  }

  function text(): string {
    return page().textContent ?? '';
  }

  /** The band alone. The buffer facts table always names the counters; the band names only losses. */
  function strip(): string {
    return page().querySelector('app-source-strip')?.textContent ?? '';
  }

  async function settle(): Promise<void> {
    for (let round = 0; round < 6; round += 1) {
      await Promise.resolve();
      await harness.fixture.whenStable();
    }
  }

  /** The shell's pair. Every screen in this app is answered with exactly these two. */
  function flush(
    sources: readonly TelemetrySourceDto[] = [source()],
    state: StoreStateDto = store(),
  ): void {
    http.expectOne('/observability/api/telemetry/store').flush(state);
    http.expectOne('/observability/api/telemetry/sources').flush({ sources });
  }

  function buttons(): HTMLButtonElement[] {
    return Array.from(page().querySelectorAll('button'));
  }

  async function click(label: string): Promise<void> {
    const target = buttons().find((button) => (button.textContent ?? '').includes(label));
    expect(target, `no button reading "${label}"`).toBeTruthy();
    target?.click();
    await settle();
  }

  it('costs two requests cold, and they are the shell’s', async () => {
    await open();
    const requests = http.match(() => true);
    expect(requests.map((request) => request.request.url)).toEqual([
      '/observability/api/telemetry/store',
      '/observability/api/telemetry/sources',
    ]);
    requests[0].flush(store());
    requests[1].flush({ sources: [source()] });
    await settle();

    expect(text()).toContain('qits-ci');
    http.verify();
  });

  it('costs nothing per source: expanding one draws its services from the row it already has', async () => {
    await open();
    flush();
    await settle();

    expect(text()).not.toContain('qits-artifacts');
    await click('qits-ci');

    expect(text()).toContain('qits-artifacts');
    http.verify(); // the breakdown arrived with the row
  });

  it('costs nothing to select a source — it is a query parameter, not a read', async () => {
    await open();
    flush();
    await settle();

    await click('Select');

    expect(TestBed.inject(Router).url).toContain('source=_service%2Fqits-ci');
    http.verify();
  });

  it('states the ephemerality in full, as information rather than as a warning', async () => {
    await open();
    flush();
    await settle();

    expect(text()).toContain('the store empties completely every time the service restarts');
    expect(text()).toContain('no database behind it');
    expect(text()).toContain('A restart empties it. Nothing here is written to disk.');
  });

  it('shows the eviction count, because it changes what every other number means', async () => {
    await open();
    flush();
    await settle();

    expect(strip()).toContain('41,233 spans evicted');
  });

  it('draws no eviction clause in the band when nothing has been evicted', async () => {
    await open();
    flush([source()], store({ evictedSpans: 0 }));
    await settle();

    // Zero is still reported in the buffer's own facts — "nothing has been lost" is a fact worth
    // stating. What it must not do is put "0 evicted" in a band read on every screen.
    expect(strip()).not.toContain('evicted');
    expect(text()).toContain('Spans evicted');
  });

  it('explains an empty buffer by the restart that emptied it, when there was one', async () => {
    await open();
    flush([], store({ startedAt: new Date(Date.now() - 60_000).toISOString(), sourceCount: 0 }));
    await settle();

    expect(text()).toContain('when qits-observability restarted');
    expect(text()).not.toContain('no process is currently exporting');
  });

  it('does not blame a restart for an empty buffer that has been up for hours', async () => {
    await open();
    flush([], store({ sourceCount: 0 }));
    await settle();

    expect(text()).toContain('no process is currently exporting');
    expect(text()).not.toContain('when qits-observability restarted');
  });

  it('names the workspace lens honestly rather than hiding a bucket with nothing in it', async () => {
    await open();
    flush([
      source({
        key: 'repo-1/wt-9',
        kind: 'WORKSPACE',
        label: 'wt-9',
        repositoryId: 'repo-1',
        workspaceId: 'wt-9',
        services: [],
        spans: 0,
        logs: 0,
        metricSeries: 0,
        bytes: 0,
        oldestReceivedAt: null,
        newestReceivedAt: null,
      }),
    ]);
    await settle();

    expect(text()).toContain('WORKSPACE');
    expect(text()).toContain('nothing buffered');
    expect(text()).toContain('1 workspace buckets exist and none of them holds a record');
  });

  it('says no workspace has ever exported, and names the gap rather than the symptom', async () => {
    await open();
    flush();
    await settle();

    // The workspace lens is real, has never had a subject, and will fill with no change to this
    // page. A reader who knows this platform runs workspaces will otherwise read the absence as a
    // broken screen.
    expect(text()).toContain(
      'No workspace has exported telemetry, and no workspace bucket exists.',
    );
    expect(text()).toContain('the sender is a known gap');
  });

  it('says nothing about workspaces once one of them has exported something', async () => {
    await open();
    flush([source({ key: 'repo-1/wt-9', kind: 'WORKSPACE', label: 'wt-9', spans: 4 })]);
    await settle();

    expect(text()).not.toContain('the sender is a known gap');
  });

  it('says nothing about workspaces on an empty buffer, where the restart is the answer', async () => {
    await open();
    flush([], store({ sourceCount: 0 }));
    await settle();

    // A second explanation for a screen that already has one is noise, not honesty.
    expect(text()).not.toContain('the sender is a known gap');
    expect(text()).toContain('no process is currently exporting');
  });

  // This claim used to be about `PendingPage`, and it moved as each screen landed: `/traces`, then
  // `/errors`, then `/metrics`, which was the last route standing behind it. There is no unbuilt
  // screen left, so what is asserted now is what the placeholder was always standing in for — that
  // the selection travels in the URL and the receiving screen reads it back.
  it('carries the selected source into the screen a reader navigates to', async () => {
    await open('/metrics?source=_service%2Fqits-ci');
    flush();
    http
      .expectOne(
        (request) =>
          request.url === '/observability/api/telemetry/metrics' &&
          request.params.get('source') === '_service/qits-ci',
      )
      .flush({ metrics: [] });
    await settle();

    expect(text()).toContain('qits-ci');
    http.verify();
  });

  it('draws a 404 with the chrome around it rather than blank chrome', async () => {
    await open('/nope');
    await settle();

    // No band, and therefore no requests: a page that does not exist has no buffer to describe.
    expect(text()).toContain('No such page here');
    http.verify();
  });
});
