import { createCreatorRunState, runCreatorPipeline, runCreatorStep } from "./executor"
import type { CreatorHandlers, CreatorRunContext, RunStepDeps } from "./executor"
import type { CreatorRunLog } from "./run-log"
import { CREATOR_STEP_IDS } from "./steps"
import type { CreatorAdvanceState } from "./steps"
import type { AuthoringRoot, CreatorStepId } from "@/types/creator"

const root: AuthoringRoot = {
  path: "/work/authoring",
  label: "authoring",
  origin: "selected",
  grantedAt: 0,
}

function ctx(overrides: Partial<CreatorRunContext> = {}): CreatorRunContext {
  return {
    runId: "creator_1",
    root,
    artifactKind: "plugin",
    requirements: "do the thing",
    currentCapabilities: [],
    approvedAdditions: [],
    ...overrides,
  }
}

function handlers(overrides: Partial<CreatorHandlers> = {}): CreatorHandlers {
  return {
    collectRequirements: async () => ({ requirements: "collected" }),
    surveyExisting: async () => ({ findings: [] }),
    planScaffold: async () => ({
      files: [{ relativePath: "src/index.ts", contents: "export {}" }],
      capabilities: [],
    }),
    verify: async () => ({ lint: true, typecheck: true, build: true, contract: true }),
    preview: async () => ({ clean: true, leaked: [] }),
    review: async () => ({ findings: [], reviewerAuthority: "plan" }),
    deliver: async () => ({ delivered: "install" as const }),
    ...overrides,
  }
}

/** A full run-log double. Partial fakes hide missing calls behind a cast. */
/**
 * Call-recording stand-in for the run journal.
 *
 * The suite only ever asserts *that* an entry was written, never the
 * `WorkflowRunEventRow` the real journal resolves, so the doubles resolve
 * `undefined` and the shape is asserted to `CreatorRunLog` once here rather
 * than fabricating a dozen rows nothing reads. The intersection keeps the
 * `jest.Mock` surface (`toHaveBeenCalled`) available to the assertions.
 */
function fakeLog() {
  const journal = {
    runId: "creator_1",
    started: jest.fn(async () => undefined),
    stepStarted: jest.fn(async () => undefined),
    stepCompleted: jest.fn(async () => undefined),
    stepFailed: jest.fn(async () => undefined),
    stepSkipped: jest.fn(async () => undefined),
    permissionDiff: jest.fn(async () => undefined),
    approvalGranted: jest.fn(async () => undefined),
    approvalDenied: jest.fn(async () => undefined),
    fileWritten: jest.fn(async () => undefined),
    reviewVerdict: jest.fn(async () => undefined),
    completed: jest.fn(async () => undefined),
    failed: jest.fn(async () => undefined),
  }
  return journal as unknown as typeof journal & CreatorRunLog
}

function okOps() {
  const writes: string[] = []
  return {
    writes,
    ops: {
      writeText: async (path: string) => {
        writes.push(path)
      },
      mkdir: async () => {},
    },
  }
}

const before = (step: CreatorStepId): CreatorStepId[] =>
  CREATOR_STEP_IDS.slice(0, CREATOR_STEP_IDS.indexOf(step))

function deps(overrides: Partial<RunStepDeps> = {}): RunStepDeps {
  return {
    ctx: ctx(),
    handlers: handlers(),
    progress: { completed: [], approvals: [] },
    run: createCreatorRunState(),
    ops: okOps().ops,
    ...overrides,
  }
}

describe("runCreatorStep — gating", () => {
  it("refuses a step whose predecessor has not completed", async () => {
    const outcome = await runCreatorStep("apply-changes", deps())
    expect(outcome).toEqual({ status: "blocked", step: "apply-changes", reason: "out-of-order" })
  })

  it("reports the missing approval instead of running the gate step", async () => {
    const outcome = await runCreatorStep(
      "approve-permissions",
      deps({ progress: { completed: before("approve-permissions"), approvals: [] } })
    )
    expect(outcome).toEqual({
      status: "awaiting-approval",
      step: "approve-permissions",
      approval: "permission-widening",
    })
  })

  it("does not invoke a handler for a blocked step", async () => {
    const planScaffold = jest.fn()
    await runCreatorStep("plan-scaffold", deps({ handlers: handlers({ planScaffold }) }))
    expect(planScaffold).not.toHaveBeenCalled()
  })
})

