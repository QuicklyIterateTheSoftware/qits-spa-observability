import { RECENT_RESTART_MS, bufferAge, restartEmptied } from './restart';

/**
 * The shared restart sentence, asserted directly rather than through five screens.
 *
 * The point of this module is that the five screens say the *same* thing, so the assertions here are
 * about the sentence itself: its lead is fixed, its coda is the caller's, and the threshold has one
 * value. A per-screen spec can only prove that its own screen says something; only this one can
 * prove they all say it identically.
 */
describe('restartEmptied', () => {
  const NOW = Date.UTC(2026, 7, 1, 15, 40, 2);
  const startedAgo = (ms: number) => ({ startedAt: new Date(NOW - ms).toISOString() });

  it('leads with the emptying and closes with the caller’s own loss', () => {
    const sentence = restartEmptied(
      startedAgo(60_000),
      NOW,
      'Anything logged before that is gone.',
    );

    expect(sentence).toBe(
      'The buffer was emptied 1 m 00 s ago when qits-observability restarted. ' +
        'Anything logged before that is gone.',
    );
  });

  it('says nothing once the restart is too old to be the explanation', () => {
    // A buffer up for six hours and empty is a service nothing is exporting to, which is a real
    // problem — and dressing it as a fresh start is precisely how a real problem goes unread.
    expect(restartEmptied(startedAgo(6 * 3600_000), NOW, 'gone.')).toBe('');
  });

  it('holds the threshold at one value, on the inside and the outside of it', () => {
    expect(restartEmptied(startedAgo(RECENT_RESTART_MS - 1000), NOW, 'gone.')).not.toBe('');
    expect(restartEmptied(startedAgo(RECENT_RESTART_MS), NOW, 'gone.')).toBe('');
  });

  it('says nothing at all rather than “NaN ago” for a store it cannot read', () => {
    expect(restartEmptied(null, NOW, 'gone.')).toBe('');
    expect(restartEmptied({ startedAt: 'not a time' }, NOW, 'gone.')).toBe('');
    expect(bufferAge({ startedAt: 'not a time' }, NOW)).toBeNull();
  });

  it('never reports a negative age for a clock that is behind the service’s', () => {
    // The stamp is the server's and the subtraction is the browser's, so a skewed laptop can put a
    // start in the future. "Emptied -3 s ago" would be a sentence about the reader's clock.
    expect(bufferAge(startedAgo(-5000), NOW)).toBe(0);
  });
});
