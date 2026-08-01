# QitsSpaObservability

The observability explorer: the read-only view of what this platform is reporting about itself,
served by qits-observability itself at `/observability/` through Quinoa. Six screens, no forms, and
no writes at all.

**The shell costs 2 requests, and every screen adds exactly one.** `GET /telemetry/store` and
`GET /telemetry/sources` are held app-wide by one injectable and shared by every page, so no page in
this SPA costs more than 3 requests cold. The budgets below are asserted in the specs, not merely
written down here.

- **`/observability/`** — the overview. The buffer's own state, every source with its per-signal
  counts and its per-service breakdown, and the ephemerality stated in full. **2 + 0**: the two
  shell reads and nothing per source, because a source's counts and its service breakdown arrive
  with its row. Expanding a source costs nothing, and selecting one costs nothing — selection is a
  query parameter the next screen reads.
- **`/observability/traces`** — the trace list, Recent or Slowest. **+1**
  (`GET /telemetry/traces?source=&service=&sort=&thresholdMs=&limit=`), every 10 s. It stays one
  request however you narrow it: the lens, the duration floor and the service each change _that_
  request rather than adding another, and the service chips are drawn from the source row the band
  already holds. With no source selected it is **+0** — a read with no source answers `200` and an
  empty list, so firing one would spend a request to say "no telemetry" about a bucket nobody chose.
- **`/observability/traces/<traceId>`** — the waterfall, the span detail pane and the correlated
  logs. **+1** (`GET /telemetry/traces/{traceId}?source=`). It does not poll: a trace is a finished
  thing, and a manual refresh covers late spans. The spans and their correlated logs arrive in the
  same answer, so the log rail costs nothing on top, and selecting a span costs nothing either.
- **`/observability/errors`** — one card per trace, its error spans and its ERROR logs together.
  **+1** (`GET /telemetry/errors?source=&service=&sinceMinutes=&limit=`).
- **`/observability/logs`** — the log tail, with search, severity chips and a follow mode. **+1**
  (`GET /telemetry/logs?source=&service=&query=&sinceMinutes=&limit=`), every 5 s while Follow is on.
- **`/observability/metrics`** — the metric series at their latest values. **+1**
  (`GET /telemetry/metrics?source=&service=&name=`).

Three of those six are placeholders today — errors, logs and metrics. They are addressable, they
carry the selected source, and they say what they will show and what it will cost — because an
unbuilt route that renders blank chrome is indistinguishable from a screen that failed to load.

**The lenses live in the URL, not in the components.** `?source=`, `?sort=`, `?threshold=` and
`?service=` each change what comes back, and by the house rule anything that costs a request is URL
state — so every screen here is a link somebody can send and the back button means "the list I was
looking at". A duration floor is applied by the service (`durationMs >= threshold`), which is why it
is a query parameter rather than a filter over rows the browser already paid to receive. `limit` is
the one figure that never comes from a URL: the service answers `400` outside `1..1000` rather than
clamping, so it is a constant.

## What this UI has to say before it shows anything

**The store empties on every restart, by design.** qits-observability receives OTLP from every
service on this platform and keeps it in memory: no database, no file on disk, no retention. A
deploy of the service is a restart, and a restart is an empty buffer. That is stated on the overview
in full and in a band on every screen — as information, not as an apology, and not as a dismissible
banner, because what it says never stops being true.

**It is also bounded**, per source and in total, and the bounds bite. The eviction counters are
shown whenever they are non-zero, in ordinary weight: eviction is the bound doing its job, and it is
also the difference between "the buffer is showing you everything" and "the buffer is showing you
what survived".

**So empty is a family of answers, not one**, and this app never draws "No data". A buffer that came
up two minutes ago and a buffer that has been up six hours and received nothing are the same blank
table and completely different facts. `app-empty` takes a required message for exactly this reason —
a component here physically cannot say "nothing" without saying why.

**No fake freshness.** Every record's time is drawn as an absolute clock reading with a relative
suffix (`15:40:02 · 2 m ago`), never a bare "2 m ago". This buffer holds records that may predate
your last page load by hours.

## How it stays current

**It polls**, and that is a measurement rather than a preference: qits-observability has no SSE, no
WebSocket and no long-poll route. It does fire an internal change hint, but that hint fires only for
workspace-scoped records — which is none of the telemetry that exists today — so a stream wired to it
would look live and never fire, which is worse than no stream at all.

