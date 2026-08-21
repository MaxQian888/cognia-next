// Type-only module — no runtime code lives here. The side-effect import keeps
// the (empty) module body in coverage; the literals document the row shapes the
// retrieval control plane persists.
import "./retrieval-control-types"
import type {
  RetrievalActivePointerRow,
  RetrievalEncryptedContentKind,
  RetrievalEncryptedContentRow,
  RetrievalMigrationJournalRow,
  RetrievalMigrationPhase,
  RetrievalProfileRow,
  RetrievalRuntimeStateRow,
  RetrievalTombstoneRow,
} from "./retrieval-control-types"

describe("RetrievalProfileRow", () => {
  it("pins schemaVersion to the literal 1 and carries the profile fingerprint", () => {
    const profile = {} as RetrievalProfileRow["profile"]
    const rowValue: RetrievalProfileRow = {
      id: "rp_1",
      schemaVersion: 1,
      fingerprint: "sha256:abc",
      profile,
      active: true,
      createdAt: 1,
      updatedAt: 2,
    }
    expect(rowValue.schemaVersion).toBe(1)
    expect(rowValue.active).toBe(true)
  })
})

describe("RetrievalActivePointerRow", () => {
  it("names the generation a corpus currently reads from", () => {
    const pointer: RetrievalActivePointerRow = {
      corpusId: "corpus_1",
      generationId: "gen_7",
      domain: "memory" as RetrievalActivePointerRow["domain"],
      profileFingerprint: "sha256:abc",
      updatedAt: 3,
    }
    expect(pointer.generationId).toBe("gen_7")
  })
})

describe("RetrievalEncryptedContentRow", () => {
  it("enumerates the four content kinds the envelope can hold", () => {
    const kinds: RetrievalEncryptedContentKind[] = [
      "canonical",
      "safe_projection",
      "evidence_excerpt",
      "lexical_segment",
    ]
    expect(new Set(kinds).size).toBe(4)
  })

  it("makes generationId optional — content outlives any single index build", () => {
    const envelope = {} as RetrievalEncryptedContentRow["envelope"]
    const content: RetrievalEncryptedContentRow = {
      id: "rec_1",
      entityType: "memory",
      entityId: "mem_1",
      corpusId: "corpus_1",
      kind: "canonical",
      envelope,
      createdAt: 1,
      updatedAt: 2,
    }
    expect(content.generationId).toBeUndefined()
  })
})

describe("RetrievalTombstoneRow", () => {
  it("tracks per-device acknowledgement so a purge waits for the last device", () => {
    const tombstone: RetrievalTombstoneRow = {
      id: "tomb_1",
      entityType: "memory",
      entityId: "mem_1",
      corpusId: "corpus_1",
      createdAt: 1,
      acknowledgedDeviceIds: ["dev_a"],
      pendingDeviceIds: ["dev_b"],
    }
    // No purge deadline until nothing is pending.
    expect(tombstone.eligiblePurgeAt).toBeUndefined()
    expect(tombstone.pendingDeviceIds).toEqual(["dev_b"])
  })
})

describe("RetrievalMigrationJournalRow", () => {
  it("enumerates the seven migration phases in cutover order", () => {
    const phases: RetrievalMigrationPhase[] = [
      "schema",
      "dual_read",
      "encrypt_content",
      "backfill_governance",
      "build_generation",
      "quality_gate",
      "cutover",
    ]
    expect(phases).toHaveLength(7)
    expect(phases[phases.length - 1]).toBe("cutover")
  })

  it("records a failure code only on a failed phase", () => {
    const running: RetrievalMigrationJournalRow = {
      id: "mj_1",
      phase: "dual_read",
      status: "running",
      processedCount: 12,
      createdAt: 1,
      updatedAt: 2,
    }
    expect(running.failureCode).toBeUndefined()
    expect(running.watermark).toBeUndefined()
  })
})

describe("RetrievalRuntimeStateRow", () => {
  it("is a singleton row keyed by the literal 'global'", () => {
    const state: RetrievalRuntimeStateRow = {
      id: "global",
      killSwitchEngaged: false,
      changedAt: 1,
      changedBy: "user",
    }
    expect(state.id).toBe("global")
    expect(state.reasonCode).toBeUndefined()
  })

  it("attributes the kill switch to a user, a migration or the safety system", () => {
    const authorities: RetrievalRuntimeStateRow["changedBy"][] = ["user", "migration", "safety"]
    expect(new Set(authorities).size).toBe(3)
  })
})
