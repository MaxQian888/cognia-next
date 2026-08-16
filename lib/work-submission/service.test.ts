/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { webcrypto } from "node:crypto"

import { WORK_SUBMISSION_CONTRACT_VERSION } from "@cognia/agent-config-types/work-submission"
import type { WorkSubmissionIntentV1 } from "@cognia/agent-config-types/work-submission"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { listExecutionRunEvents } from "@/lib/db/execution-runs"
import {
  getExecutionContextBundle,
  getWorkInputBatch,
  getWorkSubmission,
} from "@/lib/db/work-submissions"

import { openWorkSubmissionPayload } from "./crypto"
import {
  acceptWorkSubmission,
  bindWorkExecutionContext,
  executionContextDigest,
  markWorkSubmissionStarted,
  settleWorkSubmission,
  settleWorkSubmissionWithoutTranscript,
  workInputDigest,
  WorkSubmissionRejectedError,
  MAX_OPEN_WORK_SUBMISSIONS,
  type AcceptWorkSubmissionInput,
  type FrozenWorkInput,
} from "./service"

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true })
  }
})

const NOW = 1_755_000_000_000
const KEY = new Uint8Array(32).fill(3)
const deps = { loadKey: async () => KEY }

function intent(overrides: Partial<WorkSubmissionIntentV1> = {}): WorkSubmissionIntentV1 {
  return {
    contractVersion: WORK_SUBMISSION_CONTRACT_VERSION,
    idempotencyKey: "chat:session-1:action-1",
    source: { kind: "chat", sourceId: "session-1" },
    scope: { accountId: "account-1", runtimeTargetId: "target-1", sessionId: "session-1" },
    availabilityPolicy: "wait",
    ...overrides,
  }
}

const frozenInput: FrozenWorkInput = {
  content: "explain the freeze points",
  visibleMessageIds: ["message-1"],
  attachments: [],
}

function acceptInput(
  overrides: Partial<AcceptWorkSubmissionInput> = {}
): AcceptWorkSubmissionInput {
  return {
    intent: intent(),
    runId: "run-1",
    turnId: "turn-1",
    inputBatchId: "batch-1",
    submissionId: "submission-1",
    input: frozenInput,
    now: NOW,
    ...overrides,
  }
}

