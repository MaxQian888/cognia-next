const mockBind = jest.fn()
const mockAudit = jest.fn()

jest.mock("@/lib/db/memory-governance", () => ({
  bindMemoryGovernanceOutcome: (...a: unknown[]) => mockBind(...a),
  appendMemoryAuditEvent: (...a: unknown[]) => mockAudit(...a),
}))

import { recordMemoryJobOutcome } from "./record-memory-outcome"
import type { ConsolidationOp } from "@/lib/memory/consolidate/consolidator"

const JOB = { id: "job-1", sessionId: "s1" }
const EVIDENCE = { kind: "message" as const, sourceId: "s1:m2:2", sourceRole: "user" as const }

function add(id: string, type = "semantic"): ConsolidationOp {
  return {
    op: "ADD",
    memory: { id, type },
    candidate: { type, text: "x", importance: 5 },
  } as unknown as ConsolidationOp
}

async function record(operations: ConsolidationOp[]) {
  await recordMemoryJobOutcome({
    job: JOB,
    operations,
    contaminationState: "clean",
    evidence: EVIDENCE,
    auditReason: "automatic_learning",
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockBind.mockResolvedValue({})
  mockAudit.mockResolvedValue({})
})

describe("recordMemoryJobOutcome", () => {
  it("writes the patch, evidence and audit in one transaction", async () => {
    await record([add("m1")])
    expect(mockBind).toHaveBeenCalledTimes(1)
    expect(mockBind).toHaveBeenCalledWith({
      memoryId: "m1",
      patch: {
        evidenceState: "supported",
        reviewStatus: "unreviewed",
        contaminationState: "clean",
        sensitivity: "normal",
      },
      evidence: {
        kind: "message",
        sourceId: "s1:m2:2",
        sessionId: "s1",
        contaminationState: "clean",
        reviewed: false,
        sourceRole: "user",
      },
      audit: { action: "created", sessionId: "s1", reason: "automatic_learning" },
    })
  })

  it("holds a procedural memory back for review", async () => {
    await record([add("m1", "procedural")])
    expect(mockBind).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ reviewStatus: "pending_instruction" }),
      })
    )
  })

  it("marks a conflict as one", async () => {
    const conflict = {
      op: "CONFLICT",
      memory: { id: "m1", type: "semantic" },
      candidate: { type: "semantic", text: "x", importance: 5 },
    } as unknown as ConsolidationOp
    await record([conflict])
    expect(mockBind).toHaveBeenCalledWith(
      expect.objectContaining({ patch: expect.objectContaining({ reviewStatus: "conflict" }) })
    )
  })

  it("skips operations that touched no row", async () => {
    const noop = { op: "NOOP", candidate: { type: "semantic", text: "x", importance: 5 } }
    await record([noop as unknown as ConsolidationOp, add("m1")])
    expect(mockBind).toHaveBeenCalledTimes(1)
    expect(mockBind).toHaveBeenCalledWith(expect.objectContaining({ memoryId: "m1" }))
  })

  it("carries contamination onto both the row and its evidence", async () => {
    await recordMemoryJobOutcome({
      job: JOB,
      operations: [add("m1")],
      contaminationState: "external-context",
      evidence: EVIDENCE,
      auditReason: "automatic_learning",
    })
    expect(mockBind).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ contaminationState: "external-context" }),
        evidence: expect.objectContaining({ contaminationState: "external-context" }),
      })
    )
  })

  // `bindMemoryGovernanceOutcome` throws when the row vanished mid-run, where
  // the old `updateMemory` silently no-opped. Failing the job would turn one
  // deleted memory into a retry loop.
  it("records the gap and keeps going when a memory was deleted mid-run", async () => {
    mockBind.mockRejectedValueOnce(new Error("Memory not found"))
    await record([add("gone"), add("m2")])
    expect(mockBind).toHaveBeenCalledTimes(2)
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: "gone",
        reason: "governance_projection_failed",
        metadata: { jobId: "job-1" },
      })
    )
  })

  it("never rejects when even the gap record fails", async () => {
    mockBind.mockRejectedValue(new Error("Memory not found"))
    mockAudit.mockRejectedValue(new Error("ledger down"))
    await expect(record([add("gone")])).resolves.toBeUndefined()
  })

  it("omits sessionId entirely for a job that has none", async () => {
    await recordMemoryJobOutcome({
      job: { id: "job-2" },
      operations: [add("m1")],
      contaminationState: "clean",
      evidence: { kind: "checkpoint", sourceId: "x" },
      auditReason: "automatic_learning",
    })
    const [call] = mockBind.mock.calls[0] as [Record<string, Record<string, unknown>>]
    expect(call.evidence).not.toHaveProperty("sessionId")
    expect(call.audit).not.toHaveProperty("sessionId")
  })
})
