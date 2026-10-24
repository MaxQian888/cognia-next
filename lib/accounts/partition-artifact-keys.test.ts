/** @jest-environment node */

import {
  clearPartitionArtifactKeyBase,
  derivePartitionArtifactKey,
  hasPartitionArtifactKeys,
  installPartitionArtifactKeyBase,
} from "./partition-artifact-keys"

const contentKey = (byte: number) => new Uint8Array(32).fill(byte)

describe("partition artifact keys", () => {
  afterEach(() => clearPartitionArtifactKeyBase())

  it("derives stable, domain- and account-separated keys without keeping the caller's bytes", async () => {
    const key = contentKey(7)
    await installPartitionArtifactKeyBase("pb_alice", key)
    key.fill(0)
    expect(hasPartitionArtifactKeys("pb_alice")).toBe(true)
    expect(hasPartitionArtifactKeys("pb_bob")).toBe(false)

    const submissions = await derivePartitionArtifactKey("pb_alice", "work-submission")
    expect(submissions).toHaveLength(32)
    await expect(derivePartitionArtifactKey("pb_alice", "work-submission")).resolves.toEqual(
      submissions
    )
    await expect(derivePartitionArtifactKey("pb_alice", "evaluation")).resolves.not.toEqual(
      submissions
    )

    // Same content key, another account: the label separates them.
    await installPartitionArtifactKeyBase("pb_bob", contentKey(7))
    await expect(derivePartitionArtifactKey("pb_bob", "work-submission")).resolves.not.toEqual(
      submissions
    )

    // Restart with the same content key reproduces the first key.
    await installPartitionArtifactKeyBase("pb_alice", contentKey(7))
    await expect(derivePartitionArtifactKey("pb_alice", "work-submission")).resolves.toEqual(
      submissions
    )
    await installPartitionArtifactKeyBase("pb_alice", contentKey(8))
    await expect(derivePartitionArtifactKey("pb_alice", "work-submission")).resolves.not.toEqual(
      submissions
    )
  })

  it("refuses without a base, for another account, or with bad input", async () => {
    await expect(derivePartitionArtifactKey("pb_alice", "evaluation")).rejects.toThrow(
      "No partition artifact key base"
    )
    await expect(installPartitionArtifactKeyBase("", contentKey(1))).rejects.toThrow("account id")
    await expect(installPartitionArtifactKeyBase("pb_alice", new Uint8Array(16))).rejects.toThrow(
      "32 bytes"
    )
    await installPartitionArtifactKeyBase("pb_alice", contentKey(1))
    await expect(derivePartitionArtifactKey("pb_bob", "evaluation")).rejects.toThrow(
      "No partition artifact key base"
    )
    await expect(derivePartitionArtifactKey("pb_alice", "")).rejects.toThrow("artifact domain")
    clearPartitionArtifactKeyBase()
    expect(hasPartitionArtifactKeys("pb_alice")).toBe(false)
  })
})