describe("acceptWorkSubmission", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("commits the submission, frozen input, run, and opening event together", async () => {
    const receipt = await acceptWorkSubmission(acceptInput(), deps)

    expect(receipt).toEqual({
      contractVersion: WORK_SUBMISSION_CONTRACT_VERSION,
      submissionId: "submission-1",
      runId: "run-1",
      turnId: "turn-1",
      inputBatchId: "batch-1",
      state: "accepted",
      acceptedAt: NOW,
    })
    expect(await getWorkSubmission("submission-1")).toMatchObject({
      dispatchState: "pending",
      sourceKind: "chat",
      runtimeTargetId: "target-1",
    })
    expect(await getWorkInputBatch("submission-1")).toBeDefined()
    // Accepted but not yet dispatched is exactly what `queued` means. Emitting
    // `run.started` here would project the run to `running` before anything is.
    expect((await getDb().executionRuns.get("run-1"))?.status).toBe("queued")
    expect(await listExecutionRunEvents("run-1")).toEqual([])
  })

  it("runs the transcript write inside the same transaction", async () => {
    await acceptWorkSubmission(
      acceptInput({
        writeTranscript: async () => {
          await getDb().sessions.put({
            id: "session-1",
            title: "T",
            createdAt: NOW,
            updatedAt: NOW,
          } as never)
        },
      }),
      deps
    )
    expect(await getDb().sessions.get("session-1")).toBeDefined()
  })

  it("rolls the transcript back when the submission write fails", async () => {
    // The whole point of the single transaction: a user must never see a
    // message the system has no record of owing an answer for.
    await getDb().executionRuns.add({
      id: "run-1",
      kind: "agent-turn",
      sourceId: "pre-existing",
      title: "clash",
      status: "queued",
      currentRevision: 0,
      startedAt: NOW,
      updatedAt: NOW,
    })

    await expect(
      acceptWorkSubmission(
        acceptInput({
          writeTranscript: async () => {
            await getDb().sessions.put({
              id: "ghost",
              title: "T",
              createdAt: NOW,
              updatedAt: NOW,
            } as never)
          },
        }),
        deps
      )
    ).rejects.toThrow()

    expect(await getDb().sessions.get("ghost")).toBeUndefined()
    expect(await getWorkSubmission("submission-1")).toBeUndefined()
    expect(await getWorkInputBatch("submission-1")).toBeUndefined()
  })

  it("returns the original receipt for a redelivered submission", async () => {
    const first = await acceptWorkSubmission(acceptInput(), deps)
    const writeTranscript = jest.fn(async () => {})
    const second = await acceptWorkSubmission(
      acceptInput({ submissionId: "submission-2", runId: "run-2", writeTranscript }),
      deps
    )

    expect(second).toEqual(first)
    // A redelivery must not append a second user message.
    expect(writeTranscript).not.toHaveBeenCalled()
    expect(await getDb().workSubmissions.count()).toBe(1)
    expect(await getDb().executionRuns.count()).toBe(1)
  })

  it("carries the optional scope and source fields onto the row", async () => {
    await acceptWorkSubmission(
      acceptInput({
        intent: intent({
          source: { kind: "chat", sourceId: "session-1", triggerId: "trigger-1" },
          scope: {
            accountId: "account-1",
            runtimeTargetId: "target-1",
            sessionId: "session-1",
            projectId: "project-1",
          },
          workItemRef: { kind: "agent-task", id: "task-1" },
        }),
        runTitle: "Named run",
      }),
      deps
    )
    expect(await getWorkSubmission("submission-1")).toMatchObject({
      triggerId: "trigger-1",
      projectId: "project-1",
    })
    expect((await getDb().executionRuns.get("run-1"))?.title).toBe("Named run")
  })

  it("falls back to the injected clock when no explicit timestamp is given", async () => {
    const receipt = await acceptWorkSubmission(
      { ...acceptInput(), now: undefined },
      { ...deps, now: () => NOW + 42 }
    )
    expect(receipt.acceptedAt).toBe(NOW + 42)
  })

  it("defers a newly accepted live row while its caller freezes context and claims it", async () => {
    await acceptWorkSubmission(acceptInput(), deps)
    expect((await getWorkSubmission("submission-1"))?.nextAttemptAt).toBeGreaterThan(NOW)
  })

  it("reports a terminal receipt when the redelivery arrives after the work finished", async () => {
    await acceptWorkSubmission(acceptInput(), deps)
    await settleWorkSubmissionWithoutTranscript("submission-1", "completed", NOW + 5)
    const replay = await acceptWorkSubmission(acceptInput(), deps)
    expect(replay.state).toBe("terminal")
  })

  it("reports a queued receipt when the redelivery arrives mid-dispatch", async () => {
    await acceptWorkSubmission(acceptInput(), deps)
    await markWorkSubmissionStarted("submission-1", NOW + 1)
    const replay = await acceptWorkSubmission(acceptInput(), deps)
    expect(replay.state).toBe("queued")
  })

  it("collapses two concurrent accepts of the same key onto one submission", async () => {
    const [a, b] = await Promise.all([
      acceptWorkSubmission(acceptInput(), deps),
      acceptWorkSubmission(
        acceptInput({ submissionId: "submission-2", runId: "run-2", inputBatchId: "batch-2" }),
        deps
      ),
    ])
    expect(a.submissionId).toBe(b.submissionId)
    expect(await getDb().workSubmissions.count()).toBe(1)
  })

  it("parks work as blocked when the target is away and the policy is wait", async () => {
    const receipt = await acceptWorkSubmission(acceptInput({ targetAvailable: false }), deps)
    expect(receipt.state).toBe("blocked")
    expect((await getWorkSubmission("submission-1"))?.dispatchState).toBe("blocked")
    // The run must not claim it started when nothing is running.
    expect((await getDb().executionRuns.get("run-1"))?.status).toBe("waiting")
    expect((await listExecutionRunEvents("run-1")).map((event) => event.type)).toEqual([
      "run.waiting",
    ])
  })

  it("does not park work whose policy is not wait", async () => {
    const receipt = await acceptWorkSubmission(
      acceptInput({
        intent: intent({ availabilityPolicy: "fail" }),
        targetAvailable: false,
      }),
      deps
    )
    expect(receipt.state).toBe("accepted")
  })

  it("rejects an invalid intent before touching the database", async () => {
    await expect(
      acceptWorkSubmission(
        acceptInput({
          intent: { ...intent(), availabilityPolicy: "whenever" as never },
          writeTranscript: async () => {
            throw new Error("must not run")
          },
        }),
        deps
      )
    ).rejects.toBeInstanceOf(WorkSubmissionRejectedError)
    expect(await getDb().workSubmissions.count()).toBe(0)
  })

  it("reports the validation details on rejection", async () => {
    const error = (await acceptWorkSubmission(
      acceptInput({ intent: { ...intent(), idempotencyKey: "" } }),
      deps
    ).catch((caught: unknown) => caught)) as WorkSubmissionRejectedError
    expect(error.code).toBe("invalid_intent")
    expect(error.details.join()).toContain("idempotencyKey")
  })

  it("refuses new work once the account backlog is full", async () => {
    const rows = Array.from({ length: MAX_OPEN_WORK_SUBMISSIONS }, (_, index) => ({
      id: `bulk-${index}`,
      accountId: "account-1",
      idempotencyKey: `bulk-key-${index}`,
      runId: `bulk-run-${index}`,
      turnId: `bulk-turn-${index}`,
      runtimeTargetId: "target-1",
      sourceKind: "chat" as const,
      sourceId: "session-1",
      availabilityPolicy: "wait" as const,
      dispatchState: "pending" as const,
      nextAttemptAt: NOW,
      attemptCount: 0,
      inputBatchId: `bulk-batch-${index}`,
      createdAt: NOW,
      updatedAt: NOW,
    }))
    await getDb().workSubmissions.bulkAdd(rows)

    const error = (await acceptWorkSubmission(acceptInput(), deps).catch(
      (caught: unknown) => caught
    )) as WorkSubmissionRejectedError
    expect(error.code).toBe("backlog_full")
  })

  it("encrypts the frozen input and can replay it verbatim", async () => {
    await acceptWorkSubmission(acceptInput(), deps)
    const batch = await getWorkInputBatch("submission-1")

    expect(JSON.stringify(batch?.envelope)).not.toContain("explain the freeze points")
    const plainText = await openWorkSubmissionPayload(
      batch!.envelope,
      { accountId: "account-1", submissionId: "submission-1", kind: "input-batch" },
      deps
    )
    expect(JSON.parse(plainText)).toEqual(frozenInput)
  })

  it("records a digest that a replay can be checked against", async () => {
    await acceptWorkSubmission(acceptInput(), deps)
    expect((await getWorkInputBatch("submission-1"))?.digest).toBe(workInputDigest(frozenInput))
  })
})

