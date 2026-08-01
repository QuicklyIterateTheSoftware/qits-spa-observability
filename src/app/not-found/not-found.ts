import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * A URL under `/observability/` that this app does not recognise.
 *
 * The `**` route sits *inside* the layout's children, unlike spa-home's. spa-home is mounted at the
 * gateway root, where an unrecognised first segment belongs to another application and has to be
 * handed back; `/observability/` is a segment this application owns outright, so an unknown URL
 * under it is an ordinary 404 and is drawn with the chrome around it.
 *
 * Before this existed, an unknown URL here rendered blank chrome — a page that looks like a screen
 * that failed to load rather than a page that does not exist.
 */
@Component({
  selector: 'app-not-found',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <h1>No such page here</h1>
    <p>
      This is the observability explorer. It has an overview, a trace list and a trace detail, and a
      screen each for errors, logs and metrics — and nothing else.
    </p>
    <p><a routerLink="/">Back to the overview</a></p>
  `,
  styles: `
    h1 {
      font-size: 1.25rem;
      margin: 0 0 0.5rem;
    }
  `,
})
export class NotFound {}
