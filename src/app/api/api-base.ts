import { InjectionToken } from '@angular/core';

/**
 * The origin every request in this app is built on, and it is empty on purpose.
 *
 * The SPA is served at `/observability/` by qits-observability itself, behind the same gateway that
 * authenticates the telemetry routes — so a same-origin absolute path is not a shortcut, it is the
 * whole reason the browser's session cookie reaches the service with no machine token and no CORS
 * pre-flight. A configured base URL would move these calls cross-origin and lose exactly that.
 *
 * It is a token rather than a constant for one reason: a spec needs a seam to assert the path
 * against, and `ng serve` (no gateway in front) may want a dev proxy's prefix. It is not provided in
 * `app.config.ts`, here or in any sibling; it self-provides, and adds no behaviour — only a handle.
 */
export const QITS_API_BASE = new InjectionToken<string>('qits.api-base', {
  providedIn: 'root',
  factory: () => '',
});
