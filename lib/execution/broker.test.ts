import {
  DEFAULT_AI_TURN_LIMIT,
  ExecutionAbortError,
  ExecutionBroker,
  __resetExecutionBrokerForTesting,
  getExecutionBroker,
} from "./broker"
import type { ExecutionBrokerEvent, ExecutionLeaseRequest } from "./types"

/** Build a broker with deterministic ids + a small default limit for tests. */
function makeBroker(limit = 2): ExecutionBroker {
  let seq = 0
  return new ExecutionBroker({
    limits: { "ai-turn": limit },
    idFactory: () => `leg${++seq}`,
  })
}

const req = (overrides: Partial<ExecutionLeaseRequest> = {}): ExecutionLeaseRequest => ({
  kind: "connector",
  label: "test leg",
  ...overrides,
})

describe("ExecutionBroker — admission", () => {
  it("admits up to the limit immediately and queues beyond it", async () => {
    const broker = makeBroker(2)
    const a = await broker.acquire(req())
    const b = await broker.acquire(req())
    expect(broker.permitsInUse()).toBe(2)
    expect(broker.availablePermits()).toBe(0)

    // Third does not fit — stays queued (pending promise).
    let cResolved = false
    const cPromise = broker.acquire(req()).then((lease) => {
      cResolved = true
      return lease
    })
    await Promise.resolve()
    expect(cResolved).toBe(false)
    expect(broker.list().some((l) => l.state === "queued")).toBe(true)
    expect(broker.countRunning()).toBe(2)

    // Releasing one drains the queue.
    a.release("ok")
    const c = await cPromise
    expect(cResolved).toBe(true)
    expect(c.id).toBeDefined()
    expect(broker.permitsInUse()).toBe(2)

    b.release("ok")
    c.release("ok")
    expect(broker.permitsInUse()).toBe(0)
    expect(broker.list()).toHaveLength(0)
  })

  it("honours admission weight", async () => {
    const broker = makeBroker(3)
    const heavy = await broker.acquire(req({ weight: 3 }))
    expect(broker.availablePermits()).toBe(0)

    let lightAdmitted = false
    const lightPromise = broker.acquire(req({ weight: 1 })).then((l) => {
      lightAdmitted = true
      return l
    })
    await Promise.resolve()
    expect(lightAdmitted).toBe(false)

    heavy.release("ok")
    const light = await lightPromise
    expect(lightAdmitted).toBe(true)
    light.release("ok")
  })

  it("clamps invalid weights to 1", async () => {
    const broker = makeBroker(2)
    const lease = await broker.acquire(req({ weight: 0 }))
    expect(lease.weight).toBe(1)
    const lease2 = await broker.acquire(req({ weight: Number.NaN }))
    expect(lease2.weight).toBe(1)
  })

  it("drains queue in FIFO order with head-of-line blocking", async () => {
    const broker = makeBroker(2)
    const a = await broker.acquire(req({ label: "a" }))
    const b = await broker.acquire(req({ label: "b" }))

    const order: string[] = []
    const heavy = broker.acquire(req({ label: "heavy", weight: 2 })).then((l) => {
      order.push("heavy")
      return l
    })
    const small = broker.acquire(req({ label: "small", weight: 1 })).then((l) => {
      order.push("small")
      return l
    })
    await Promise.resolve()

    // Free one permit: head (weight 2) still doesn't fit, so `small` must NOT
    // jump ahead (head-of-line blocking keeps order deterministic).
    a.release("ok")
    await Promise.resolve()
    expect(order).toEqual([])

    // Free the second permit: head fits now.
    b.release("ok")
    const heavyLease = await heavy
    expect(order).toEqual(["heavy"])
    heavyLease.release("ok")
    const smallLease = await small
    expect(order).toEqual(["heavy", "small"])
    smallLease.release("ok")
  })
})

describe("ExecutionBroker — continuation exemption", () => {
  it("admits a continuation of an already-active session immediately without a permit", async () => {
    const broker = makeBroker(1)
    const first = await broker.acquire(req({ sessionId: "s1" }))
    expect(broker.permitsInUse()).toBe(1)
    expect(broker.availablePermits()).toBe(0)

    // Same session again — would normally have to queue (limit 1, in use 1),
    // but a continuation is exempt: admitted now, consumes no permit.
    const second = await broker.acquire(req({ sessionId: "s1" }))
    expect(second.exempt).toBe(true)
    expect(broker.permitsInUse()).toBe(1)
    expect(broker.countRunning()).toBe(2)

    second.release("ok")
    first.release("ok")
  })

  it("does NOT exempt the first turn of a fresh session", async () => {
    const broker = makeBroker(1)
    const a = await broker.acquire(req({ sessionId: "busy" }))
    expect(a.exempt).toBe(false)

    // Different session — must queue behind the full pool.
    let admitted = false
    broker.acquire(req({ sessionId: "other" })).then(() => {
      admitted = true
    })
    await Promise.resolve()
    expect(admitted).toBe(false)
    a.release("ok")
  })

  it("honours an explicit exempt flag", async () => {
    const broker = makeBroker(1)
    const a = await broker.acquire(req())
    const exempt = await broker.acquire(req({ exempt: true }))
    expect(exempt.exempt).toBe(true)
    expect(broker.permitsInUse()).toBe(1)
    a.release("ok")
    exempt.release("ok")
  })

  it("isAtCapacity reflects the pool but never blocks a continuation", async () => {
    const broker = makeBroker(1)
    expect(broker.isAtCapacity()).toBe(false)
    const a = await broker.acquire(req({ sessionId: "s1" }))
    expect(broker.isAtCapacity()).toBe(true)
    // The already-active session is a continuation → not at capacity for it.
    expect(broker.isAtCapacity("ai-turn", "s1")).toBe(false)
    expect(broker.isAtCapacity("ai-turn", "fresh")).toBe(true)
    a.release("ok")
    expect(broker.isAtCapacity()).toBe(false)
  })
})

