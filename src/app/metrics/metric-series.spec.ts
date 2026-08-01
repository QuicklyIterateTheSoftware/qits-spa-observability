import type { TelemetryMetricDto } from '../api/dto';
import {
  attributePairs,
  formatMetricValue,
  groupMetrics,
  seriesCount,
  unitGloss,
} from './metric-series';

/**
 * The metric table's shaping, asserted directly rather than through the DOM.
 *
 * Every case here is one a careless rendering gets *plausibly* wrong: a byte figure that reads as a
 * phone number, a counter that grows two decimal places it never had, an idle CPU ratio flattened
 * to zero, and a table that reorders itself under a ten-second poll. None of them looks broken on
 * screen, which is exactly why they are pinned here.
 *
 * The fixtures are the shapes the live service answered with on 2026-08-01, not invented ones.
 */
describe('metric-series', () => {
  const metric = (over: Partial<TelemetryMetricDto> = {}): TelemetryMetricDto => ({
    name: 'jvm.memory.used',
    description: 'Measure of memory used.',
    unit: 'By',
    type: 'COUNTER',
    value: 168296448,
    epochNanos: Date.UTC(2026, 7, 1, 15, 3, 0) * 1_000_000,
    serviceName: 'qits-ci',
    attributes: { 'jvm.memory.type': 'heap', 'jvm.memory.pool.name': 'survivor space' },
    ...over,
  });

  describe('formatMetricValue', () => {
    it('draws a byte figure as bytes, because nine digits are read wrong at a glance', () => {
      expect(formatMetricValue(168296448, 'By')).toBe('161 MiB');
      expect(formatMetricValue(12582912, 'By')).toBe('12.0 MiB');
    });

    it('leaves a cumulative counter an integer rather than giving it decimals it never had', () => {
      // The wire carries `41233.0`; printing "41,233.00" would claim a precision the instrument
      // does not have.
      expect(formatMetricValue(41233, '1')).toBe('41,233');
      expect(formatMetricValue(0, '{class}')).toBe('0');
    });

    it('keeps a small ratio rather than flattening every idle process to zero', () => {
      // Measured: jvm.cpu.recent_utilization sits around here on a quiet service, and two fixed
      // decimals would draw the whole platform as flat 0.00.
      expect(formatMetricValue(0.0021456, '1')).toBe('0.0021456');
    });

    it('falls back to exponential below a ten-thousandth rather than to a row of zeroes', () => {
      expect(formatMetricValue(0.000012345, '1')).toBe('1.234e-5');
    });

    it('draws a value it cannot read as nothing, never as 0', () => {
      expect(formatMetricValue(Number.NaN, '1')).toBe('—');
    });
  });

  describe('unitGloss', () => {
    it('explains the UCUM spellings that read as noise', () => {
      expect(unitGloss('1')).toBe('dimensionless — a ratio or a plain count');
      expect(unitGloss('{thread}')).toBe('a count of thread');
      expect(unitGloss('By')).toBe('bytes');
    });

    it('says nothing where the unit is already a word, so the raw one stands alone', () => {
      expect(unitGloss('')).toBe('');
      expect(unitGloss('kg')).toBe('');
    });
  });

  it('sorts a series’ attributes by key, exactly as the store sorts them into its series identity', () => {
    expect(attributePairs({ b: '2', a: '1' })).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
    ]);
  });

  it('groups by name and orders both levels itself, so a poll cannot reshuffle the table', () => {
    // The response arrives in the store's insertion order — the order a process first exported each
    // series — and a row that moved out from under a reader mid-read would be this screen's own
    // doing, not the service's.
    const groups = groupMetrics([
      metric({
        name: 'jvm.thread.count',
        unit: '{thread}',
        attributes: { 'jvm.thread.state': 'runnable' },
      }),
      metric({ attributes: { 'jvm.memory.type': 'non_heap' } }),
      metric({ attributes: { 'jvm.memory.type': 'heap' } }),
    ]);

    expect(groups.map((group) => group.name)).toEqual(['jvm.memory.used', 'jvm.thread.count']);
    expect(groups[0].series.map((series) => series.attributes[0].value)).toEqual([
      'heap',
      'non_heap',
    ]);
    expect(seriesCount(groups)).toBe(3);
  });

  it('filters on a case-insensitive substring, which the endpoint’s own name parameter is not', () => {
    // Measured live: `?name=memory` answered zero against a bucket holding five jvm.memory.used
    // series, and `?name=JVM.MEMORY.USED` answered zero as well. A box wired to that would need its
    // reader to already know the answer.
    const all = [metric(), metric({ name: 'jvm.thread.count', unit: '{thread}', attributes: {} })];

    expect(groupMetrics(all, 'MEMORY').map((group) => group.name)).toEqual(['jvm.memory.used']);
    expect(groupMetrics(all, '  ').map((group) => group.name)).toEqual([
      'jvm.memory.used',
      'jvm.thread.count',
    ]);
    expect(groupMetrics(all, 'nothing')).toEqual([]);
  });

  it('keys a series by its name and attributes, which is the identity the store already uses', () => {
    const [group] = groupMetrics([metric({ attributes: { 'jvm.memory.type': 'heap' } })]);

    expect(group.series[0].key).toBe('jvm.memory.used|jvm.memory.type=heap');
  });

  it('takes a description from whichever series declares one', () => {
    const [group] = groupMetrics([
      metric({ description: '', attributes: { a: '1' } }),
      metric({ attributes: { a: '2' } }),
    ]);

    // A blank subtitle beside a described sibling reads as "this one is undocumented" rather than
    // as the same instrument declared twice.
    expect(group.description).toBe('Measure of memory used.');
  });

  it('says MIXED rather than picking a winner when two services disagree about the kind', () => {
    const [group] = groupMetrics([
      metric({ type: 'COUNTER', serviceName: 'qits-ci', attributes: { a: '1' } }),
      metric({ type: 'GAUGE', serviceName: 'qits-cd', attributes: { a: '2' } }),
    ]);

    expect(group.kind).toBe('MIXED');
  });

  it('reports one kind where every series agrees, which is every case on this platform today', () => {
    expect(groupMetrics([metric(), metric({ attributes: { a: '9' } })])[0].kind).toBe('COUNTER');
  });
});
