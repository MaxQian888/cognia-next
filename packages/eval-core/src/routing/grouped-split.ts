/**
 * Grouped, time-shifted train / calibration / test split for the learned
 * router (DESIGN §7.2, EVAL-01).
 *
 * A group is the unit of independence — a session id (or a
 * project/session/task-group key the caller composes). Every sample of a
 * group lands in exactly one partition, so multi-turn sessions and repeated
 * samples never leak between fitting, calibration and evaluation.
 *
 * The test partition is the LATEST time window: every test sample is at or
 * after `testStartsAt`, every train and calibration sample is strictly before
 * it. A group that straddles the cutoff (starts before it, continues after)
 * can satisfy neither rule, so it is purged into `excluded` rather than
 * quietly placed on one side. Calibration groups are drawn from the
 * pre-window pool by a seeded shuffle, so the whole split is a pure function
 * of the samples and the seed — independent of input order.
 */

import { createSeededRandom } from "../seeded-random"
import { RoutingMathError } from "./logistic"

export { createSeededRandom } from "../seeded-random"

/** Fisher–Yates shuffle driven by {@link createSeededRandom}; the input is not mutated. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const random = createSeededRandom(seed)
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const swap = out[i]
    out[i] = out[j]
    out[j] = swap
  }
  return out
}

export interface GroupedSample {
  /** Session id (or a composed project/session/task-group key). */
  groupId: string
  /** Decision time, epoch milliseconds. */
  timestamp: number
}

export interface GroupedTimeSplitOptions {
  /** Seeds the calibration draw. */
  seed: number
  /**
   * Share of groups, by count, placed in the latest time window. Default 0.2.
   * Ignored when `testStartsAt` is given.
   */
  testFraction?: number
  /** Explicit start of the test window (epoch ms); groups starting at or after it are test. */
  testStartsAt?: number
  /** Share of the pre-window groups held out for calibration. Default 0.25. */
  calibrationFraction?: number
}

export const DEFAULT_GROUPED_SPLIT_OPTIONS = {
  testFraction: 0.2,
  calibrationFraction: 0.25,
} as const

export type GroupedSplitPartition = "train" | "calibration" | "test" | "excluded"

export interface GroupedTimeSplit<T extends GroupedSample> {
  train: T[]
  calibration: T[]
  test: T[]
  /** Samples of groups that straddle the test cutoff. */
  excluded: T[]
  /** Group ids per partition, sorted. */
  groups: Record<GroupedSplitPartition, string[]>
  /** The cutoff applied: test is at or after it, train and calibration strictly before. Null when no test window was cut. */
  testStartsAt: number | null
  seed: number
  /** The requested test share; null when `testStartsAt` was explicit. */
  testFraction: number | null
  calibrationFraction: number
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function checkFraction(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RoutingMathError("INVALID_OPTION", `${name} must be within [0, 1), got ${value}`)
  }
}

/**
 * How many of `total` groups a fraction takes: none for a zero fraction or a
 * single group, otherwise at least one and never all of them.
 */
function share(fraction: number, total: number): number {
  if (fraction === 0 || total < 2) return 0
  return Math.min(total - 1, Math.max(1, Math.round(fraction * total)))
}