describe("ExecutionBroker — cancellation", () => {
  it("cancels a running leg: aborts its signal and reports cancelled on release", async () => {
    const broker = makeBroker(2)
    const events: ExecutionBrokerEvent[] = []
    broker.onEvent((e) => events.push(e))

    const lease = await broker.acquire(req())
    let aborted = false
    lease.signal.addEventListener("abort", () => {
      aborted = true
    })

    expect(broker.cancel(lease.id)).toBe(true)
    expect(aborted).toBe(true)
    expect(lease.cancelled).toBe(true)

    // The wrapped turn rejects and the caller releases — outcome is cancelled.
    lease.release("ok")
    const completed = events.find((e) => e.type === "leg-completed")
    expect(completed).toMatchObject({ type: "leg-completed", outcome: "cancelled" })
    expect(broker.permitsInUse()).toBe(0)
  })

  it("cancelling a queued leg rejects its acquire promise and frees nothing", async () => {
    const broker = makeBroker(1)
    const a = await broker.acquire(req())
    const queued = broker.acquire(req())
    await Promise.resolve()

    const queuedId = broker.list().find((l) => l.state === "queued")?.id
    expect(queuedId).toBeDefined()
    expect(broker.cancel(queuedId!)).toBe(true)

    await expect(queued).rejects.toBeInstanceOf(ExecutionAbortError)
    // The running leg `a` still holds its permit.
    expect(broker.permitsInUse()).toBe(1)
    a.release("ok")
  })

  it("cancel is idempotent and returns false on unknown / already-cancelled", async () => {
    const broker = makeBroker(2)
    const lease = await broker.acquire(req())
    expect(broker.cancel("nope")).toBe(false)
    expect(broker.cancel(lease.id)).toBe(true)
    expect(broker.cancel(lease.id)).toBe(false)
    lease.release("ok")
    expect(broker.cancel(lease.id)).toBe(false)
  })

  it("cancelBySession / cancelByProject / cancelAll cancel matching legs", async () => {
    const broker = makeBroker(8)
    const s1a = await broker.acquire(req({ sessionId: "s1", projectId: "p1" }))
    const s1b = await broker.acquire(req({ sessionId: "s1", projectId: "p1" }))
    const s2 = await broker.acquire(req({ sessionId: "s2", projectId: "p2" }))

    // s1b is a continuation of s1 (exempt) but still cancellable.
    expect(broker.cancelBySession("s1")).toBe(2)
    expect(s1a.cancelled).toBe(true)
    expect(s1b.cancelled).toBe(true)
    s1a.release("ok")
    s1b.release("ok")

    expect(broker.cancelByProject("p2")).toBe(1)
    expect(s2.cancelled).toBe(true)
    s2.release("ok")

    const c = await broker.acquire(req())
    const d = await broker.acquire(req())
    expect(broker.cancelAll()).toBe(2)
    c.release("ok")
    d.release("ok")
    expect(broker.list()).toHaveLength(0)
  })

  it("aborting the caller's signal cancels the lease", async () => {
    const broker = makeBroker(2)
    const controller = new AbortController()
    const lease = await broker.acquire(req({ signal: controller.signal }))
    controller.abort()
    expect(lease.cancelled).toBe(true)
    expect(lease.signal.aborted).toBe(true)
    lease.release("ok")
  })

  it("rejects acquire when the caller's signal is already aborted", async () => {
    const broker = makeBroker(2)
    const controller = new AbortController()
    controller.abort()
    await expect(broker.acquire(req({ signal: controller.signal }))).rejects.toBeInstanceOf(
      ExecutionAbortError
    )
    expect(broker.list()).toHaveLength(0)
  })
})

