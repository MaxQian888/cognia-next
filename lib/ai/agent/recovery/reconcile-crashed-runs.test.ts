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
const replayJournal = jest.fn()
jest.mock("@/lib/db/execution-runs", () => ({
  runEventJournal: {
    append: (...a: unknown[]) => appendJournal(...a),
    replay: (...a: unknown[]) => replayJournal(...a),
  },
  semanticRunEvent: (type: string, payload: unknown, opts: { ts?: number }) => ({
    type,
    payload,
    ts: opts.ts,
  }),
}))

import {
  parseAgentRunRecoveryAnchor,
  reconcileCrashedAgentRuns,
  resumeCrashedAgentRun,
  validateRecoveryContinuation,
  type AgentRunRecoveryAnchorV1,
} from "./reconcile-crashed-runs"
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
    schemaVersion: 1,
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
  replayJournal.mockResolvedValue([{ type: "run.started", payload: { recoveryAnchor: anchor } }])
})

const anchor: AgentRunRecoveryAnchorV1 = {
  version: 1,
  inboundJobId: "job-1",
  sessionId: "s1",
  sdkSessionId: "sdk-1",
  attemptId: "attempt-1",
  executionFingerprint: "fp-1",
  routeKind: "direct",
  runtimeAdapter: "claude-agent-sdk",
  candidateDeploymentIds: ["deployment-1"],
  modelBindings: { primary: "claude-sonnet-5" },
}