export function groupedTimeSplit<T extends GroupedSample>(
  samples: readonly T[],
  options: GroupedTimeSplitOptions
): GroupedTimeSplit<T> {
  const { seed } = options
  if (!Number.isInteger(seed)) {
    throw new RoutingMathError("INVALID_OPTION", `seed must be an integer, got ${seed}`)
  }
  const calibrationFraction =
    options.calibrationFraction ?? DEFAULT_GROUPED_SPLIT_OPTIONS.calibrationFraction
  checkFraction("calibrationFraction", calibrationFraction)
  const explicitStart = options.testStartsAt
  const testFraction =
    explicitStart === undefined
      ? (options.testFraction ?? DEFAULT_GROUPED_SPLIT_OPTIONS.testFraction)
      : null
  if (testFraction !== null) checkFraction("testFraction", testFraction)
  if (explicitStart !== undefined && !Number.isFinite(explicitStart)) {
    throw new RoutingMathError("INVALID_OPTION", "testStartsAt must be a finite timestamp")
  }

  const spans = new Map<string, { first: number; last: number }>()
  samples.forEach((sample, index) => {
    if (typeof sample.groupId !== "string" || sample.groupId.length === 0) {
      throw new RoutingMathError("INVALID_SAMPLE", `sample ${index} has no group id`)
    }
    if (!Number.isFinite(sample.timestamp)) {
      throw new RoutingMathError("INVALID_SAMPLE", `sample ${index} has a non-finite timestamp`)
    }
    const span = spans.get(sample.groupId)
    if (span) {
      span.first = Math.min(span.first, sample.timestamp)
      span.last = Math.max(span.last, sample.timestamp)
    } else {
      spans.set(sample.groupId, { first: sample.timestamp, last: sample.timestamp })
    }
  })

  const ordered = [...spans.entries()].sort(
    ([leftId, left], [rightId, right]) =>
      left.first - right.first || compareStrings(leftId, rightId)
  )
  let testStartsAt: number | null
  if (explicitStart !== undefined) {
    testStartsAt = explicitStart
  } else {
    const testCount = share(testFraction ?? 0, ordered.length)
    testStartsAt = testCount > 0 ? ordered[ordered.length - testCount][1].first : null
  }

  const partitionOf = new Map<string, GroupedSplitPartition>()
  const pool: string[] = []
  for (const [groupId, span] of ordered) {
    if (testStartsAt !== null && span.first >= testStartsAt) partitionOf.set(groupId, "test")
    else if (testStartsAt !== null && span.last >= testStartsAt) {
      partitionOf.set(groupId, "excluded")
    } else pool.push(groupId)
  }
  pool.sort(compareStrings)
  const shuffled = seededShuffle(pool, seed)
  const calibrationCount = share(calibrationFraction, shuffled.length)
  shuffled.forEach((groupId, index) => {
    partitionOf.set(groupId, index < calibrationCount ? "calibration" : "train")
  })

  const split: GroupedTimeSplit<T> = {
    train: [],
    calibration: [],
    test: [],
    excluded: [],
    groups: { train: [], calibration: [], test: [], excluded: [] },
    testStartsAt,
    seed,
    testFraction,
    calibrationFraction,
  }
  for (const sample of samples) {
    const partition = partitionOf.get(sample.groupId) as GroupedSplitPartition
    split[partition].push(sample)
  }
  for (const [groupId, partition] of partitionOf) split.groups[partition].push(groupId)
  for (const partition of Object.keys(split.groups) as GroupedSplitPartition[]) {
    split.groups[partition].sort(compareStrings)
  }
  return split
}

/**
 * The EVAL-01 invariants of a split, as problems (empty means sound): no
 * group in two partitions, every sample in its group's partition, and the test
 * window strictly after every train and calibration sample.
 */
export function verifyGroupedTimeSplit<T extends GroupedSample>(
  split: GroupedTimeSplit<T>
): string[] {
  const problems: string[] = []
  const owner = new Map<string, GroupedSplitPartition>()
  for (const partition of ["train", "calibration", "test", "excluded"] as const) {
    for (const groupId of split.groups[partition]) {
      const previous = owner.get(groupId)
      if (previous) problems.push(`group ${groupId} is in both ${previous} and ${partition}`)
      else owner.set(groupId, partition)
    }
  }
  for (const partition of ["train", "calibration", "test", "excluded"] as const) {
    for (const sample of split[partition]) {
      const expected = owner.get(sample.groupId)
      if (expected !== partition) {
        problems.push(
          `a sample of group ${sample.groupId} is in ${partition} but the group is in ${expected ?? "no partition"}`
        )
      }
    }
  }
  if (split.testStartsAt === null) {
    if (split.test.length > 0) problems.push("test samples exist without a test window")
  } else {
    const start = split.testStartsAt
    if (split.test.some((sample) => sample.timestamp < start)) {
      problems.push("a test sample precedes the test window")
    }
    if ([...split.train, ...split.calibration].some((sample) => sample.timestamp >= start)) {
      problems.push("a train or calibration sample falls inside the test window")
    }
  }
  return problems
}
