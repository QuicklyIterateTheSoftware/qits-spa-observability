import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A node that loaded and holds nothing, said in a sentence.
 *
 * The message is `required` and that is the whole point: a component physically cannot render
 * "nothing here" without saying why. On this application the rule earns its keep several times a
 * day — a buffer that empties on restart has more reasons to be empty than any other screen on the
 * platform, and collapsing them into one "No data" would make a working service look broken.
 */
@Component({
  selector: 'app-empty',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p class="empty">{{ message() }}</p>`,
  styles: `
    .empty {
      margin: 0.15rem 0;
      color: #6b7280;
      font-style: italic;
    }
  `,
})
export class Empty {
  readonly message = input.required<string>();
}
