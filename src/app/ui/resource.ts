import type { Attributes } from '../api/dto';

/**
 * A record's resource attributes, as the two screens that draw them read it.
 *
 * A module of its own rather than a helper on one page, for the reason `severity` is one: both the
 * waterfall's detail pane and the errors screen's member lines answer the same question — **which
 * build emitted this** — and two copies of that would drift into two spellings of one answer.
 *
 * **The build leads, because it is the question this map exists to answer.** `service.version`
 * carries the deploy's sha or its calver, and it is the difference between reading about the code
 * that is running and reading about the code that was running twenty minutes ago. The other keys a
 * qits service stamps follow it in a fixed order, so two records' resource blocks are read down the
 * same lines; anything else an exporter added sorts by key underneath.
 *
 * **An absent resource is drawn as nothing at all, not as an absence.** This is the one place this
 * app does *not* write a sentence about what is missing, and the distinction is worth stating: a
 * span with no attributes is a fact about the instrumentation somebody may want to fix, while a
 * record with no resource is an exporter — usually an older build — that stamped none, which is the
 * same non-fact repeated on every record it sent. A heading over an empty table on every row of a
 * card would be noise, so the block hides itself instead.
 */

/** The service's own name. Already drawn beside every record, so it is not the headline here. */
export const SERVICE_NAME_KEY = 'service.name';

/** The build: a deploy sha, or a calver. The whole point of the map. */
export const SERVICE_VERSION_KEY = 'service.version';

/** Which environment the process believes it is in. */
export const ENVIRONMENT_KEY = 'deployment.environment.name';

/** The process instance, which is what tells two replicas of one build apart. */
export const INSTANCE_KEY = 'service.instance.id';

/** The order the known keys are drawn in. Everything else follows, sorted by key. */
const KNOWN_KEYS: readonly string[] = [
  SERVICE_VERSION_KEY,
  SERVICE_NAME_KEY,
  ENVIRONMENT_KEY,
  INSTANCE_KEY,
];

/** One resource attribute, as a template can iterate it. */
export interface ResourcePair {
  readonly key: string;
  readonly value: string;
}

/** Nothing to draw, as a shared constant so a template never destructures an undefined. */
export const NO_RESOURCE: readonly ResourcePair[] = [];

/**
 * A record's resource attributes as pairs, the build first.
 *
 * `undefined` is accepted although the wire type says the field is always there: these interfaces
 * are a hand-written claim about a service that ships beside this bundle, and a claim that turns out
 * to be one deploy early would otherwise throw inside a template and blank the whole pane.
 */
export function resourcePairs(attributes: Attributes | undefined): readonly ResourcePair[] {
  if (!attributes) {
    return NO_RESOURCE;
  }
  const pairs = Object.entries(attributes).map(([key, value]) => ({ key, value: String(value) }));
  return pairs.sort((left, right) => rank(left.key) - rank(right.key) || compare(left, right));
}

/**
 * The build a record came from, or the empty string.
 *
 * Trimmed, and empty for a version that arrived blank: an exporter that stamps the key with nothing
 * in it has said no more than one that left it out, and a bare `service.version` chip with no
 * version in it reads as a rendering fault.
 */
export function buildOf(attributes: Attributes | undefined): string {
  const value = attributes?.[SERVICE_VERSION_KEY];
  return value === undefined || value === null ? '' : String(value).trim();
}

/** Where a key sits: its place among the known ones, or after all of them. */
function rank(key: string): number {
  const index = KNOWN_KEYS.indexOf(key);
  return index < 0 ? KNOWN_KEYS.length : index;
}

function compare(left: ResourcePair, right: ResourcePair): number {
  return left.key.localeCompare(right.key);
}
