import { createDeadlockHandler, type DeadlockGateDeps } from "./deadlock-gate"
import type { TeamNotifier, TeamNotifyPayload } from "./team-notifier"
import type { ConcurrencyController } from "@/lib/workflow/runtime/concurrency-controller"
import type { TeammatePool } from "./teammate-pool"
import type { SquadReviewOutcome } from "./squad-review-gate"

function makeDeps(over: Partial<DeadlockGateDeps> = {}): {
  deps: DeadlockGateDeps
  notify: jest.Mock
  reduceTo: jest.Mock
  forceUnquarantine: jest.Mock
  abort: jest.Mock
  openReview: jest.Mock
  resolveDecision: (d: SquadReviewOutcome) => void
} {
  const notify = jest.fn()
  const reduceTo = jest.fn()
  const forceUnquarantine = jest.fn()
  const abort = jest.fn()
  let resolveDecision!: (d: SquadReviewOutcome) => void
  const openReview = jest.fn(
    () => new Promise<SquadReviewOutcome>((res) => (resolveDecision = res))
  )
  const deps: DeadlockGateDeps = {
    recovery: true,
    runId: "run-1",
    teamId: "team-1",
    projectId: "ws-1",
    notifier: { notify, suspend: jest.fn(), resume: jest.fn() } as TeamNotifier,
    concurrency: { reduceTo } as unknown as ConcurrencyController,
    pool: { forceUnquarantine } as unknown as TeammatePool,
    signal: new AbortController().signal,
    abort,
    openReview: openReview as unknown as DeadlockGateDeps["openReview"],
    ...over,
  }
  return {
    deps,
    notify,
    reduceTo,
    forceUnquarantine,
    abort,
    openReview,
    resolveDecision: (d) => resolveDecision(d),
  }
}

describe("createDeadlockHandler", () => {
  it("fast-fails (no gate) and aborts when recovery is disabled", () => {
    const { deps, notify, reduceTo, abort, openReview } = makeDeps({ recovery: false })
    const handler = createDeadlockHandler(deps)
    handler()
    const payload = notify.mock.calls[0][0] as TeamNotifyPayload
    expect(payload.level).toBe("critical")
    expect(openReview).not.toHaveBeenCalled()
    expect(reduceTo).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
    expect((abort.mock.calls[0][0] as Error).message).toMatch(/recovery disabled/i)
  })

  it("fast-fails with a headless message when the gate policy is not block", () => {
    const { deps, notify, reduceTo, abort, openReview } = makeDeps({
      recovery: true,
      behavior: "fail-fast",
    })
    createDeadlockHandler(deps)()
    const payload = notify.mock.calls[0][0] as TeamNotifyPayload
    expect(payload.level).toBe("critical")
    expect(payload.body).toMatch(/headless/i)
    expect(openReview).not.toHaveBeenCalled()
    expect(reduceTo).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
    expect((abort.mock.calls[0][0] as Error).message).toMatch(/headless/i)
  })

  it("still opens the review when behavior is explicitly block", () => {
    const { deps, openReview, abort } = makeDeps({ recovery: true, behavior: "block" })
    createDeadlockHandler(deps)()
    expect(openReview).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", teamId: "team-1", projectId: "ws-1" })
    )
    expect(abort).not.toHaveBeenCalled()
  })

  /** The durable interrupt IS the ask. The notification only points at it. */
  it("opens the durable review and freezes concurrency when recovery is enabled", () => {
    const { deps, notify, reduceTo, abort, openReview } = makeDeps({ recovery: true })
    createDeadlockHandler(deps)()
    const payload = notify.mock.calls[0][0] as TeamNotifyPayload
    expect(payload.level).toBe("critical")
    expect(openReview).toHaveBeenCalledTimes(1)
    expect(reduceTo).toHaveBeenCalledWith(0)
    expect(abort).not.toHaveBeenCalled()
  })

  it("unquarantines the selected teammates on approve", async () => {
    const { deps, forceUnquarantine, resolveDecision } = makeDeps({ recovery: true })
    createDeadlockHandler(deps)()
    resolveDecision({ kind: "deadlock", outcome: "approve", teammateIds: ["w1"] })
    await Promise.resolve()
    await Promise.resolve()
    expect(forceUnquarantine).toHaveBeenCalledWith({ teammateIds: ["w1"] })
  })

  it("resets everyone when the decision says so", async () => {
    const { deps, forceUnquarantine, resolveDecision } = makeDeps({ recovery: true })
    createDeadlockHandler(deps)()
    resolveDecision({ kind: "deadlock", outcome: "approve", resetAll: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(forceUnquarantine).toHaveBeenCalledWith({ resetAll: true })
  })

  it("aborts the run when the operator denies", async () => {
    const { deps, abort, resolveDecision } = makeDeps({ recovery: true })
    createDeadlockHandler(deps)()
    resolveDecision({ kind: "deadlock", outcome: "deny", resetAll: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(abort).toHaveBeenCalledTimes(1)
    expect((abort.mock.calls[0][0] as Error).message).toBe("deadlock_aborted_by_operator")
  })

  it("no-ops when the signal is already aborted", () => {
    const ac = new AbortController()
    ac.abort()
    const { deps, notify } = makeDeps({ recovery: true, signal: ac.signal })
    createDeadlockHandler(deps)()
    expect(notify).not.toHaveBeenCalled()
  })

  it("is re-entrancy-safe while a recovery decision is pending", () => {
    const { deps, notify, openReview } = makeDeps({ recovery: true })
    const handler = createDeadlockHandler(deps)
    handler()
    handler()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(openReview).toHaveBeenCalledTimes(1)
  })
})