describe("runCreatorStep — steps", () => {
  it("records the requirements collected at step 1", async () => {
    const d = deps()
    await runCreatorStep("collect-requirements", d)
    expect(d.ctx.requirements).toBe("collected")
  })

  it("computes and logs the permission diff as soon as the plan exists", async () => {
    const log = fakeLog()
    const d = deps({
      progress: { completed: before("plan-scaffold"), approvals: [] },
      handlers: handlers({
        planScaffold: async () => ({ files: [], capabilities: ["fs.write"] }),
      }),
      log,
    })

    await runCreatorStep("plan-scaffold", d)
    expect(d.run.diff?.added).toEqual(["fs.write"])
    expect(d.run.diff?.requiresApproval).toBe(true)
    // Recorded BEFORE any approval, so both sides of the gate are auditable.
    expect(log.permissionDiff).toHaveBeenCalled()
  })

  // The smuggling case, re-checked at the gate itself.
  it("refuses the gate when the approval does not cover the current diff", async () => {
    const d = deps({
      ctx: ctx({ approvedAdditions: ["fs.write"] }),
      progress: {
        completed: before("approve-permissions"),
        approvals: ["permission-widening"],
      },
    })
    d.run.diff = {
      changes: [],
      added: ["fs.write", "proc.spawn"],
      removed: [],
      requiresApproval: true,
    }

    const outcome = await runCreatorStep("approve-permissions", d)
    expect(outcome.status).toBe("awaiting-approval")
  })

  it("passes the gate when the approval covers the diff", async () => {
    const d = deps({
      ctx: ctx({ approvedAdditions: ["fs.write"] }),
      progress: {
        completed: before("approve-permissions"),
        approvals: ["permission-widening"],
      },
    })
    d.run.diff = { changes: [], added: ["fs.write"], removed: [], requiresApproval: true }
    expect((await runCreatorStep("approve-permissions", d)).status).toBe("completed")
  })

  it("writes the planned files and records them", async () => {
    const { ops, writes } = okOps()
    const d = deps({
      progress: {
        completed: before("apply-changes"),
        approvals: ["permission-widening"],
      },
      ops,
    })
    d.run.plan = {
      files: [
        { relativePath: "a.ts", contents: "1" },
        { relativePath: "b.ts", contents: "2" },
      ],
      capabilities: [],
    }

    const outcome = await runCreatorStep("apply-changes", d)
    expect(outcome.status).toBe("completed")
    expect(writes).toEqual(["/work/authoring/a.ts", "/work/authoring/b.ts"])
    expect(d.run.written).toEqual(["a.ts", "b.ts"])
  })

  // A partially applied plan is harder to reason about than a failed one.
  it("stops at the first refused write rather than applying the rest", async () => {
    const { ops, writes } = okOps()
    const d = deps({
      progress: { completed: before("apply-changes"), approvals: ["permission-widening"] },
      ops,
    })
    d.run.plan = {
      files: [
        { relativePath: "a.ts", contents: "1" },
        { relativePath: "../escape.ts", contents: "2" },
        { relativePath: "c.ts", contents: "3" },
      ],
      capabilities: [],
    }

    const outcome = await runCreatorStep("apply-changes", d)
    expect(outcome.status).toBe("failed")
    expect(writes).toEqual(["/work/authoring/a.ts"])
  })

  it("refuses to write when the approval was withdrawn between steps", async () => {
    const { ops, writes } = okOps()
    const d = deps({
      // The gate step completed earlier, but the approval is gone now.
      progress: { completed: before("apply-changes"), approvals: [] },
      ops,
    })
    d.run.plan = { files: [{ relativePath: "a.ts", contents: "1" }], capabilities: [] }

    const outcome = await runCreatorStep("apply-changes", d)
    expect(outcome.status).toBe("awaiting-approval")
    expect(writes).toEqual([])
  })

  it("fails verification when any check fails, naming the ones that did", async () => {
    const d = deps({
      progress: { completed: before("verify"), approvals: ["permission-widening"] },
      handlers: handlers({
        verify: async () => ({ lint: true, typecheck: false, build: true, contract: false }),
      }),
    })
    const outcome = await runCreatorStep("verify", d)
    expect(outcome).toMatchObject({ status: "failed" })
    expect((outcome as { message: string }).message).toContain("typecheck")
    expect((outcome as { message: string }).message).toContain("contract")
  })

  // A leaked preview is a named release blocker; warning would let the run
  // reach delivery with resources still held.
  it("fails the preview step on a leak", async () => {
    const d = deps({
      progress: { completed: before("preview"), approvals: ["permission-widening"] },
      handlers: handlers({
        preview: async () => ({ clean: false, leaked: ["timer", "window"] }),
      }),
    })
    const outcome = await runCreatorStep("preview", d)
    expect(outcome).toMatchObject({ status: "failed" })
    expect((outcome as { message: string }).message).toContain("timer")
  })

  it("fails the review step when the reviewer raises a blocker", async () => {
    const d = deps({
      progress: { completed: before("review"), approvals: ["permission-widening"] },
      handlers: handlers({
        review: async () => ({
          findings: [{ id: "f1", severity: "blocker", summary: "escapes root" }],
          reviewerAuthority: "plan",
        }),
      }),
    })
    d.run.verification = { lint: true, typecheck: true, build: true, contract: true }
    d.run.diff = { changes: [], added: [], removed: [], requiresApproval: false }

    const outcome = await runCreatorStep("review", d)
    expect(outcome).toMatchObject({ status: "failed" })
    expect(d.run.verdict?.approved).toBe(false)
  })

  it("gives the reviewer the requirements and changed paths, never the conversation", async () => {
    const review = jest.fn(async (_ctx: unknown, _brief: unknown) => ({
      findings: [],
      reviewerAuthority: "plan",
    }))
    const d = deps({
      ctx: ctx({ requirements: "the original ask" }),
      progress: { completed: before("review"), approvals: ["permission-widening"] },
      handlers: handlers({ review }),
    })
    d.run.verification = { lint: true, typecheck: true, build: true, contract: true }
    d.run.diff = { changes: [], added: [], removed: [], requiresApproval: false }
    d.run.written = ["b.ts", "a.ts"]

    await runCreatorStep("review", d)
    const brief = review.mock.calls[0][1] as unknown as Record<string, unknown>
    expect(brief.requirements).toBe("the original ask")
    expect(brief.changedPaths).toEqual(["a.ts", "b.ts"])
    expect(Object.keys(brief)).not.toContain("conversation")
  })

  it("refuses delivery when the review did not approve", async () => {
    const deliver = jest.fn(async () => ({ delivered: "install" as const }))
    const d = deps({
      progress: {
        completed: before("approve-delivery"),
        approvals: ["permission-widening", "install"],
      },
      handlers: handlers({ deliver }),
    })
    const outcome = await runCreatorStep("approve-delivery", d)
    expect(outcome).toEqual({ status: "blocked", step: "approve-delivery", reason: "not-reviewed" })
    expect(deliver).not.toHaveBeenCalled()
  })

  it("delivers once the review approved and the gate is granted", async () => {
    const deliver = jest.fn(async () => ({ delivered: "install" as const }))
    const d = deps({
      progress: {
        completed: before("approve-delivery"),
        approvals: ["permission-widening", "install"],
      },
      handlers: handlers({ deliver }),
    })
    d.run.verdict = { approved: true, findings: [], reviewerAuthority: "plan" }
    expect((await runCreatorStep("approve-delivery", d)).status).toBe("completed")
    expect(deliver).toHaveBeenCalled()
  })

  it("turns a thrown handler into a failed step and logs it", async () => {
    const log = fakeLog()
    const d = deps({
      handlers: handlers({
        collectRequirements: async () => {
          throw new Error("agent unavailable")
        },
      }),
      log,
    })

    const outcome = await runCreatorStep("collect-requirements", d)
    expect(outcome).toMatchObject({ status: "failed", message: "agent unavailable" })
    expect(log.stepFailed).toHaveBeenCalledWith("collect-requirements", "agent unavailable")
    expect(log.stepCompleted).not.toHaveBeenCalled()
  })
})