describe("ExecutionBroker — limits & introspection", () => {
  it("defaults to DEFAULT_AI_TURN_LIMIT when no limits given", () => {
    const broker = new ExecutionBroker()
    expect(broker.getLimit()).toBe(DEFAULT_AI_TURN_LIMIT)
  })

  it("guarantees the default pool even when limits omit it", () => {
    const broker = new ExecutionBroker({ limits: {} })
    expect(broker.getLimit()).toBe(DEFAULT_AI_TURN_LIMIT)
    expect(broker.availablePermits()).toBe(DEFAULT_AI_TURN_LIMIT)
  })

  it("raising the limit drains queued waiters", async () => {
    const broker = makeBroker(1)
    const a = await broker.acquire(req())
    let admitted = false
    const queued = broker.acquire(req()).then((l) => {
      admitted = true
      return l
    })
    await Promise.resolve()
    expect(admitted).toBe(false)

    broker.setLimit("ai-turn", 2)
    const b = await queued
    expect(admitted).toBe(true)
    a.release("ok")
    b.release("ok")
  })

  it("clamps a sub-1 limit to 1", () => {
    const broker = makeBroker(1)
    broker.setLimit("ai-turn", 0)
    expect(broker.getLimit()).toBe(1)
  })

  it("countRunning / hasActiveSession filter correctly", async () => {
    const broker = makeBroker(4)
    expect(broker.hasActiveSession(undefined)).toBe(false)
    expect(broker.hasActiveSession("s1")).toBe(false)
    const a = await broker.acquire(req({ sessionId: "s1" }))
    expect(broker.hasActiveSession("s1")).toBe(true)
    expect(broker.countRunning("ai-turn")).toBe(1)
    a.release("ok")
    expect(broker.hasActiveSession("s1")).toBe(false)
  })
})

describe("ExecutionBroker — reactive snapshot", () => {
  it("returns a stable snapshot reference until a change occurs", async () => {
    const broker = makeBroker(2)
    const s1 = broker.list()
    expect(s1).toBe(broker.list())
    const lease = await broker.acquire(req())
    const s2 = broker.list()
    expect(s2).not.toBe(s1)
    expect(s2).toHaveLength(1)
    lease.release("ok")
  })

  it("notifies subscribers on registry changes", async () => {
    const broker = makeBroker(2)
    let calls = 0
    const unsub = broker.subscribe(() => {
      calls += 1
    })
    const lease = await broker.acquire(req())
    expect(calls).toBeGreaterThan(0)
    const before = calls
    lease.release("ok")
    expect(calls).toBeGreaterThan(before)
    unsub()
    const after = calls
    await broker.acquire(req())
    expect(calls).toBe(after)
  })

  it("getSnapshot mirrors list and sorts by startedAt", async () => {
    let t = 100
    const broker = new ExecutionBroker({
      limits: { "ai-turn": 4 },
      now: () => t++,
      idFactory: (() => {
        let n = 0
        return () => `leg${++n}`
      })(),
    })
    const a = await broker.acquire(req({ label: "first" }))
    const b = await broker.acquire(req({ label: "second" }))
    const snap = broker.getSnapshot()
    expect(snap.map((s) => s.label)).toEqual(["first", "second"])
    a.release("ok")
    b.release("ok")
  })

  it("a faulty subscriber never breaks admission", async () => {
    const broker = makeBroker(2)
    broker.subscribe(() => {
      throw new Error("boom")
    })
    const lease = await broker.acquire(req())
    expect(lease).toBeDefined()
    lease.release("ok")
  })

  it("onEvent returns a working unsubscribe and swallows faulty listeners", async () => {
    const broker = makeBroker(2)
    let good = 0
    broker.onEvent(() => {
      throw new Error("listener boom")
    })
    const unsub = broker.onEvent(() => {
      good += 1
    })
    const a = await broker.acquire(req())
    expect(good).toBeGreaterThan(0)
    unsub()
    const before = good
    a.release("ok")
    expect(good).toBe(before)
  })

  it("snapshot carries leg metadata", async () => {
    const broker = makeBroker(2)
    const lease = await broker.acquire(
      req({ kind: "workflow-step", sessionId: "s", runId: "r", taskId: "t", projectId: "p" })
    )
    const snap = broker.list()[0]
    expect(snap).toMatchObject({
      kind: "workflow-step",
      sessionId: "s",
      runId: "r",
      taskId: "t",
      projectId: "p",
      state: "running",
      cancelled: false,
    })
    lease.release("ok")
  })
})

describe("ExecutionBroker — singleton", () => {
  afterEach(() => {
    __resetExecutionBrokerForTesting()
  })

  it("returns a stable singleton", () => {
    const a = getExecutionBroker()
    const b = getExecutionBroker()
    expect(a).toBe(b)
  })

  it("reset installs a fresh instance and cancels in-flight legs", async () => {
    const first = getExecutionBroker()
    const lease = await first.acquire(req())
    __resetExecutionBrokerForTesting()
    // Old leg was cancelled as part of reset.
    expect(lease.cancelled).toBe(true)
    const second = getExecutionBroker()
    expect(second).not.toBe(first)
  })

  it("reset can install a provided broker", () => {
    const custom = makeBroker(5)
    __resetExecutionBrokerForTesting(custom)
    expect(getExecutionBroker()).toBe(custom)
  })
})
