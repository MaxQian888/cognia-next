import type { HarnessEvolutionRun, HarnessEvolutionStep } from "@/types/harness/evolution"
import { makeRun, makeRunConfig } from "../test-fixtures"
import { HarnessRunCancelledError } from "./driver"
import {
  HARNESS_APPROVAL_REF_KIND,
  HARNESS_RUN_RESPOND_COMMAND,
  approveHarnessRun,
  cancelHarnessRun,
  harnessRunHref,
  installHarnessNotificationActions,
  isHarnessRunActiveHere,
  launchHarnessRun,
  notifyHarnessApproval,
  recoverOrphanedHarnessRuns,
  rejectHarnessRun,
  resumeHarnessRun,
  rollbackHarnessRun,
  type HarnessRunControlDeps,
} from "./run-control"

const drive = jest.fn()
const approveWith = jest.fn()
jest.mock("./driver", () => {
  const actual = jest.requireActual("./driver")
  return {
    ...actual,
    driveHarnessRun: (...args: unknown[]) => drive(...args),
    approveHarnessRunWith: (...args: unknown[]) => approveWith(...args),
  }
})

interface World {
  runs: Map<string, HarnessEvolutionRun>
  steps: HarnessEvolutionStep[]
  dismissed: string[]
  rolledBack: string[]
}

function world(runs: HarnessEvolutionRun[]): World {
  return { runs: new Map(runs.map((r) => [r.id, r])), steps: [], dismissed: [], rolledBack: [] }
}

function deps(w: World): HarnessRunControlDeps {
  return {
    driver: async () => ({}) as never,
    store: {
      getRun: async (id) => w.runs.get(id),
      saveRun: async (next, expected) => {
        if (w.runs.get(next.id)?.version !== expected) throw new Error("conflict")
        w.runs.set(next.id, next)
        return next
      },
      listOrphanedRuns: async (now) =>
        [...w.runs.values()].filter(
          (r) =>
            ["probing", "proposing", "reflecting"].includes(r.status) &&
            (!r.owner || r.owner.leaseExpiresAt <= now)
        ),
      listSteps: async (runId) => w.steps.filter((s) => s.runId === runId),
      putStep: async (step) => {
        w.steps = w.steps.map((s) => (s.id === step.id ? step : s))
      },
    },
    rollback: async (run) => {
      w.rolledBack.push(run.id)
      return { ...(run.adoption as NonNullable<HarnessEvolutionRun["adoption"]>), rolledBackAt: 50 }
    },
    dismissApproval: async (runId) => void w.dismissed.push(runId),
    now: () => 100,
  }
}

const runningStep: HarnessEvolutionStep = {
  id: "run-1:base1",
  runId: "run-1",
  label: "base1",
  kind: "rollout",
  status: "running",
  attempts: 1,
  inputTokens: 0,
  outputTokens: 0,
  modelCalls: 0,
  updatedAt: 1,
}

beforeEach(() => {
  drive.mockReset()
  approveWith.mockReset()
})

describe("launch and cancel", () => {
  it("drives a run once per process and cancels through its driver", async () => {
    const w = world([makeRun({ status: "probing" })])
    let seen: AbortSignal | undefined
    drive.mockImplementation(
      (_id: string, _deps: unknown, options: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          seen = options.signal
          options.signal.addEventListener("abort", () =>
            resolve({ ...w.runs.get("run-1"), status: "cancelled" })
          )
        })
    )
    const d = deps(w)
    const first = launchHarnessRun("run-1", d)
    expect(launchHarnessRun("run-1", d)).toBe(first)
    await Promise.resolve()
    expect(isHarnessRunActiveHere("run-1")).toBe(true)
    const cancelled = await cancelHarnessRun("run-1", d)
    expect(seen?.reason).toBeInstanceOf(HarnessRunCancelledError)
    expect(cancelled?.status).toBe("cancelled")
    expect(isHarnessRunActiveHere("run-1")).toBe(false)
    expect(drive).toHaveBeenCalledTimes(1)
    expect(w.dismissed).toEqual(["run-1"])
  })

  it("cancels a run driven elsewhere by writing it", async () => {
    const w = world([
      makeRun({ status: "probing", owner: { ownerId: "other", leaseExpiresAt: 10 ** 12 } }),
    ])
    w.steps = [runningStep]
    const run = await cancelHarnessRun("run-1", deps(w))
    expect(run?.status).toBe("cancelled")
    expect(run?.owner).toBeUndefined()
    expect(w.steps[0].status).toBe("interrupted")
    expect(w.dismissed).toEqual(["run-1"])
    // A finished run is left as it is.
    expect((await cancelHarnessRun("run-1", deps(w)))?.status).toBe("cancelled")
  })
})

describe("resume", () => {
  it("resumes interrupted or stalled runs only", async () => {
    drive.mockResolvedValue(undefined)
    const w = world([
      makeRun({ id: "a", status: "interrupted" }),
      makeRun({ id: "b", status: "probing", owner: { ownerId: "x", leaseExpiresAt: 10 } }),
      makeRun({ id: "c", status: "probing", owner: { ownerId: "x", leaseExpiresAt: 10 ** 12 } }),
      makeRun({ id: "d", status: "awaiting_approval" }),
      makeRun({ id: "e", status: "completed" }),
    ])
    const d = deps(w)
    await resumeHarnessRun("a", d)
    await resumeHarnessRun("b", d)
    expect(drive.mock.calls.map((c) => c[0])).toEqual(["a", "b"])
    for (const id of ["c", "d", "e"]) {
      await expect(resumeHarnessRun(id, d)).rejects.toMatchObject({ code: "not-resumable" })
    }
    await expect(resumeHarnessRun("missing", d)).rejects.toMatchObject({ code: "not-found" })
  })
})

