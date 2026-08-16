/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import type { RunEvent } from "@/types/execution/run"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createExecutionRun, runEventJournal, semanticRunEvent } from "@/lib/db/execution-runs"
import type { WorkSubmissionRow } from "@/lib/db/work-submissions"
import { CanonicalLogCorruptionError } from "@/lib/ai/agent/recovery/canonical-log"

import { planWorkSubmissionRecovery } from "./recovery"

const NOW = 1_755_000_000_000

function row(overrides: Partial<WorkSubmissionRow> = {}): WorkSubmissionRow {
  return {
    id: "submission-1",
    accountId: "account-1",
    idempotencyKey: "key-1",
    runId: "run-1",
    turnId: "turn-1",
    runtimeTargetId: "target-1",
    sourceKind: "chat",
    sourceId: "session-1",
    availabilityPolicy: "wait",
    dispatchState: "claimed",
    nextAttemptAt: NOW,
    attemptCount: 1,
    inputBatchId: "batch-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function event(type: string): RunEvent {
  return {
    id: `event-${type}`,
    runId: "run-1",
    seq: 1,
    ts: NOW,
    type: type as RunEvent["type"],
    visibility: "summary",
    payload: {},
  }
}

const noEvents = { listRunEvents: async () => [], readEnvelopes: async () => [] }

describe("planWorkSubmissionRecovery", () => {
  it("treats a never-claimed submission as a first attempt", async () => {
    const listRunEvents = jest.fn(async () => [])
    const decision = await planWorkSubmissionRecovery(row({ attemptCount: 0 }), {
      listRunEvents,
      readEnvelopes: async () => [],
    })
    expect(decision).toEqual({ action: "redispatch", reason: "never-dispatched" })
    // Nothing ran, so there is no journal worth reading.
    expect(listRunEvents).not.toHaveBeenCalled()
  })

  it("re-dispatches when a claimed attempt recorded nothing at all", async () => {
    expect(await planWorkSubmissionRecovery(row(), noEvents)).toEqual({
      action: "redispatch",
      reason: "no-observed-effects",
    })
  })

  it.each(["tool.started", "tool.completed", "tool.failed"])(
    "refuses to replay after a %s event",
    async (type) => {
      // Replaying work that already reached a tool can double-fire a side
      // effect the user cannot undo.
      const decision = await planWorkSubmissionRecovery(row(), {
        listRunEvents: async () => [event(type)],
        readEnvelopes: async () => [],
      })
      expect(decision).toMatchObject({
        action: "recovery_required",
        reason: "observed-tool-activity",
      })
    }
  )

  it("reports how much tool activity blocked the replay", async () => {
    const decision = await planWorkSubmissionRecovery(row(), {
      listRunEvents: async () => [event("tool.started"), event("tool.completed")],
      readEnvelopes: async () => [],
    })
    expect(decision).toEqual({
      action: "recovery_required",
      reason: "observed-tool-activity",
      detail: ["2 tool event(s) recorded on run run-1"],
    })
  })

  it("ignores non-tool run events", async () => {
    const decision = await planWorkSubmissionRecovery(row(), {
      listRunEvents: async () => [event("run.started"), event("step.started")],
      readEnvelopes: async () => [],
    })
    expect(decision).toEqual({ action: "redispatch", reason: "no-observed-effects" })
  })

  it("checks the semantic journal before reading envelopes", async () => {
    // A tool event is disqualifying on its own; reading the canonical log
    // cannot make it safe again, so the cheap check comes first.
    const readEnvelopes = jest.fn(async () => [])
    await planWorkSubmissionRecovery(row(), {
      listRunEvents: async () => [event("tool.started")],
      readEnvelopes,
    })
    expect(readEnvelopes).not.toHaveBeenCalled()
  })

  it("parks the submission when the canonical log is corrupt", async () => {
    const decision = await planWorkSubmissionRecovery(row(), {
      listRunEvents: async () => [],
      readEnvelopes: async () => {
        throw new CanonicalLogCorruptionError("run-1")
      },
    })
    expect(decision).toMatchObject({
      action: "recovery_required",
      reason: "corrupt-canonical-log",
    })
  })

  it("parks work when the canonical journal cannot be read", async () => {
    await expect(
      planWorkSubmissionRecovery(row(), {
        listRunEvents: async () => [],
        readEnvelopes: async () => {
          throw new Error("disk gone")
        },
      })
    ).resolves.toEqual({
      action: "recovery_required",
      reason: "unreadable-journal",
      detail: ["disk gone"],
    })
  })

  it("parks work when the semantic run journal cannot be read", async () => {
    await expect(
      planWorkSubmissionRecovery(row(), {
        listRunEvents: async () => {
          throw new Error("indexeddb unavailable")
        },
        readEnvelopes: async () => [],
      })
    ).resolves.toEqual({
      action: "recovery_required",
      reason: "unreadable-journal",
      detail: ["indexeddb unavailable"],
    })
  })

  it("parks on an unresolved tool call recorded only in the canonical log", async () => {
    // The semantic journal can be empty while the canonical log still shows a
    // tool call that never returned — the shared planner catches that.
    const decision = await planWorkSubmissionRecovery(row(), {
      listRunEvents: async () => [],
      readEnvelopes: async () => [
        {
          turnId: "turn-1",
          event: { kind: "tool-call", toolCallId: "call-1", toolName: "write_file" },
        } as never,
      ],
    })
    expect(decision).toMatchObject({
      action: "recovery_required",
      reason: "ambiguous-side-effects",
    })
  })

  it("re-dispatches when the canonical log shows only resolved text", async () => {
    const decision = await planWorkSubmissionRecovery(row(), {
      listRunEvents: async () => [],
      readEnvelopes: async () => [
        { turnId: "turn-1", event: { kind: "text-delta", delta: "partial reply" } } as never,
      ],
    })
    expect(decision).toEqual({ action: "redispatch", reason: "no-observed-effects" })
  })

  describe("against the real journal (no injected deps)", () => {
    beforeEach(async () => {
      await getDb().delete()
      __resetDbForTesting()
      await createExecutionRun({
        id: "run-1",
        kind: "agent-turn",
        sourceId: "submission-1",
        title: "Chat run",
        status: "queued",
        currentRevision: 0,
        startedAt: NOW,
        updatedAt: NOW,
      })
      // Opening the full Dexie version chain for the first time in this worker
      // exceeds Jest's 5s default hook budget.
    }, 30_000)

    it("re-dispatches a stranded run whose journal records no tools", async () => {
      await runEventJournal.append("run-1", semanticRunEvent("run.started", {}, { ts: NOW }))
      expect(await planWorkSubmissionRecovery(row())).toEqual({
        action: "redispatch",
        reason: "no-observed-effects",
      })
    }, 30_000)

    it("parks a stranded run whose journal records a tool", async () => {
      await runEventJournal.append("run-1", semanticRunEvent("run.started", {}, { ts: NOW }))
      await runEventJournal.append(
        "run-1",
        semanticRunEvent("tool.started", { toolName: "write_file" }, { ts: NOW + 1 })
      )
      expect(await planWorkSubmissionRecovery(row())).toMatchObject({
        action: "recovery_required",
        reason: "observed-tool-activity",
      })
    }, 30_000)
  })

  it("re-dispatches when every canonical tool call was resolved", async () => {
    const decision = await planWorkSubmissionRecovery(row(), {
      listRunEvents: async () => [],
      readEnvelopes: async () => [
        {
          turnId: "turn-1",
          event: { kind: "tool-call", toolCallId: "call-1", toolName: "read_file" },
        } as never,
        { turnId: "turn-1", event: { kind: "tool-result", toolCallId: "call-1" } } as never,
      ],
    })
    expect(decision).toEqual({ action: "redispatch", reason: "no-observed-effects" })
  })
})
