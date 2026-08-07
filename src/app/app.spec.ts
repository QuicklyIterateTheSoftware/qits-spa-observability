import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideQitsNavigationLinks, type QitsNavLink } from '@qits/ui-components';
import { App } from './app';
import { routes } from './app.routes';

/**
 * The shell owns one thing — the outlet — so that is what is asserted here, plus the route table
 * actually reaching the chrome behind `''`. What the layout itself renders is @qits/ui-components'
 * business; all this app is entitled to check is that it arrives, outlet and all.
 *
 * The root route is the overview now, and the overview reads the buffer on arrival — so this suite
 * needs a backend even though what it asserts is the shell and the chrome.
 */

/**
 * The navigation the layout is handed, standing in for the gateway's `/main-navigation`.
 *
 * The literal source rather than the testing backend, even in a suite that already has one: it
 * fetches nothing, so there is no navigation request to flush before an assertion and none left
 * pending to keep the harness from settling. The chrome is not what this suite is testing, and this
 * is what lets it stay that way.
 */
const NAV: readonly QitsNavLink[] = [
  { label: 'Home', href: '/' },
  { label: 'Observability', href: '/observability/' },
  { label: 'Events', href: '/events/' },
];

describe('App', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideQitsNavigationLinks(NAV),
      ],
    });
  });

  it('is an outlet and nothing else', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();

    const shell = fixture.nativeElement as HTMLElement;
    expect(shell.querySelector('router-outlet')).not.toBeNull();
    expect(shell.querySelector('h1')).toBeNull();
  });

  it('routes the root URL to the shared layout', async () => {
    const harness = await RouterTestingHarness.create('/');
    const layout = harness.routeNativeElement as HTMLElement;

    // The count is this fixture's, and only this fixture's. What the assertion proves is that the
    // app mounts the chrome and the chrome renders what it is told — how many doors the platform
    // really has is a deployment fact the gateway answers from its own route table, so asserting
    // that number is qits-gateway's spec's job, not this one's.
    expect(layout.querySelectorAll('nav a')).toHaveLength(NAV.length);
    expect(layout.querySelector('.qits-layout-content router-outlet')).not.toBeNull();
  });
});