describe("workInputDigest", () => {
  it("is stable across key order", () => {
    const a = workInputDigest({ content: { x: 1, y: 2 }, visibleMessageIds: [], attachments: [] })
    const b = workInputDigest({ content: { y: 2, x: 1 }, visibleMessageIds: [], attachments: [] })
    expect(a).toBe(b)
  })

  it("changes when the content changes", () => {
    expect(workInputDigest(frozenInput)).not.toBe(
      workInputDigest({ ...frozenInput, content: "something else" })
    )
  })

  it("changes when the visible message set changes", () => {
    expect(workInputDigest(frozenInput)).not.toBe(
      workInputDigest({ ...frozenInput, visibleMessageIds: ["message-1", "message-2"] })
    )
  })
})

describe("bindWorkExecutionContext", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await acceptWorkSubmission(acceptInput(), deps)
  })

  it("freezes the context and stamps the fingerprint and authority", async () => {
    const result = await bindWorkExecutionContext(
      {
        submissionId: "submission-1",
        accountId: "account-1",
        contextBundleId: "bundle-1",
        context: { cwd: "/srv/project", projectId: "project-1", baseRef: "refs/heads/dev" },
        executionFingerprint: "aexf1-abc",
        specAuthority: "shadow",
        now: NOW,
      },
      deps
    )

    expect(result).toEqual({ bound: true, contextBundleId: "bundle-1" })
    expect(await getWorkSubmission("submission-1")).toMatchObject({
      contextBundleId: "bundle-1",
      executionFingerprint: "aexf1-abc",
      specAuthority: "shadow",
    })
  })

  it("keeps the absolute cwd in the encrypted payload, not the row", async () => {
    // Host-local paths must not appear in the queryable row, which is what
    // crosses into diagnostics, exports, and sync surfaces.
    await bindWorkExecutionContext(
      {
        submissionId: "submission-1",
        accountId: "account-1",
        contextBundleId: "bundle-1",
        context: { cwd: "/Users/me/secret-project", workspaceBindingRef: "workspace-main" },
        now: NOW,
      },
      deps
    )
    const row = await getExecutionContextBundle("submission-1")
    expect(JSON.stringify({ ...row, envelope: undefined })).not.toContain("/Users/me")
    expect(row?.workspaceBindingRef).toBe("workspace-main")

    const plainText = await openWorkSubmissionPayload(
      row!.envelope,
      { accountId: "account-1", submissionId: "submission-1", kind: "context-bundle" },
      deps
    )
    expect(JSON.parse(plainText).cwd).toBe("/Users/me/secret-project")
  })

  it("is write-once, so a retry keeps the original context", async () => {
    await bindWorkExecutionContext(
      {
        submissionId: "submission-1",
        accountId: "account-1",
        contextBundleId: "bundle-1",
        context: { projectId: "project-1" },
        now: NOW,
      },
      deps
    )
    const second = await bindWorkExecutionContext(
      {
        submissionId: "submission-1",
        accountId: "account-1",
        contextBundleId: "bundle-2",
        context: { projectId: "project-moved" },
        now: NOW + 1,
      },
      deps
    )
    expect(second).toEqual({ bound: false, contextBundleId: "bundle-1" })
    expect((await getExecutionContextBundle("submission-1"))?.projectId).toBe("project-1")
  })
})

