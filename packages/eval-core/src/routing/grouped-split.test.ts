import {
  createSeededRandom,
  groupedTimeSplit,
  seededShuffle,
  verifyGroupedTimeSplit,
  type GroupedTimeSplit,
} from "./grouped-split"

interface Turn {
  id: string
  groupId: string
  timestamp: number
}

/** Sessions as [id, turn timestamps]; repeated timestamps are repeated samples of one turn. */
const SESSIONS: Array<[string, number[]]> = [
  ["A", [1000, 1005, 1005]],
  ["B", [2000, 2004, 2010]],
  ["C", [3000, 3020]],
  ["D", [4000, 4001, 4001, 4003]],
  // Starts well before the latest window and keeps going into it.
  ["E", [5000, 7000, 9200]],
  ["F", [6000, 6010]],
  ["G", [7000, 7001]],
  ["H", [8000, 8002]],
  ["I", [9000, 9000, 9050]],
  ["J", [9500, 9600]],
]

function turns(sessions: Array<[string, number[]]> = SESSIONS): Turn[] {
  return sessions.flatMap(([groupId, stamps]) =>
    stamps.map((timestamp, index) => ({ id: `${groupId}-${index}`, groupId, timestamp }))
  )
}

function partitionOfEveryGroup(split: GroupedTimeSplit<Turn>): Map<string, Set<string>> {
  const seen = new Map<string, Set<string>>()
  for (const partition of ["train", "calibration", "test", "excluded"] as const) {
    for (const turn of split[partition]) {
      const partitions = seen.get(turn.groupId) ?? new Set<string>()
      partitions.add(partition)
      seen.set(turn.groupId, partitions)
    }
  }
  return seen
}

