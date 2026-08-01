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
  **+1** (`GET /telemetry/errors?source=&service=&sinceMinutes=&limit=`), every 10 s. It stays one
  request however you narrow it, and **expanding a card costs nothing**: a group arrives with its
  spans, its logs and their stack traces inside it. With no source selected it is **+0** — and on
  this screen more than any other, because a sourceless read answers `200` with an empty list and
  "no errors" is far too reassuring a thing to say by accident.
- **`/observability/logs`** — the log tail, with search, severity chips and a follow mode. **+1**
  (`GET /telemetry/logs?source=&service=&query=&sinceMinutes=&limit=`), every 5 s while Follow is on
  and **not at all while it is off**. With no source selected it is **+0**.
- **`/observability/metrics`** — the metric series at their latest values. **+1**
  (`GET /telemetry/metrics?source=&service=&name=`).

One of those six is a placeholder today — metrics. It is addressable, it carries the selected
source, and it says what it will show and what it will cost — because an unbuilt route that renders
blank chrome is indistinguishable from a screen that failed to load.

**The lenses live in the URL, not in the components.** `?source=`, `?sort=`, `?threshold=`,
`?service=`, `?since=` and `?q=` each change what comes back, and by the house rule anything that
costs a request is URL state — so every screen here is a link somebody can send and the back button
means "the list I was looking at". A duration floor is applied by the service
(`durationMs >= threshold`), which is why it is a query parameter rather than a filter over rows the
browser already paid to receive; so is a window and so is a search. `limit` is the one figure that
never comes from a URL: the service answers `400` outside `1..1000` rather than clamping, so it is a
constant.

**`?since=` absent is not a very large window.** It means "everything still buffered", which on a
bounded store is a _smaller_ answer than the parameter suggests and the only setting that can never
hide a record the buffer is holding. It is the default on both screens that offer one. A window
filters on the service's own ingest stamp, never on the exporter's clock.

**Follow mode is the single exception to the URL rule, and it is a considered one.** It changes the
_cadence_ and never the answer — every read it makes is the read the screen would have made anyway —
and it switches itself off when the reader scrolls up, so keeping it in the URL would rewrite
somebody's address bar and their history as they read. Everything that changes _what comes back_
stays in the URL, so a shared link is still the list that was meant.

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

**A record with no severity is drawn as having none, never as `INFO`.** The OTLP field is optional
and a record can arrive with `severityNumber: 0` and no text at all — measured, by posting one. The
chip reads "no severity" and the tail says so once underneath, because a fabricated level sitting
beside a reported one is indistinguishable from it, and this is the one screen whose whole job is to
say exactly what a service claimed. The exporter's own word is kept where there is one: a service
answering `WARNING` is drawn as `WARNING` and not normalised to `WARN`, since that word is also what
the service's search matches.

**A group with no trace is not a trace.** Evidence qits-observability could not correlate groups
under an _empty_ trace id — an ERROR log written outside an active span is the ordinary case — and
that card sits at the bottom of the errors list, says what it is, and links nowhere. It also
arrives with no spans at all, which is why the card's headline comes from whichever evidence exists
rather than from the first span.

**An empty errors screen is good news, and it is written that way.** Everywhere else here an empty
answer is a fact about the buffer; on that one screen it is usually a fact about a platform that is
not failing, and a sentence reading as a failure to load would be exactly backwards.

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

**The tail is the one screen that goes faster than ten seconds, and the toggle is what buys it.**
Follow defaults on, re-reads every 5 s, and keeps the newest record in view. It switches itself off
the moment the reader scrolls up — scrolling away from the bottom is how a person says "hold still,
I am reading this" — and scrolling back down does _not_ switch it on again, because coming to rest
near the bottom is not a request to be moved; the button is how it comes back. With Follow off the
tail makes **no timed request at all**: not slower, none. Refresh is what it offers instead.

The tail draws oldest at the top and newest at the bottom, which is the order the service already
holds them in — nothing is reversed. And a limited answer keeps the **newest** records rather than
the first, measured against the live service: a tail that kept the oldest 200 would stop updating
while claiming to follow, and no row on screen would give that away.

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
library. Two modules there are this application's own rather than copies: `severity`, which turns a
log's two severity fields into a chip, and `window`, which holds the `?since=` spelling both screens
that offer a window must agree on.

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

`errors/error-group.ts` is the same idea one screen along: a group's headline, its counts and its
date are a pure function over the group, because each of them draws something plausible and wrong if
it is handled carelessly. A headline reached for from `errorSpans[0]` is blank on exactly the group
most in need of a sentence — the uncorrelated one has no spans. A group dated by its evidence's
_start_ files a slow failure by when it began rather than by when it failed, which puts the wrong
row in the wrong place on a list read by recency. And an exception is an exception because the
service said so on the event, not because the event happens to be named one.

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
