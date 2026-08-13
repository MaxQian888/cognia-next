import type { CompactionCheckpointV1 } from "@cognia/rag"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import {
  loadCompactionCheckpoint,
  renderCompactionCheckpointForRecovery,
  orderCheckpointReinjection,
  storeCompactionCheckpoint,
} from "./compaction-checkpoint"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function checkpoint(): CompactionCheckpointV1 {
  return {
    schemaVersion: 1,
    id: "checkpoint-1",
    createdAt: 1,
    goal: "Complete the retrieval migration",
    completedWork: ["profile contract"],
    activeState: ["generation staging"],
    decisions: [{ decision: "fail closed", rationale: "protect local data" }],
    evidenceRefs: ["adr-0114"],
    blockers: [],
    nextSteps: ["activate generation"],
    constraints: ["preserve compatibility"],
    doNotRepeat: ["profile contract"],
    reinjection: [
      { kind: "rag", id: "chunk-1", version: "g1" },
      { kind: "policy", id: "policy-1", version: "v2" },
      { kind: "working_set", id: "session-1", version: "r3" },
    ],
    tokensBefore: 12_000,
    tokensAfter: 2_000,
  }
}

describe("compaction checkpoints", () => {
  it("stores the full checkpoint encrypted and reloads deterministic reinjection order", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ])
    const cryptoInput = {
      profileId: "profile-1",
      sessionId: "session-1",
      keyId: "dek-1",
      key,
    }
    await storeCompactionCheckpoint(checkpoint(), cryptoInput)

    const stored = await getDb().retrievalEncryptedContent.get("compaction-checkpoint:checkpoint-1")
    expect(JSON.stringify(stored)).not.toContain("Complete the retrieval migration")
    expect((await loadCompactionCheckpoint("checkpoint-1", cryptoInput))?.reinjection).toEqual([
      { kind: "policy", id: "policy-1", version: "v2" },
      { kind: "working_set", id: "session-1", version: "r3" },
      { kind: "rag", id: "chunk-1", version: "g1" },
    ])
  })

  it("rejects duplicate or unversioned reinjection refs", async () => {
    const invalid = checkpoint()
    invalid.reinjection.push({ kind: "rag", id: "chunk-1", version: "g2" })
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ])
    await expect(
      storeCompactionCheckpoint(invalid, {
        profileId: "profile-1",
        sessionId: "session-1",
        keyId: "dek-1",
        key,
      })
    ).rejects.toThrow("unique and versioned")
    expect(orderCheckpointReinjection(checkpoint())[0].kind).toBe("policy")
  })

  it("renders every checkpoint field in deterministic reinjection order", () => {
    const rendered = renderCompactionCheckpointForRecovery(checkpoint())
    expect(rendered).toContain("Goal: Complete the retrieval migration")
    expect(rendered).toContain("Completed work:")
    expect(rendered.indexOf("policy:policy-1")).toBeLessThan(
      rendered.indexOf("working_set:session-1")
    )
    expect(rendered).toContain("Token transition: 12000 -> 2000")
  })
})