describe("explicit crashed-run resume", () => {
  it("continues a text-interrupted run through the durable inbound job", async () => {
    replayJournal.mockResolvedValueOnce([
      { type: "run.started", payload: { recoveryAnchor: anchor } },
    ])
    await appendCanonicalEnvelopes("run-resume", [
      envelope("run-resume", 0, { kind: "text-delta", delta: "partial answer" }),
      envelope("run-resume", 1, {
        kind: "permission-request",
        requestId: "permission-1",
        toolName: "Bash",
      }),
      envelope("run-resume", 2, {
        kind: "permission-resolved",
        requestId: "permission-1",
        behavior: "allow",
      }),
    ])
    const continueInboundJob = jest.fn(async () => true)

    await expect(
      resumeCrashedAgentRun("run-resume", {
        findInboundJob: async () => ({ id: "job-1", status: "recovery_required" }) as never,
        readSdkSessionId: async () => "sdk-1",
        continueInboundJob,
      })
    ).resolves.toEqual({ resumed: true, inboundJobId: "job-1" })
    expect(continueInboundJob).toHaveBeenCalledWith("job-1", {
      recoveryAnchor: expect.objectContaining({ version: 1, sdkSessionId: "sdk-1" }),
    })
    expect(continueInboundJob).toHaveBeenCalledWith("job-1", {
      recoveryAnchor: expect.objectContaining({
        partialOutput: "partial answer",
        restoredPermissions: [
          expect.objectContaining({
            requestId: "permission-1",
            state: "pending",
            downgradedFromAllow: true,
          }),
        ],
      }),
    })
  })

  it("uses the latest persisted SDK-session recovery checkpoint", async () => {
    replayJournal.mockResolvedValueOnce([
      {
        type: "run.started",
        payload: { recoveryAnchor: { ...anchor, sdkSessionId: undefined } },
      },
      {
        type: "resource.changed",
        payload: { recoveryAnchor: { ...anchor, sdkSessionId: "sdk-issued" } },
      },
    ])
    await appendCanonicalEnvelopes("run-sdk-checkpoint", [
      envelope("run-sdk-checkpoint", 0, { kind: "text-delta", delta: "partial" }),
    ])
    const continueInboundJob = jest.fn(async () => true)

    await expect(
      resumeCrashedAgentRun("run-sdk-checkpoint", {
        findInboundJob: async () => ({ id: "job-1", status: "recovery_required" }) as never,
        readSdkSessionId: async () => "sdk-issued",
        continueInboundJob,
      })
    ).resolves.toEqual({ resumed: true, inboundJobId: "job-1" })
    expect(continueInboundJob).toHaveBeenCalledWith("job-1", {
      recoveryAnchor: expect.objectContaining({ sdkSessionId: "sdk-issued" }),
    })
  })

  it("blocks unresolved tools and legacy runs without an anchor", async () => {
    replayJournal.mockResolvedValueOnce([
      { type: "run.started", payload: { recoveryAnchor: anchor } },
    ])
    await appendCanonicalEnvelopes("run-tool", [
      envelope("run-tool", 0, { kind: "tool-call", toolName: "Bash", toolCallId: "c1" }),
    ])
    await expect(
      resumeCrashedAgentRun("run-tool", {
        findInboundJob: async () => ({ id: "job-1", status: "recovery_required" }) as never,
        readSdkSessionId: async () => "sdk-1",
        continueInboundJob: jest.fn(),
      })
    ).resolves.toMatchObject({ resumed: false, reason: "ambiguous-side-effects" })

    replayJournal.mockResolvedValueOnce([])
    await expect(resumeCrashedAgentRun("run-legacy")).resolves.toEqual({
      resumed: false,
      reason: "missing-recovery-anchor",
    })

    const { routeKind: _routeKind, ...anchorWithoutRoute } = anchor
    replayJournal.mockResolvedValueOnce([
      { type: "run.started", payload: { recoveryAnchor: anchorWithoutRoute } },
    ])
    await expect(resumeCrashedAgentRun("run-anchor-without-route")).resolves.toEqual({
      resumed: false,
      reason: "missing-recovery-anchor",
    })
  })

  it("never resumes a run whose canonical persistence was marked corrupt", async () => {
    replayJournal.mockResolvedValueOnce([
      { type: "run.started", payload: { recoveryAnchor: anchor } },
      {
        type: "run.recovery_required",
        payload: { reason: "canonical-log-write-failed" },
      },
    ])
    await appendCanonicalEnvelopes("run-corrupt-marker", [
      envelope("run-corrupt-marker", 1, {
        kind: "tool-result",
        toolName: "Write",
        toolCallId: "call-1",
        result: "ok",
      }),
    ])

    await expect(resumeCrashedAgentRun("run-corrupt-marker")).resolves.toEqual({
      resumed: false,
      reason: "canonical-log-corrupt",
    })
  })

  it("blocks fingerprint, route, model, and SDK-session drift", () => {
    expect(
      validateRecoveryContinuation(anchor, {
        sdkSessionId: "sdk-other",
        executionFingerprint: "fp-other",
        candidateDeploymentIds: ["deployment-2"],
        modelBindings: { primary: "claude-opus-4-8" },
      })
    ).toEqual({
      action: "pause",
      mismatches: expect.arrayContaining([
        "sdkSessionId",
        "executionFingerprint",
        "candidateDeploymentIds",
        "modelBindings.primary",
      ]),
    })
  })

  it("rejects malformed optional model bindings in a recovery anchor", () => {
    expect(
      parseAgentRunRecoveryAnchor({
        ...anchor,
        modelBindings: { ...anchor.modelBindings, fast: 42 },
      })
    ).toBeUndefined()
  })

  it("releases the recovery lease when durable continuation throws", async () => {
    await appendCanonicalEnvelopes("run-error", [
      envelope("run-error", 0, { kind: "text-delta", delta: "partial answer" }),
    ])

    await expect(
      resumeCrashedAgentRun("run-error", {
        findInboundJob: async () => ({ id: "job-1", status: "recovery_required" }) as never,
        readSdkSessionId: async () => "sdk-1",
        continueInboundJob: async () => {
          throw new Error("durable queue unavailable")
        },
      })
    ).rejects.toThrow("durable queue unavailable")
    expect(releaseLease).toHaveBeenCalledWith("run-error")
  })
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

  it("marks legacy runs without a recovery anchor as recovery_required", async () => {
    replayJournal.mockImplementation(async (runId: string) =>
      runId === "run-legacy" ? [] : [{ type: "run.started", payload: { recoveryAnchor: anchor } }]
    )
    await getDb().executionRuns.put(run("run-legacy", "running"))

    const outcomes = await reconcileCrashedAgentRuns()
    expect(outcomes.find((item) => item.runId === "run-legacy")?.outcome).toMatchObject({
      status: "recovery_required",
      reason: "missing-recovery-anchor",
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