describe("groupedTimeSplit", () => {
  it("[ACC:EVAL-01] keeps every session in one partition and holds out the latest window as test", () => {
    const split = groupedTimeSplit(turns(), {
      seed: 42,
      testFraction: 0.2,
      calibrationFraction: 0.25,
    })

    // Multi-turn sessions and repeated samples never cross partitions.
    for (const [, partitions] of partitionOfEveryGroup(split)) expect(partitions.size).toBe(1)
    const assigned = [
      ...split.groups.train,
      ...split.groups.calibration,
      ...split.groups.test,
      ...split.groups.excluded,
    ]
    expect(new Set(assigned).size).toBe(assigned.length)
    expect(assigned.sort()).toEqual(SESSIONS.map(([id]) => id).sort())

    // The test set is the latest window (the two latest-starting sessions),
    // strictly after every train and calibration sample.
    expect(split.testStartsAt).toBe(9000)
    expect(split.groups.test).toEqual(["I", "J"])
    const start = split.testStartsAt as number
    expect(split.test.every((turn) => turn.timestamp >= start)).toBe(true)
    expect([...split.train, ...split.calibration].every((turn) => turn.timestamp < start)).toBe(
      true
    )
    expect(
      Math.max(...[...split.train, ...split.calibration].map((turn) => turn.timestamp))
    ).toBeLessThan(Math.min(...split.test.map((turn) => turn.timestamp)))

    // A session that straddles the cutoff can sit on neither side: purged.
    expect(split.groups.excluded).toEqual(["E"])
    expect(split.excluded.map((turn) => turn.id)).toEqual(["E-0", "E-1", "E-2"])

    // round(0.25 × 7 pre-window sessions) = 2 calibration sessions.
    expect(split.groups.calibration).toHaveLength(2)
    expect(split.groups.train).toHaveLength(5)
    expect(verifyGroupedTimeSplit(split)).toEqual([])
  })

  it("[ACC:EVAL-01] holds the invariants on a large multi-turn log for every seed", () => {
    const random = createSeededRandom(2026)
    const log: Turn[] = []
    for (let session = 0; session < 200; session++) {
      const start = Math.floor(random() * 1_000_000)
      const count = 1 + Math.floor(random() * 6)
      let at = start
      for (let turn = 0; turn < count; turn++) {
        at += Math.floor(random() * 5_000)
        log.push({ id: `s${session}-t${turn}`, groupId: `s${session}`, timestamp: at })
        // Repeated sampling of the same decision.
        if (random() < 0.2)
          log.push({ id: `s${session}-t${turn}-r`, groupId: `s${session}`, timestamp: at })
      }
    }
    for (const seed of [1, 2, 3, 99, 12345]) {
      const split = groupedTimeSplit(log, { seed })
      expect(verifyGroupedTimeSplit(split)).toEqual([])
      for (const [, partitions] of partitionOfEveryGroup(split)) expect(partitions.size).toBe(1)
      expect(split.test.length).toBeGreaterThan(0)
      expect(split.calibration.length).toBeGreaterThan(0)
      expect(split.train.length).toBeGreaterThan(0)
      expect(
        split.train.length + split.calibration.length + split.test.length + split.excluded.length
      ).toBe(log.length)
    }
  })

  it("is a pure function of the samples and the seed, whatever their order", () => {
    const ordered = turns()
    const reversed = [...ordered].reverse()
    const shuffled = seededShuffle(ordered, 5)
    const first = groupedTimeSplit(ordered, { seed: 7 })
    expect(groupedTimeSplit(ordered, { seed: 7 }).groups).toEqual(first.groups)
    expect(groupedTimeSplit(reversed, { seed: 7 }).groups).toEqual(first.groups)
    expect(groupedTimeSplit(shuffled, { seed: 7 }).groups).toEqual(first.groups)
  })

  it("lets the seed move calibration sessions but never the test window", () => {
    const calibrationSets = new Set<string>()
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const split = groupedTimeSplit(turns(), { seed })
      expect(split.groups.test).toEqual(["I", "J"])
      expect(split.groups.excluded).toEqual(["E"])
      calibrationSets.add(split.groups.calibration.join(","))
    }
    expect(calibrationSets.size).toBeGreaterThan(1)
  })

  it("honours an explicit test window start", () => {
    const split = groupedTimeSplit(turns(), { seed: 1, testStartsAt: 8000 })
    expect(split.testFraction).toBeNull()
    expect(split.testStartsAt).toBe(8000)
    expect(split.groups.test).toEqual(["H", "I", "J"])
    expect(split.groups.excluded).toEqual(["E"])
    expect(verifyGroupedTimeSplit(split)).toEqual([])
  })

  it("cuts no test window and no calibration set when their fractions are zero", () => {
    const split = groupedTimeSplit(turns(), { seed: 1, testFraction: 0, calibrationFraction: 0 })
    expect(split.testStartsAt).toBeNull()
    expect(split.test).toEqual([])
    expect(split.calibration).toEqual([])
    expect(split.excluded).toEqual([])
    expect(split.train).toHaveLength(turns().length)
  })

  it("keeps a lone session for training rather than splitting it", () => {
    const split = groupedTimeSplit(turns([["only", [1, 2, 3]]]), { seed: 1 })
    expect(split.groups.train).toEqual(["only"])
    expect(split.test).toEqual([])
    expect(split.calibration).toEqual([])
  })

  it("rejects malformed samples and options", () => {
    expect(() => groupedTimeSplit([{ groupId: "", timestamp: 1 }], { seed: 1 })).toThrow(
      expect.objectContaining({ code: "INVALID_SAMPLE" })
    )
    expect(() => groupedTimeSplit([{ groupId: "a", timestamp: Number.NaN }], { seed: 1 })).toThrow(
      expect.objectContaining({ code: "INVALID_SAMPLE" })
    )
    expect(() => groupedTimeSplit([], { seed: 1.5 })).toThrow(
      expect.objectContaining({ code: "INVALID_OPTION" })
    )
    expect(() => groupedTimeSplit([], { seed: 1, testFraction: 1 })).toThrow(
      expect.objectContaining({ code: "INVALID_OPTION" })
    )
    expect(() => groupedTimeSplit([], { seed: 1, calibrationFraction: -0.1 })).toThrow(
      expect.objectContaining({ code: "INVALID_OPTION" })
    )
  })
})

describe("verifyGroupedTimeSplit", () => {
  it("reports a session in two partitions and a test window that overlaps training", () => {
    const split = groupedTimeSplit(turns(), { seed: 3 })
    const trainGroup = split.groups.train[0]
    const leaked: GroupedTimeSplit<Turn> = {
      ...split,
      test: [...split.test, { id: "leak", groupId: trainGroup, timestamp: 9999 }],
      groups: { ...split.groups, test: [...split.groups.test, trainGroup] },
    }
    const problems = verifyGroupedTimeSplit(leaked)
    expect(problems.join("\n")).toMatch(new RegExp(`group ${trainGroup} is in both train and test`))

    const early: GroupedTimeSplit<Turn> = {
      ...split,
      test: [...split.test, { id: "early", groupId: "I", timestamp: 10 }],
    }
    expect(verifyGroupedTimeSplit(early)).toContain("a test sample precedes the test window")
  })
})

describe("seeded randomness", () => {
  it("shuffles deterministically without mutating the input", () => {
    const items = ["a", "b", "c", "d", "e", "f"]
    const copy = [...items]
    const first = seededShuffle(items, 11)
    expect(seededShuffle(items, 11)).toEqual(first)
    expect([...first].sort()).toEqual(items)
    expect(items).toEqual(copy)
    const draws = createSeededRandom(4)
    const again = createSeededRandom(4)
    for (let i = 0; i < 10; i++) {
      const value = draws()
      expect(value).toBe(again())
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})
