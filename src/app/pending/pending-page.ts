import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { SourceStrip } from '../buffer/source-strip';

/** What a route tells this page to say about the screen that will replace it. */
export interface PendingScreen {
  /** The heading, and the nav entry a reader arrived from. */
  readonly title: string;
  /** What the finished screen will show, in one sentence, present tense about the data. */
  readonly shows: string;
  /** The one read it will make, so its cost is on record before it is written. */
  readonly reads: string;
}

/**
 * A route that is real, addressable and not built yet.
 *
 * It exists so the route table is the whole route table from the first commit: `/traces`,
 * `/errors`, `/logs` and `/metrics` answer today, carry the selected source, and say plainly that
 * the screen is not written rather than rendering blank chrome — which is what an unbuilt route
 * looked like here before, and is indistinguishable from a bug.
 *
 * It makes **no request of its own**. The band above it is the shell's two, so these routes cost
 * exactly what the Overview costs and no more.
 *
 * This component is scaffolding with a scheduled end: each screen's own workstream replaces its
 * route entry with the real component, and the last one to land deletes this file.
 */
@Component({
  selector: 'app-pending-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SourceStrip],
  template: `
    <header class="head">
      <h1>{{ screen().title }}</h1>
    </header>

    <app-source-strip />

    <p class="says">
      <strong>This screen is not built yet.</strong> It will show {{ screen().shows }}
    </p>
    <p class="note">
      It will cost one request on top of the band above: <code>{{ screen().reads }}</code
      >. The band is already live, so the buffer's state and its sources are current on this page
      even though the screen below them is empty.
    </p>
  `,
  styles: `
    :host {
      display: block;
    }
    .head h1 {
      margin: 0 0 1rem;
      font-size: 1.4rem;
    }
    .says {
      margin: 0 0 0.5rem;
      max-width: 68ch;
    }
    .note {
      margin: 0;
      max-width: 68ch;
      color: #6b7280;
      font-size: 0.88rem;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.9em;
    }
  `,
})
export class PendingPage {
  private readonly route = inject(ActivatedRoute);
  private readonly data = toSignal(this.route.data, { initialValue: this.route.snapshot.data });

  protected readonly screen = computed<PendingScreen>(
    () =>
      (this.data()['screen'] as PendingScreen | undefined) ?? {
        title: 'Not built yet',
        shows: 'nothing — this route names no screen.',
        reads: '',
      },
  );
}
