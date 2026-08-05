import { buildOf, resourcePairs } from './resource';

/**
 * What a record says about the process that sent it, asserted on the function rather than through a
 * pane.
 *
 * The shapes are the ones a qits service actually stamps — `service.name`, `service.version`,
 * `deployment.environment.name`, `service.instance.id` — plus the two an older exporter produces: no
 * map at all, and the key present with nothing in it. Both of those draw *something* if they are
 * handled carelessly, and what they draw is a chip that looks like a build and names none.
 */
describe('resource attributes', () => {
  const RESOURCE = {
    'service.instance.id': '8f2c41ae',
    'deployment.environment.name': 'production',
    'service.name': 'qits-observability',
    'service.version': '2026.802.164102',
  };

  it('leads with the build, because that is the question the map exists to answer', () => {
    const pairs = resourcePairs(RESOURCE);

    expect(pairs.map((pair) => pair.key)).toEqual([
      'service.version',
      'service.name',
      'deployment.environment.name',
      'service.instance.id',
    ]);
    expect(pairs[0].value).toBe('2026.802.164102');
  });

  it('keeps that order whatever order the exporter sent the keys in', () => {
    // Two records of one process must read down the same lines, or comparing them is a hunt.
    const reversed = Object.fromEntries(Object.entries(RESOURCE).reverse());

    expect(resourcePairs(reversed).map((pair) => pair.key)).toEqual(
      resourcePairs(RESOURCE).map((pair) => pair.key),
    );
  });

  it('sorts anything else the exporter added underneath the four it knows', () => {
    const pairs = resourcePairs({ ...RESOURCE, 'host.name': 'node-2', 'cloud.region': 'eu' });

    expect(pairs.map((pair) => pair.key).slice(4)).toEqual(['cloud.region', 'host.name']);
  });

  it('draws an empty map as nothing at all, so the block can hide itself', () => {
    expect(resourcePairs({})).toEqual([]);
    // A hand-written wire type is a claim about a service, not a guarantee: a bundle one deploy
    // ahead of its own backend must draw a blank pane rather than throw inside a template.
    expect(resourcePairs(undefined)).toEqual([]);
  });

  it('stringifies whatever the exporter stamped, because a value is unknown on the wire', () => {
    const pairs = resourcePairs({ 'service.version': 41, 'a.flag': true });

    expect(pairs[0]).toEqual({ key: 'service.version', value: '41' });
    expect(pairs[1]).toEqual({ key: 'a.flag', value: 'true' });
  });

  it('answers the build on its own, for the screens that draw it beside a service name', () => {
    expect(buildOf(RESOURCE)).toBe('2026.802.164102');
  });

  it('calls a blank version no version, rather than an empty chip beside a filled one', () => {
    expect(buildOf({ 'service.version': '  ' })).toBe('');
    expect(buildOf({})).toBe('');
    expect(buildOf(undefined)).toBe('');
  });
});
