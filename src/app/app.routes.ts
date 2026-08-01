import type { Routes } from '@angular/router';
import { QitsMainLayout } from '@qits/ui-components';
import { NotFound } from './not-found/not-found';
import { OverviewPage } from './overview/overview-page';
import { PendingPage, type PendingScreen } from './pending/pending-page';
import { TracePage } from './traces/trace-page';
import { TracesPage } from './traces/traces-page';

/**
 * Seven routes, all of them inside the platform chrome.
 *
 * `QitsMainLayout` is the root *route* component rather than something the shell templates, so the
 * bar and the navigation mount once and survive every navigation beneath them; only the outlet's
 * content changes. Its `children` was empty until now, and its comment named this as the hook the
 * pages would attach to.
 *
 * **The overview is the root view**, not a child called `/overview`: `/observability/` is where an
 * operator arrives, and "is anything arriving at all" is what they came to find out.
 *
 * **A trace is addressed by its id alone** — `/observability/traces/<traceId>` — because that is
 * what the service's own route takes. The bucket it lives in rides in `?source=` beside it, along
 * with every other lens that costs a request: `?service=`, `?since=`, `?q=`, `?sort=` and
 * `?threshold=`. Nothing that costs a request hides in component state, which is what makes every
 * screen here a link somebody can send.
 *
 * Everything loads eagerly. There are seven routes, they share every component below them, and a
 * lazy chunk boundary here would be ceremony that costs a round trip.
 *
 * The `**` route sits *inside* the children — see {@link NotFound} for why that differs from
 * spa-home's. Without it an unknown URL under `/observability/` rendered blank chrome, which reads
 * as a screen that failed rather than as a page that does not exist.
 *
 * The remaining {@link PendingPage} entries are addressable, carry the selected source, and say
 * what they will show and what it will cost. Each screen's own workstream replaces its entry with
 * the real component; the last one to land deletes `PendingPage`. Traces and the waterfall are
 * real as of this commit — {@link TracesPage} and {@link TracePage} — and `/errors`, `/logs` and
 * `/metrics` are still placeholders belonging to other workstreams.
 */

/** The `/errors` screen, until it is written. */
const ERRORS: PendingScreen = {
  title: 'Errors',
  shows:
    'one card per trace with its error spans and its ERROR logs together, each linking to the ' +
    'waterfall.',
  reads: 'GET /observability/api/telemetry/errors?source=&service=&sinceMinutes=&limit=',
};

/** The `/logs` screen, until it is written. */
const LOGS: PendingScreen = {
  title: 'Logs',
  shows:
    'a tail of the buffered log records with a severity chip, a substring search and a follow ' +
    'mode that refreshes every five seconds while it is on.',
  reads: 'GET /observability/api/telemetry/logs?source=&service=&query=&sinceMinutes=&limit=',
};

/** The `/metrics` screen, until it is written. */
const METRICS: PendingScreen = {
  title: 'Metrics',
  shows:
    'a table of metric series grouped by name, each at its latest value. There is no chart: the ' +
    'buffer keeps one point per series and replaces it in place, so there is no history to plot.',
  reads: 'GET /observability/api/telemetry/metrics?source=&service=&name=',
};

export const routes: Routes = [
  {
    path: '',
    component: QitsMainLayout,
    children: [
      { path: '', component: OverviewPage },
      { path: 'traces', component: TracesPage },
      { path: 'traces/:traceId', component: TracePage },
      { path: 'errors', component: PendingPage, data: { screen: ERRORS } },
      { path: 'logs', component: PendingPage, data: { screen: LOGS } },
      { path: 'metrics', component: PendingPage, data: { screen: METRICS } },
      { path: '**', component: NotFound },
    ],
  },
];
