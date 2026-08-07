import { provideBrowserGlobalErrorListeners, type ApplicationConfig } from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideQitsNavigation } from '@qits/ui-components';

import { routes } from './app.routes';

/**
 * Four providers, in the order every sibling SPA lists them. The third was missing here until this
 * application started making requests.
 *
 * - `provideBrowserGlobalErrorListeners` funnels genuinely-global errors and unhandled rejections
 *   into Angular's `ErrorHandler`.
 * - `provideRouter` carries the selected source and every other lens in query parameters, and the
 *   trace id in the path, which is what makes each screen a link somebody can send.
 * - `withFetch` is not a preference. The default XHR backend is invisible to OTLP fetch
 *   instrumentation, so choosing it would quietly forfeit client spans — and on *this* application
 *   that is not an abstract loss. This is the telemetry UI; shipping it blind to the platform's own
 *   browser instrumentation would be a joke at its own expense.
 * - `provideQitsNavigation` fills the shared layout's sidebar. It issues one `GET /main-navigation`
 *   at startup and hands the answer to `QitsMainLayout`: the platform's door list is the gateway's
 *   answer now, derived from the routes it actually serves, rather than a list compiled into
 *   `@qits/ui-components` that lagged every new application. It rides on the `provideHttpClient`
 *   above, and without it the sidebar renders empty.
 *
 * Every call this app makes is a same-origin path behind the gateway, which is what lets the
 * browser's session cookie reach `/observability/api/telemetry/…` from a page served at
 * `/observability/` with no machine token and no CORS. `/main-navigation` is the one address that
 * is not under this app's own base path, and deliberately so — the gateway's root is the only
 * address every SPA can spell the same way.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withFetch()),
    provideQitsNavigation(),
  ],
};
