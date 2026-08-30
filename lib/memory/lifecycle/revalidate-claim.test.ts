/** @jest-environment node */
import { revalidateClaim, type RevalidateClaimDeps } from "./revalidate-claim"
import type { MemoryEvidence } from "@/types/memory/governance"
import type { Memory } from "@/types/memory/memory"
import { hashContent } from "@/lib/project-knowledge/ingest/ingest-file"

const EXCERPT = "packages/memory pins Rust to 1.77.2"

function claim(over: Partial<Memory> = {}): Memory {
  return {
    id: "mem1",
    scope: "workspace",
    type: "semantic",
    text: "The repo pins Rust to 1.77.2",
    tags: [],
    importance: 7,
    createdAt: 1,
    updatedAt: 1,
    lastAccessedAt: 1,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    projectMemoryKind: "constraint",
    ...over,
  } as Memory
}

function cite(over: Partial<MemoryEvidence> = {}): MemoryEvidence {
  return {
    id: "ev1",
    memoryId: "mem1",
    kind: "message",
    sourceId: "m2",
    contaminationState: "clean",
    reviewed: false,
    createdAt: 1,
    validationStrategy: "message-presence",
    excerptHash: hashContent(EXCERPT),
    ...over,
  } as MemoryEvidence
}

function deps(over: Partial<RevalidateClaimDeps> = {}): RevalidateClaimDeps & {
  verdicts: { id: string; state: string }[]
  patches: Record<string, unknown>[]
  invalidated: string[]
} {
  const verdicts: { id: string; state: string }[] = []
  const patches: Record<string, unknown>[] = []
  const invalidated: string[] = []
  return {
    verdicts,
    patches,
    invalidated,
    getMemory: async () => claim(),
    listEvidence: async () => [cite()],
    readExcerpt: async () => ({ excerpt: EXCERPT, partIsTool: () => true }),
    recordVerdict: async (id, verdict) => {
      verdicts.push({ id, state: String(verdict.validationState) })
    },
    patchMemory: async (_id, patch) => {
      patches.push(patch as Record<string, unknown>)
    },
    invalidateMemory: async (id) => {
      invalidated.push(id)
    },
    now: () => 5_000,
    ...over,
  }
}

describe("revalidateClaim", () => {
  it("confirms a claim whose source still says what it said", async () => {
    const d = deps()
    const result = await revalidateClaim("mem1", d)
    expect(result.status).toBe("revalidated")
    expect(d.verdicts).toEqual([{ id: "ev1", state: "valid" }])
    expect(d.patches[0]).toMatchObject({ staleness: "fresh", validatedAt: 5_000 })
  })

  it("revokes and invalidates when the source message is gone", async () => {
    // This is the case the sweep exists for: a claim whose evidence was deleted
    // must stop being injected, not go on being recalled at full confidence.
    const d = deps({ readExcerpt: async () => undefined })
    const result = await revalidateClaim("mem1", d)
    expect(d.verdicts).toEqual([{ id: "ev1", state: "revoked" }])
    expect(result.status).toBe("invalidated")
    expect(d.invalidated).toEqual(["mem1"])
  })

  it("revokes when the source message no longer hashes the same", async () => {
    const d = deps({
      readExcerpt: async () => ({ excerpt: "the repo now pins Rust 1.90", partIsTool: () => true }),
    })
    expect((await revalidateClaim("mem1", d)).status).toBe("invalidated")
  })

  it("revokes a tool citation whose cited part is no longer a tool part", async () => {
    const d = deps({
      listEvidence: async () => [
        cite({ kind: "tool-result", sourceId: "m2:3", validationStrategy: "tool-result-hash" }),
      ],
      readExcerpt: async () => ({ excerpt: EXCERPT, partIsTool: () => false }),
    })
    expect(d.invalidated).toEqual([])
    expect((await revalidateClaim("mem1", d)).status).toBe("invalidated")
  })

  it("leaves an unhashed citation unvalidated rather than revoking it", async () => {
    // Pre-hash rows and restored backups carry descriptors but no hash. "We
    // cannot check this" is not "this is false".
    const d = deps({ listEvidence: async () => [cite({ excerptHash: undefined })] })
    const result = await revalidateClaim("mem1", d)
    expect(d.verdicts).toEqual([{ id: "ev1", state: "unvalidated" }])
    expect(result.status).toBe("revalidated")
    expect(d.patches[0]).toMatchObject({ staleness: "stale" })
  })

  it("reports a code-location citation as unverifiable, never as false", async () => {
    const d = deps({
      listEvidence: async () => [
        cite({ kind: "code-location", sourceId: "next.config.ts", validationStrategy: "none" }),
      ],
    })
    const result = await revalidateClaim("mem1", d)
    expect(d.verdicts).toEqual([{ id: "ev1", state: "unverifiable" }])
    // Nothing countable survives, so the row is invalidated by the arithmetic —
    // but the citation itself was never called false.
    expect(result.verdict?.revoked).toBe(false)
  })

  it("honours a human confirmation through the row's own review status", async () => {
    const d = deps({
      getMemory: async () => claim({ reviewStatus: "verified" }),
      listEvidence: async () => [
        cite({ kind: "manual", validationStrategy: "user-confirmation", excerptHash: undefined }),
      ],
    })
    expect((await revalidateClaim("mem1", d)).status).toBe("revalidated")
    expect(d.verdicts).toEqual([{ id: "ev1", state: "valid" }])
  })

  it("lifts quarantine only on evidence, and only upward", async () => {
    const quarantined = deps({ getMemory: async () => claim({ trustState: "quarantined" }) })
    await revalidateClaim("mem1", quarantined)
    expect(quarantined.patches[0]).toMatchObject({ trustState: "trusted" })

    // A row a human marked untrusted is not promoted by a passing re-check.
    const untrusted = deps({ getMemory: async () => claim({ trustState: "untrusted" }) })
    await revalidateClaim("mem1", untrusted)
    expect(untrusted.patches[0]).not.toHaveProperty("trustState")
  })

  it("never touches a personal memory", async () => {
    // Personal rows have no citation model; sweeping them would invalidate on
    // evidence they were never expected to have.
    const d = deps({ getMemory: async () => claim({ projectMemoryKind: undefined }) })
    expect(await revalidateClaim("mem1", d)).toEqual({
      status: "skipped",
      reason: "not_a_project_claim",
    })
    expect(d.invalidated).toEqual([])
  })

  it("skips an already-invalidated row instead of re-invalidating it", async () => {
    const d = deps({ getMemory: async () => claim({ status: "invalidated" }) })
    expect((await revalidateClaim("mem1", d)).reason).toBe("already_invalidated")
  })

  it("skips a claim with no citations rather than deleting it", async () => {
    const d = deps({ listEvidence: async () => [] })
    expect((await revalidateClaim("mem1", d)).reason).toBe("no_evidence")
    expect(d.invalidated).toEqual([])
  })

  it("does not rewrite a verdict that has not changed", async () => {
    const d = deps({ listEvidence: async () => [cite({ validationState: "valid" })] })
    await revalidateClaim("mem1", d)
    expect(d.verdicts).toEqual([])
  })
})