The band re-reads the store and the sources every 10 s. A screen re-reads its own single request on
the same cadence, except the trace detail, which does not poll at all, and the log tail, which polls
every 5 s while Follow is on. **All polling stops when the tab is hidden** and does one immediate
catch-up read on return, so a backgrounded tab costs nothing. A failed poll backs off to 30 s, keeps
the last good answer on screen and marks it stale — data you know is 40 s old beats an empty page.

## What is in `src/app/`

`api/` holds hand-written interfaces mirroring the service's wire shapes and one injectable over
`HttpClient` on the fetch backend — one upstream, because there is no second service to join
against. Nothing is generated: the service's own generated schema names its response records
`Response` through `Response4`, and the platform generates documents rather than clients.

**A source key is opaque.** It comes from the sources listing and goes back on the wire verbatim;
nothing here builds one, parses one, or reads meaning out of one. It is spelled `_service/qits-ci`
today and that is not a promise. The reason it exists at all is that the old `repositoryId` +
`workspaceId` pair cannot name the bucket every qits service actually exports into.

`ui/` carries `loadable`, `async`, `empty`, `format`, `ticker` and `page.css`, copied from the
sibling SPAs rather than shared. `@qits/ui-components` carries presentational components, not
application types, so there is nowhere to put them yet — and this feature does not edit the shared
library.

**There is no charting dependency, and there will not be one.** The waterfall is a nested list where
each row carries a `left` and a `width` in percent, computed from the trace's own start and span:
`parentSpanId` + `startEpochNanos` + `durationMs` is exactly that, and nothing here is a curve. The
metrics screen is a table because the store keeps one point per series and replaces it in place —
there is no series to draw. No SPA on this platform has a chart library, and the one place a chart
was ever considered, it was refused in writing.

The layout itself is a pure function in `traces/trace-layout.ts`, and it is a function so that the
three shapes a bounded buffer forces can be asserted directly rather than through the DOM — each of
them draws something plausible and wrong if it is handled carelessly:

- **A span whose parent is not buffered is drawn at the top level and says so.** It is never
  re-parented. Eviction removes spans one at a time, and a client span whose server parent sits in
  another source's bucket is not damage at all — either way, an invented parent would draw a
  perfectly plausible tree that misstates who called whom.
- **A trace with no root at all is flagged**, rather than promoting the earliest survivor into a
  root it never was. The list answers this as `rootMissing`; the detail derives the same condition.
- **`durationMs` is integer milliseconds, so a sub-millisecond span is `0`.** The width stays an
  honest `0%` and the bar is floored in CSS, so the geometry remains a true proportion while the row
  stays visible. Its label reads `<1 ms`, which is exactly what the service's `0` means.

One measurement worth writing down: a nanosecond epoch is a 61-bit figure and JSON hands it to a
double, so its low bits are gone before this code sees it — 42 ms of nanos measures back as
42.000128 ms. Every calculation here lands in milliseconds, where 128 ns is five orders of magnitude
below the smallest thing drawn, so it is recorded rather than defended against. It is also why the
specs compare durations with a tolerance and build their stamps instead of typing them: a literal
that large is rejected outright by `no-loss-of-precision`.

## Running the checks

```bash
npm run lint && npm test && npm run build
```

**This repository runs no pipeline.** It has no repository on the platform git host and no
`.config/qits/` directory, so nothing runs those three but you. A change here reaches production only
when the `webui` gitlink in qits-observability is bumped and that repository is pushed — its own
pipeline fetches this submodule from GitHub, rewrites the lockfile's registry origins, and builds the
bundle into the service image.

## Development server

```bash
ng serve
```

Once the server is running, open `http://localhost:4200/`. The application reloads whenever you
modify a source file. `ng serve` puts no gateway in front; in a deployment every call is a
same-origin path behind the real one, which is what carries the browser's session cookie to
`/observability/api/telemetry/…` with no machine token and no CORS.

## Running unit tests

```bash
ng test
```

Vitest on jsdom through `@angular/build:unit-test`, with no vitest config file, matching every other
SPA here. `HttpTestingController` with `afterEach(() => http.verify())` for the transport,
`RouterTestingHarness` + `provideLocationMocks()` for the routes, fake timers for the poller, and an
`app.config.spec.ts` asserting the Fetch backend — the backend choice is invisible when it is wrong,
and on the telemetry UI getting it wrong would be self-inflicted.

There is no end-to-end framework on this platform, in this repository or any sibling.
