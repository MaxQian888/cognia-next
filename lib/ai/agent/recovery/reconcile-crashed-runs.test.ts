/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"
import type { ExecutionRun } from "@/types/execution/run"

const claimLease = jest.fn()
const releaseLease = jest.fn()
jest.mock("@/lib/workflow/runtime/run-lease", () => ({
  claimRunLease: (...a: unknown[]) => claimLease(...a),
  releaseRunLease: (...a: unknown[]) => releaseLease(...a),
}))
const appendJournal = jest.fn()
jest.mock("@/lib/db/execution-runs", () => ({
  runEventJournal: { append: (...a: unknown[]) => appendJournal(...a) },
  semanticRunEvent: (type: string, payload: unknown, opts: { ts?: number }) => ({
    type,
    payload,
    ts: opts.ts,
  }),
}))

import { reconcileCrashedAgentRuns } from "./reconcile-crashed-runs"
import { appendCanonicalEnvelopes, __resetCanonicalLogForTesting } from "./canonical-log"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"

function run(
  id: string,
  status: ExecutionRun["status"],
  kind: ExecutionRun["kind"] = "agent-turn"
) {
  return {
    id,
    kind,
    sourceId: "chat",
    title: id,
    status,
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 1,
  } as ExecutionRun
}

function envelope(
  runId: string,
  sequence: number,
  event: Record<string, unknown>,
  turnId = "t1"
): AgentEventEnvelope {
  return {
    eventId: `${runId}:a1:${sequence}`,
    sequence,
    sessionId: "s1",
    runId,
    turnId,
    attemptId: "a1",
    hostRef: "desktop-sidecar",
    runtime: "claude-agent-sdk",
    timestamp: "2026-07-24T00:00:00.000Z",
    event: event as AgentEventEnvelope["event"],
  }
}

beforeEach(async () => {
  jest.clearAllMocks()
  await __resetDbForTesting()
  __resetCanonicalLogForTesting()
  claimLease.mockResolvedValue("claimed")
  releaseLease.mockResolvedValue(undefined)
  appendJournal.mockResolvedValue({})
})

describe("reconcileCrashedAgentRuns", () => {
  it("parks a cleanly-recoverable crashed run as paused with the candidate recorded — no replay", async () => {
    await getDb().executionRuns.put(run("run-clean", "running"))
    await appendCanonicalEnvelopes("run-clean", [
      envelope("run-clean", 0, { kind: "text-delta", delta: "hello " }),
      envelope("run-clean", 1, { kind: "text-delta", delta: "world" }),
      envelope("run-clean", 2, { kind: "tool-call", toolName: "Read", toolCallId: "c1" }),
      envelope("run-clean", 3, {
        kind: "tool-result",
        toolName: "Read",
        toolCallId: "c1",
        result: "ok",
      }),
    ])

    const outcomes = await reconcileCrashedAgentRuns(1_000)
    expect(outcomes).toEqual([
      {
        runId: "run-clean",
        outcome: { status: "recovered", candidateId: "canonical-log:run-clean" },
      },
    ])
    expect(appendJournal).toHaveBeenCalledWith(
      "run-clean",
      expect.objectContaining({
        type: "run.paused",
        payload: { reason: "crash-reconciled", candidateId: "canonical-log:run-clean" },
      })
    )
    expect(releaseLease).toHaveBeenCalledWith("run-clean")
  })

  it("an unresolved tool call makes the run recovery_required (side-effect ambiguity)", async () => {
    await getDb().executionRuns.put(run("run-ambig", "running"))
    await appendCanonicalEnvelopes("run-ambig", [
      envelope("run-ambig", 0, { kind: "tool-call", toolName: "Bash", toolCallId: "c1" }),
    ])

    const outcomes = await reconcileCrashedAgentRuns(1_000)
    expect(outcomes[0].outcome).toMatchObject({
      status: "recovery_required",
      reason: "ambiguous-side-effects",
    })
    expect(appendJournal).toHaveBeenCalledWith(
      "run-ambig",
      expect.objectContaining({ type: "run.recovery_required" })
    )
    // Nothing was parked and no replay happened.
    expect(appendJournal).not.toHaveBeenCalledWith(
      "run-ambig",
      expect.objectContaining({ type: "run.paused" })
    )
  })

  it("a crashed run with NO canonical log pauses as recovery_required (no candidates)", async () => {
    await getDb().executionRuns.put(run("run-empty", "running"))
    const outcomes = await reconcileCrashedAgentRuns()
    // fake-indexeddb persists across tests in this file — assert on THIS run.
    expect(outcomes.find((o) => o.runId === "run-empty")?.outcome).toMatchObject({
      status: "recovery_required",
      reason: "no-candidates",
    })
  })

  it("reads the projected snapshot status when present, and one failing run never blocks the rest", async () => {
    await getDb().executionRuns.put({
      ...run("run-snap", "queued"),
      latestSnapshot: { status: "running" } as never,
    })
    await getDb().executionRuns.put(run("run-fail", "running"))
    // Deterministic per-run failure (table iteration order and leftover runs
    // from earlier tests in this shared fake-indexeddb must not matter).
    claimLease.mockImplementation(async (id: unknown) => {
      if (id === "run-fail") throw new Error("lease store down")
      return "claimed"
    })
    const outcomes = await reconcileCrashedAgentRuns()
    const ids = outcomes.map((o) => o.runId)
    // The snapshot-projected run WAS reconciled (latestSnapshot.status branch)…
    expect(ids).toContain("run-snap")
    // …while the lease-failing run was skipped best-effort, blocking nothing.
    expect(ids).not.toContain("run-fail")
  })

  it("ignores non-agent runs and runs that are not stale-running", async () => {
    await getDb().executionRuns.put(run("run-done", "completed"))
    await getDb().executionRuns.put(run("run-wf", "running", "workflow"))
    const outcomes = await reconcileCrashedAgentRuns()
    expect(outcomes.map((o) => o.runId)).not.toEqual(expect.arrayContaining(["run-done", "run-wf"]))
    expect(appendJournal).not.toHaveBeenCalledWith("run-done", expect.anything())
    expect(appendJournal).not.toHaveBeenCalledWith("run-wf", expect.anything())
  })
})