describe("approval", () => {
  it("approves through the driver and withdraws the notification", async () => {
    const w = world([makeRun({ status: "awaiting_approval" })])
    approveWith.mockResolvedValueOnce({ ...makeRun(), status: "completed" })
    const run = await approveHarnessRun("run-1", { setAsWorkspaceDefault: true }, deps(w))
    expect(run.status).toBe("completed")
    expect(approveWith.mock.calls[0][2]).toEqual({ setAsWorkspaceDefault: true })
    expect(w.dismissed).toEqual(["run-1"])
    approveWith.mockResolvedValueOnce(null)
    await expect(approveHarnessRun("run-1", {}, deps(w))).rejects.toMatchObject({
      code: "not-awaiting",
    })
  })

  it("rejects only a run that waits for approval", async () => {
    const w = world([
      makeRun({ status: "awaiting_approval" }),
      makeRun({ id: "b", status: "probing" }),
    ])
    expect((await rejectHarnessRun("run-1", deps(w)))?.status).toBe("rejected")
    expect(w.dismissed).toEqual(["run-1"])
    await expect(rejectHarnessRun("b", deps(w))).rejects.toMatchObject({ code: "not-awaiting" })
  })

  it("rolls back a completed adoption", async () => {
    const adopted = makeRun({
      status: "completed",
      adoption: { scope: "global", approvedBy: "person", adoptedAt: 10, applyId: "apply-1" },
    })
    const w = world([adopted, makeRun({ id: "b", status: "completed" })])
    const run = await rollbackHarnessRun("run-1", deps(w))
    expect(run?.status).toBe("rolled_back")
    expect(run?.adoption?.rolledBackAt).toBe(50)
    expect(w.rolledBack).toEqual(["run-1"])
    await expect(rollbackHarnessRun("b", deps(w))).rejects.toMatchObject({ code: "not-adopted" })
  })
})

describe("recoverOrphanedHarnessRuns", () => {
  it("marks runs whose driver died as interrupted, without resuming them", async () => {
    const w = world([
      makeRun({ id: "run-1", status: "probing", owner: { ownerId: "dead", leaseExpiresAt: 50 } }),
      makeRun({ id: "live", status: "probing", owner: { ownerId: "x", leaseExpiresAt: 10 ** 12 } }),
    ])
    w.steps = [runningStep]
    expect(await recoverOrphanedHarnessRuns(deps(w))).toEqual(["run-1"])
    expect(w.runs.get("run-1")).toMatchObject({ status: "interrupted" })
    expect(w.runs.get("run-1")?.owner).toBeUndefined()
    expect(w.runs.get("live")?.status).toBe("probing")
    expect(w.steps[0]).toMatchObject({
      status: "interrupted",
      error: expect.stringMatching(/app stopped/),
    })
    expect(drive).not.toHaveBeenCalled()
  })
})

describe("approval notification", () => {
  it("offers approve and reject inline, except at workspace scope", async () => {
    const sent: Parameters<
      NonNullable<Parameters<typeof notifyHarnessApproval>[1]>["notify"]
    >[0][] = []
    const notify = async (input: (typeof sent)[number]) => {
      sent.push(input)
      return "n1"
    }
    const run = makeRun({
      status: "awaiting_approval",
      projectId: "proj-1",
      decision: {
        outcome: "adopt",
        reason: "agg1 dominated",
        risk: "medium",
        requiresApproval: true,
      },
    })
    await notifyHarnessApproval(run, { notify })
    expect(sent[0]).toMatchObject({
      href: harnessRunHref("run-1"),
      dedupeKey: "harness-approval:run-1",
      directed: true,
      projectId: "proj-1",
      sourceRef: { kind: HARNESS_APPROVAL_REF_KIND, id: "run-1" },
    })
    expect(sent[0].body).toBe("Risk: medium. Scope: task. agg1 dominated")
    expect(sent[0].actions.map((a) => a.args)).toEqual([
      { runId: "run-1", decision: "approve" },
      { runId: "run-1", decision: "reject" },
    ])
    await notifyHarnessApproval(
      { ...run, config: makeRunConfig({ scope: "workspace" }) },
      { notify }
    )
    expect(sent[1].actions).toEqual([])
    // Delivery failures never escape.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    await expect(
      notifyHarnessApproval(run, {
        notify: async () => {
          throw new Error("down")
        },
      })
    ).resolves.toBeUndefined()
    warn.mockRestore()
  })

  it("routes the notification's actions to approve and reject", async () => {
    const { dispatchNotificationCommand } = await import("@/lib/notifications/action-registry")
    const w = world([
      makeRun({ status: "awaiting_approval" }),
      makeRun({ id: "b", status: "awaiting_approval" }),
    ])
    approveWith.mockResolvedValueOnce({ ...makeRun(), status: "completed" })
    const dispose = await installHarnessNotificationActions(deps(w))
    await dispatchNotificationCommand({
      notificationId: "n1",
      command: HARNESS_RUN_RESPOND_COMMAND,
      args: { runId: "run-1", decision: "approve" },
    })
    expect(approveWith).toHaveBeenCalledTimes(1)
    await dispatchNotificationCommand({
      notificationId: "n2",
      command: HARNESS_RUN_RESPOND_COMMAND,
      args: { runId: "b", decision: "reject" },
    })
    expect(w.runs.get("b")?.status).toBe("rejected")
    dispose()
  })
})
