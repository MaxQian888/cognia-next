import { createDeadlockHandler, type DeadlockGateDeps } from "./deadlock-gate"
import type { TeamNotifier, TeamNotifyPayload } from "./team-notifier"
import type { ConcurrencyController } from "@/lib/workflow/runtime/concurrency-controller"
import type { TeammatePool } from "./teammate-pool"
import type { ApprovalDecision } from "@/lib/runtime/approval-bus"

function makeDeps(over: Partial<DeadlockGateDeps> = {}): {
  deps: DeadlockGateDeps
  notify: jest.Mock
  reduceTo: jest.Mock
  forceUnquarantine: jest.Mock
  abort: jest.Mock
  resolveDecision: (d: ApprovalDecision) => void
} {
  const notify = jest.fn()
  const reduceTo = jest.fn()
  const forceUnquarantine = jest.fn()
  const abort = jest.fn()
  let resolveDecision!: (d: ApprovalDecision) => void
  const waitForDecision = jest.fn(
    () => new Promise<ApprovalDecision>((res) => (resolveDecision = res))
  )
  const deps: DeadlockGateDeps = {
    recovery: true,
    runId: "run-1",
    teamId: "team-1",
    notifier: { notify, suspend: jest.fn(), resume: jest.fn() } as TeamNotifier,
    concurrency: { reduceTo } as unknown as ConcurrencyController,
    pool: { forceUnquarantine } as unknown as TeammatePool,
    signal: new AbortController().signal,
    abort,
    waitForDecision: waitForDecision as unknown as DeadlockGateDeps["waitForDecision"],
    ...over,
  }
  return {
    deps,
    notify,
    reduceTo,
    forceUnquarantine,
    abort,
    resolveDecision: (d) => resolveDecision(d),
  }
}

describe("createDeadlockHandler", () => {
  it("fast-fails (no gate) and aborts when recovery is disabled", () => {
    const { deps, notify, reduceTo, abort } = makeDeps({ recovery: false })
    const handler = createDeadlockHandler(deps)
    handler()
    const payload = notify.mock.calls[0][0] as TeamNotifyPayload
    expect(payload.level).toBe("critical")
    expect(payload.openApproval).toBeUndefined()
    expect(reduceTo).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
    expect((abort.mock.calls[0][0] as Error).message).toMatch(/recovery disabled/i)
  })

  it("opens the HITL gate and freezes concurrency when recovery is enabled", () => {
    const { deps, notify, reduceTo, abort } = makeDeps({ recovery: true })
    createDeadlockHandler(deps)()
    const payload = notify.mock.calls[0][0] as TeamNotifyPayload
    expect(payload.openApproval).toEqual({ scope: "agent-team-deadlock", id: "run-1" })
    expect(reduceTo).toHaveBeenCalledWith(0)
    expect(abort).not.toHaveBeenCalled()
  })

  it("unquarantines per the approved plan", async () => {
    const { deps, forceUnquarantine, resolveDecision } = makeDeps({ recovery: true })
    createDeadlockHandler(deps)()
    resolveDecision({ outcome: "approve", plan: { teammateIds: ["w1"] } } as ApprovalDecision)
    await Promise.resolve()
    await Promise.resolve()
    expect(forceUnquarantine).toHaveBeenCalledWith({ teammateIds: ["w1"] })
  })

  it("aborts the run when the operator rejects", async () => {
    const { deps, abort, resolveDecision } = makeDeps({ recovery: true })
    createDeadlockHandler(deps)()
    resolveDecision({ outcome: "reject" } as ApprovalDecision)
    await Promise.resolve()
    await Promise.resolve()
    expect(abort).toHaveBeenCalledTimes(1)
    expect((abort.mock.calls[0][0] as Error).message).toMatch(/Operator aborted/i)
  })

  it("no-ops when the signal is already aborted", () => {
    const ac = new AbortController()
    ac.abort()
    const { deps, notify } = makeDeps({ recovery: true, signal: ac.signal })
    createDeadlockHandler(deps)()
    expect(notify).not.toHaveBeenCalled()
  })

  it("is re-entrancy-safe while a recovery decision is pending", () => {
    const { deps, notify } = makeDeps({ recovery: true })
    const handler = createDeadlockHandler(deps)
    handler()
    handler()
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