describe("runCreatorPipeline", () => {
  it("runs forward and stops at the first approval gate", async () => {
    const outcome = await runCreatorPipeline(deps())
    expect(outcome.status).toBe("awaiting-approval")
    expect(outcome.step).toBe("approve-permissions")
    expect(outcome.ran).toEqual(["collect-requirements", "survey-existing", "plan-scaffold"])
  })

  it("resumes past the gate once the approval is granted", async () => {
    const outcome = await runCreatorPipeline(
      deps({
        progress: {
          completed: before("approve-permissions"),
          approvals: ["permission-widening"],
        },
      })
    )
    // Stops again at the delivery gate, which needs its own separate approval.
    expect(outcome.status).toBe("awaiting-approval")
    expect(outcome.step).toBe("approve-delivery")
    expect(outcome.ran).toEqual([
      "approve-permissions",
      "apply-changes",
      "verify",
      "preview",
      "review",
    ])
  })

  it("completes the whole workflow when both approvals are granted", async () => {
    const outcome = await runCreatorPipeline(
      deps({
        progress: {
          completed: before("approve-permissions"),
          approvals: ["permission-widening", "install"],
        },
      })
    )
    expect(outcome.status).toBe("completed")
    expect(outcome.ran).toContain("approve-delivery")
  })

  it("stops at a failure and reports which step failed", async () => {
    const outcome = await runCreatorPipeline(
      deps({
        progress: {
          completed: before("approve-permissions"),
          approvals: ["permission-widening", "install"],
        },
        handlers: handlers({
          verify: async () => ({ lint: false, typecheck: true, build: true, contract: true }),
        }),
      })
    )
    expect(outcome.status).toBe("failed")
    expect(outcome.step).toBe("verify")
    expect(outcome.ran).toEqual(["approve-permissions", "apply-changes"])
  })

  it("reports completion for an already-finished run without re-running anything", async () => {
    const planScaffold = jest.fn()
    const outcome = await runCreatorPipeline(
      deps({
        progress: { completed: [...CREATOR_STEP_IDS], approvals: [] },
        handlers: handlers({ planScaffold }),
      })
    )
    expect(outcome).toEqual({ status: "completed", ran: [] })
    expect(planScaffold).not.toHaveBeenCalled()
  })

  it("does not mutate the caller's progress object", async () => {
    const progress: CreatorAdvanceState = { completed: [], approvals: [] }
    await runCreatorPipeline(deps({ progress }))
    expect(progress.completed).toEqual([])
  })

  // A run resumed after a reload has its steps marked complete in the durable
  // log but no in-memory plan — file contents deliberately never enter the log.
  it("re-derives the plan when resuming a run whose in-memory state is gone", async () => {
    const planScaffold = jest.fn(async () => ({
      files: [{ relativePath: "a.ts", contents: "1" }],
      capabilities: [],
    }))
    const { ops, writes } = okOps()
    const outcome = await runCreatorPipeline(
      deps({
        // Fresh state: nothing carried over from before the reload.
        run: createCreatorRunState(),
        progress: {
          completed: before("apply-changes"),
          approvals: ["permission-widening", "install"],
        },
        handlers: handlers({ planScaffold }),
        ops,
      })
    )

    expect(planScaffold).toHaveBeenCalled()
    expect(writes).toEqual(["/work/authoring/a.ts"])
    expect(outcome.status).toBe("completed")
  })

  // Re-deriving is also a security property: the approval is re-checked
  // against the freshly generated proposal, not the one it was granted for.
  it("re-checks a pre-reload approval against the regenerated diff", async () => {
    const outcome = await runCreatorPipeline(
      deps({
        ctx: ctx({ approvedAdditions: ["fs.write"] }),
        run: createCreatorRunState(),
        progress: {
          completed: before("apply-changes"),
          approvals: ["permission-widening", "install"],
        },
        // The regenerated plan asks for MORE than the user approved.
        handlers: handlers({
          planScaffold: async () => ({
            files: [{ relativePath: "a.ts", contents: "1" }],
            capabilities: ["fs.write", "proc.spawn"],
          }),
        }),
      })
    )
    expect(outcome.status).toBe("awaiting-approval")
    expect(outcome.step).toBe("approve-permissions")
  })

  it("surfaces a failure in the re-derived producer, not the downstream step", async () => {
    const outcome = await runCreatorPipeline(
      deps({
        run: createCreatorRunState(),
        progress: {
          completed: before("apply-changes"),
          approvals: ["permission-widening", "install"],
        },
        handlers: handlers({
          planScaffold: async () => {
            throw new Error("generator unavailable")
          },
        }),
      })
    )
    expect(outcome.status).toBe("failed")
    expect(outcome.step).toBe("plan-scaffold")
    expect(outcome.detail).toBe("generator unavailable")
  })
})
