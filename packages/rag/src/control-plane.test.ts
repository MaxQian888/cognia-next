import {
  RetrievalJobTransitionError,
  activateValidatedGeneration,
  canClaimRetrievalJob,
  claimRetrievalJob,
  createIndexGeneration,
  createRetrievalJob,
  decryptContentEnvelope,
  encryptContentEnvelope,
  heartbeatRetrievalJob,
  transitionRetrievalJob,
} from "./control-plane"

describe("retrieval control plane", () => {
  it("only activates a validated generation and retires the previous active generation", () => {
    const previous = createIndexGeneration({
      id: "g1",
      corpusId: "project:1",
      domain: "project",
      profileFingerprint: "fp",
      createdAt: 1,
      status: "active",
    })
    const staging = createIndexGeneration({
      id: "g2",
      corpusId: "project:1",
      domain: "project",
      profileFingerprint: "fp",
      createdAt: 2,
    })

    expect(() => activateValidatedGeneration(staging, previous, 3)).toThrow(
      "Generation must be validating"
    )

    const validating = {
      ...staging,
      status: "validating" as const,
      validation: { count: 10, contentHash: "hash", dimensions: 2, valid: true },
    }
    const switched = activateValidatedGeneration(validating, previous, 3)
    expect(switched.active).toMatchObject({ id: "g2", status: "active", activatedAt: 3 })
    expect(switched.retired).toMatchObject({ id: "g1", status: "retiring", retiredAt: 3 })
  })

  it("supports lease claim, heartbeat, retry_wait, cancellation, and terminal guards", () => {
    const queued = createRetrievalJob({
      id: "job-1",
      dedupeKey: "project:1:fp",
      kind: "reindex",
      corpusId: "project:1",
      queuedAt: 100,
      maxAttempts: 3,
    })
    expect(canClaimRetrievalJob(queued, 100)).toBe(true)

    const running = claimRetrievalJob(queued, "worker", 100, 50)
    expect(running).toMatchObject({ status: "running", attempt: 1, leaseExpiresAt: 150 })
    expect(heartbeatRetrievalJob(running, "worker", 120, 50).leaseExpiresAt).toBe(170)

    const waiting = transitionRetrievalJob(running, "retry_wait", 130, {
      resultCode: "vector_unavailable",
      nextAttemptAt: 230,
    })
    expect(canClaimRetrievalJob(waiting, 229)).toBe(false)
    expect(canClaimRetrievalJob(waiting, 230)).toBe(true)

    const cancelled = transitionRetrievalJob(waiting, "cancelled", 140, {
      resultCode: "cancelled_by_user",
    })
    expect(() => transitionRetrievalJob(cancelled, "running", 150)).toThrow(
      RetrievalJobTransitionError
    )
  })

  it("round-trips an AES-256-GCM envelope with bound AAD and rejects wrong AAD", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ])
    const envelope = await encryptContentEnvelope("canonical text", {
      key,
      keyId: "dek-1",
      additionalData: "memory:mem-1:content",
    })

    expect(envelope).toEqual(
      expect.objectContaining({ version: 1, algorithm: "AES-256-GCM", keyId: "dek-1" })
    )
    expect(JSON.stringify(envelope)).not.toContain("canonical text")
    await expect(
      decryptContentEnvelope(envelope, { key, additionalData: "memory:mem-1:content" })
    ).resolves.toBe("canonical text")
    await expect(
      decryptContentEnvelope(envelope, { key, additionalData: "memory:mem-2:content" })
    ).rejects.toThrow("AAD hash mismatch")
  })
})