describe("executionContextDigest", () => {
  it("is stable across key order", () => {
    expect(executionContextDigest({ cwd: "/a", projectId: "p" })).toBe(
      executionContextDigest({ projectId: "p", cwd: "/a" })
    )
  })
})

describe("markWorkSubmissionStarted", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await acceptWorkSubmission(acceptInput(), deps)
  })

  it("moves the run to running only once a runtime has it", async () => {
    await markWorkSubmissionStarted("submission-1", NOW + 1)
    expect((await getWorkSubmission("submission-1"))?.dispatchState).toBe("dispatched")
    expect((await getDb().executionRuns.get("run-1"))?.status).toBe("running")
    expect((await listExecutionRunEvents("run-1")).map((event) => event.type)).toEqual([
      "run.started",
    ])
  })

  it("does not append a second start for a redelivered dispatch", async () => {
    await markWorkSubmissionStarted("submission-1", NOW + 1)
    await markWorkSubmissionStarted("submission-1", NOW + 2)
    expect((await listExecutionRunEvents("run-1")).map((event) => event.type)).toEqual([
      "run.started",
    ])
  })

  it("ignores a settled submission and a missing one", async () => {
    await settleWorkSubmissionWithoutTranscript("submission-1", "completed", NOW)
    await markWorkSubmissionStarted("submission-1", NOW + 1)
    await markWorkSubmissionStarted("nope", NOW + 1)
    expect((await getWorkSubmission("submission-1"))?.dispatchState).toBe("settled")
  })

  it("does not restart a run that already reached a terminal status", async () => {
    await getDb().executionRuns.update("run-1", { status: "cancelled" })
    await markWorkSubmissionStarted("submission-1", NOW + 1)
    expect((await listExecutionRunEvents("run-1")).map((event) => event.type)).toEqual([])
  })

  it("tolerates a missing run row", async () => {
    await getDb().executionRuns.delete("run-1")
    await expect(markWorkSubmissionStarted("submission-1", NOW + 1)).resolves.toBeUndefined()
  })
})

