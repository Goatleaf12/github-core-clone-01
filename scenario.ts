// The public scenario seed, re-derived here so the forge knows who the viewer
// is without ever decoding the opaque bearer token. The token is `shpat_...`
// and carries no usable identity, so the entry replays the same deterministic
// generator the suite uses: the first user of the 'users' stream is the viewer.
//
// Only the first user is ever needed (every created repo belongs to the viewer,
// and any other owner is a 404), so this module derives exactly that one login
// and nothing else. The name lists and the PRNG are the kit's public constants.

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
export const U64_MASK = 0xffffffffffffffffn;

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** FNV-1a, 64-bit: a label's stable seed contribution. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer: a seeded value with every bit mixed into every other. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The seed a named stream starts from: a stable function of SCENARIO_SEED and the label. */
function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/**
 * xorshift64*: a 64-bit state walked by three shifts and one multiply. Every
 * method is deterministic and has no hidden state but `state`.
 */
class Rng {
  state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }

  /** The next 64-bit value. */
  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  /** The next 32-bit value, from the top half of nextU64(). */
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) throw new Error(`nextInt needs a positive safe integer, not ${String(maxExclusive)}`);
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  /** One element, uniformly. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[this.nextInt(items.length)];
  }
}

export interface ViewerProfile {
  id: number;
  login: string;
  name: string;
  email: string;
}

/**
 * The viewer: the first user of the 'users' stream. generateUsers picks a first
 * name then a last name for user 0, so two picks in that order give the login.
 * Computed once and frozen; every module reads this one value.
 */
function deriveViewer(): ViewerProfile {
  const rng = new Rng(scenarioSeedFor('users'));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const login = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
  return { id: 1000, login, name: `${first} ${last}`, email: `${login}@example.invalid` };
}

export const VIEWER: ViewerProfile = deriveViewer();

/** The default branch every created repo starts with. */
export const DEFAULT_BRANCH = 'main';

/** The default git identity stamped on REST-created commits. */
export const DEFAULT_IDENT_NAME = 'Conformance';
export const DEFAULT_IDENT_EMAIL = 'conformance@make.fun';
/** The default commit timestamp (seconds since epoch) for REST-created commits. */
export const DEFAULT_COMMIT_TS = 1700000000;

/** The fixed time the scenario treats as "now" (2025-01-01T00:00:00Z). */
export const SCENARIO_EPOCH_SEC = 1735689600;
