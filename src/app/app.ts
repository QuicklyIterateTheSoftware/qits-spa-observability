import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * The shell, and deliberately nothing else. The chrome this SPA wears — sidebar, top bar, the
 * links out to the other applications — is `QitsMainLayout` behind the `''` route (see
 * app.routes.ts), so that it survives navigation instead of being rebuilt on every page.
 *
 * That leaves this component owning exactly one thing: the outlet the route table renders into.
 * It knows nothing of `/observability/` either — the mount point is the build's `baseHref`, which
 * the layout reads off the document rather than being told.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
export class App {}