describe("settleWorkSubmission", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await acceptWorkSubmission(acceptInput(), deps)
  })

  it("seals the submission and closes the run in one transaction", async () => {
    await markWorkSubmissionStarted("submission-1", NOW + 1)
    expect(
      await settleWorkSubmission({
        submissionId: "submission-1",
        outcome: "completed",
        now: NOW + 5,
      })
    ).toBe(true)

    expect(await getWorkSubmission("submission-1")).toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "completed",
    })
    expect((await getDb().executionRuns.get("run-1"))?.status).toBe("completed")
    expect((await listExecutionRunEvents("run-1")).map((event) => event.type)).toEqual([
      "run.started",
      "run.completed",
    ])
  })

  it("writes the terminal transcript exactly once across duplicate settles", async () => {
    // Four call sites can observe a turn ending; only the winner may write the
    // assistant message.
    const writeTranscript = jest.fn(async () => {
      await getDb().sessions.put({
        id: "reply",
        title: "R",
        createdAt: NOW,
        updatedAt: NOW,
      } as never)
    })

    const first = await settleWorkSubmission({
      submissionId: "submission-1",
      outcome: "completed",
      writeTranscript,
      now: NOW + 1,
    })
    const second = await settleWorkSubmission({
      submissionId: "submission-1",
      outcome: "failed",
      writeTranscript,
      now: NOW + 2,
    })

    expect([first, second]).toEqual([true, false])
    expect(writeTranscript).toHaveBeenCalledTimes(1)
    expect((await getWorkSubmission("submission-1"))?.terminalOutcome).toBe("completed")
  })

  it("treats an empty reply as a completed run, not a failure", async () => {
    await settleWorkSubmission({
      submissionId: "submission-1",
      outcome: "no_response",
      now: NOW + 1,
    })
    expect((await getDb().executionRuns.get("run-1"))?.status).toBe("completed")
    expect((await getWorkSubmission("submission-1"))?.terminalOutcome).toBe("no_response")
  })

  it.each([
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["recovery_required", "recovery_required"],
  ] as const)("maps outcome %s onto run status %s", async (outcome, status) => {
    await settleWorkSubmission({ submissionId: "submission-1", outcome, now: NOW + 1 })
    expect((await getDb().executionRuns.get("run-1"))?.status).toBe(status)
  })

  it("records an error code alongside a failure", async () => {
    await settleWorkSubmission({
      submissionId: "submission-1",
      outcome: "failed",
      errorCode: "host_unavailable",
      now: NOW + 1,
    })
    expect((await getWorkSubmission("submission-1"))?.errorCode).toBe("host_unavailable")
  })

  it("returns false for a missing submission", async () => {
    expect(await settleWorkSubmission({ submissionId: "nope", outcome: "completed" })).toBe(false)
  })

  it("does not append a second terminal event to an already-terminal run", async () => {
    await getDb().executionRuns.update("run-1", { status: "cancelled" })
    await settleWorkSubmission({ submissionId: "submission-1", outcome: "completed", now: NOW + 1 })
    expect(await listExecutionRunEvents("run-1")).toEqual([])
  })

  it("still seals the ledger when the run row is missing", async () => {
    await getDb().executionRuns.delete("run-1")
    expect(
      await settleWorkSubmission({ submissionId: "submission-1", outcome: "completed", now: NOW })
    ).toBe(true)
    expect((await getWorkSubmission("submission-1"))?.dispatchState).toBe("settled")
  })
})

describe("settleWorkSubmissionWithoutTranscript", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await acceptWorkSubmission(acceptInput(), deps)
  })

  it("seals the ledger row", async () => {
    expect(await settleWorkSubmissionWithoutTranscript("submission-1", "cancelled", NOW + 1)).toBe(
      true
    )
    expect((await getWorkSubmission("submission-1"))?.terminalOutcome).toBe("cancelled")
  })
})
