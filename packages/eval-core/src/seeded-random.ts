/**
 * Deterministic seeded PRNGs shared across eval-core, so a seed means the
 * same stream in statistics, routing splits, and blind judging. Both
 * generators are pure functions of the seed and draw count — no Date, no
 * Math.random — which is what makes every seeded procedure in the package
 * reproducible.
 */

/**
 * mulberry32: the state is a 32-bit counter advanced by a fixed odd increment
 * on every draw, and the returned value is a scrambled copy of that counter.
 * The state itself is never scrambled, so seeds act as pure stream offsets.
 *
 * This is the canonical eval-core generator; reach for it first.
 */
export function createSeededRandom(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let next = value
    next = Math.imul(next ^ (next >>> 15), next | 1)
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61)
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The generator blind judging has always used: the mulberry32 scramble is
 * applied to the state itself (no counter increment), so each draw chains off
 * the previously scrambled state. It produces a DIFFERENT stream than
 * {@link createSeededRandom} for the same seed — it exists to keep
 * `buildBlindAssignments` byte-identical with assignments already issued, not
 * for new consumers.
 *
 * Caveat: seed 0 is a fixed point — every draw returns 0.
 */
export function createChainedSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = Math.imul(state ^ (state >>> 15), state | 1)
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61)
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296
  }
}
