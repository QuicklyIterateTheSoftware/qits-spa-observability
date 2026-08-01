import { NONE, formatAge, formatBytes, formatCount, formatElapsed, formatStamp } from './format';

/**
 * The conversions, and one rule that is a product decision rather than a formatting preference.
 *
 * **No bare relative time.** Everything in this buffer may predate your last page load by hours, so
 * "2 m ago" on its own invites the conclusion that what is on screen is what just happened.
 * {@link formatStamp} is the only stamp the screens use for a record, and it always carries the
 * absolute reading beside the relative one.
 */
describe('format', () => {
  const NOW = Date.parse('2026-08-01T15:42:02Z');

  it('prints an absolute clock reading before every relative one', () => {
    expect(formatStamp('2026-08-01T15:40:02Z', NOW)).toBe('15:40:02 · 2 m 00 s ago');
  });

  it('says nothing rather than guessing when there is no timestamp', () => {
    expect(formatStamp(null, NOW)).toBe(NONE);
    expect(formatAge(undefined, NOW)).toBe(NONE);
    expect(formatCount(null)).toBe(NONE);
    expect(formatBytes(null)).toBe(NONE);
  });

  it('reads a span of time in the register the buffer band is written in', () => {
    expect(formatElapsed(41_000)).toBe('41 s');
    expect(formatElapsed(125_000)).toBe('2 m 05 s');
    expect(formatElapsed(22_680_000)).toBe('6 h 18 m');
  });

  it('groups counts, because the figures on this UI run to five digits', () => {
    expect(formatCount(41233)).toBe('41,233');
    expect(formatCount(92)).toBe('92');
  });

  it('never prints a bare byte number', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(3910224)).toBe('3.73 MiB');
    expect(formatBytes(67108864)).toBe('64.0 MiB');
  });
});
