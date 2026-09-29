import {
  PREWARM_LEAD_MS,
  PREWARM_MIN_LEAD_MS,
  getTaskPrewarmer,
  parsePrewarmAlarmId,
  planPrewarmAt,
  prewarmAlarmId,
  registerTaskPrewarmer,
  unregisterTaskPrewarmer,
} from "./prewarm"

describe("prewarm alarm ids", () => {
  it("round-trips a task id", () => {
    expect(parsePrewarmAlarmId(prewarmAlarmId("task-1"))).toBe("task-1")
  })

  it("does not claim an ordinary task id or an empty suffix", () => {
    expect(parsePrewarmAlarmId("task-1")).toBeNull()
    expect(parsePrewarmAlarmId("prewarm:")).toBeNull()
  })
})

describe("planPrewarmAt", () => {
  const now = 1_000_000

  it("prewarms the lead time ahead of a distant fire", () => {
    expect(planPrewarmAt(now + 60 * 60_000, now)).toBe(now + 60 * 60_000 - PREWARM_LEAD_MS)
  })

  it("prewarms right away when the fire is inside the lead", () => {
    expect(planPrewarmAt(now + 30_000, now)).toBe(now)
  })

  it("skips a fire too close to be worth a separate alarm", () => {
    expect(planPrewarmAt(now + PREWARM_MIN_LEAD_MS - 1, now)).toBeNull()
    expect(planPrewarmAt(now - 1, now)).toBeNull()
  })
})

describe("prewarmer registry", () => {
  afterEach(() => unregisterTaskPrewarmer("chat"))

  it("registers, replaces and unregisters by task type", () => {
    const first = jest.fn()
    const second = jest.fn()
    registerTaskPrewarmer("chat", first)
    expect(getTaskPrewarmer("chat")).toBe(first)
    registerTaskPrewarmer("chat", second)
    expect(getTaskPrewarmer("chat")).toBe(second)
    unregisterTaskPrewarmer("chat")
    expect(getTaskPrewarmer("chat")).toBeUndefined()
  })
})
