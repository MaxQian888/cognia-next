/** @jest-environment node */
import {
  revalidateClaim,
  buildClaimRevalidationDeps,
  type RevalidateClaimDeps,
} from "./revalidate-claim"
import type { MemoryEvidence } from "@/types/memory/governance"
import type { Memory } from "@/types/memory/memory"
import { hashContent } from "@/lib/project-knowledge/ingest/ingest-file"
import { attachmentEvidenceSourceId } from "@cognia/memory/extract/project-attachment-evidence"

const mockReadSource = jest.fn()
const mockReadProject = jest.fn()
const mockListAssets = jest.fn()
jest.mock("@/lib/db/session-assets", () => ({
  listSessionAssets: (...args: unknown[]) => mockListAssets(...args),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ messages: { get: mockReadSource }, projects: { get: mockReadProject } }),
}))
jest.mock("@/lib/db/memories", () => ({}))
jest.mock("@/lib/db/memory-governance", () => ({}))

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
  it("revalidates exact attachment content and distinguishes replacement from parser failure", async () => {
    const source = {
      messageId: "import:m1",
      partIndex: 0,
      attachmentId: "a1",
      contentHash: "a".repeat(64),
      segmentId: "s1",
      locator: JSON.stringify({ type: "page", page: 2 }),
      start: 0,
      end: EXCERPT.length,
    }
    const evidence = cite({
      kind: "file",
      sourceId: attachmentEvidenceSourceId(source),
      validationStrategy: "attachment-content-hash",
    })
    const readAttachmentExcerpt = jest.fn(async () => ({ excerpt: EXCERPT }))
    const d = deps({ listEvidence: async () => [evidence], readAttachmentExcerpt })
    await revalidateClaim("mem1", d)
    expect(d.verdicts).toEqual([{ id: "ev1", state: "valid" }])
    expect(readAttachmentExcerpt).toHaveBeenCalledWith(source)
    const replaced = deps({
      listEvidence: async () => [evidence],
      readAttachmentExcerpt: async () => undefined,
    })
    await revalidateClaim("mem1", replaced)
    expect(replaced.invalidated).toEqual(["mem1"])
    const pending = deps({
      listEvidence: async () => [evidence],
      readAttachmentExcerpt: async () => ({}),
    })
    await revalidateClaim("mem1", pending)
    expect(pending.invalidated).toEqual([])
  })

  it("binds attachment revalidation to the original bytes, part, segment, locator, and offsets", async () => {
    const source = {
      messageId: "m1",
      partIndex: 0,
      attachmentId: "a1",
      contentHash: "a".repeat(64),
      segmentId: "s1",
      locator: JSON.stringify({ type: "page", page: 2 }),
      start: 0,
      end: EXCERPT.length,
    }
    const content = {
      attachmentId: "a1",
      contentHash: "a".repeat(64),
      status: "ready",
      processor: { id: "pdf", version: "1" },
      segments: [{ id: "s1", text: EXCERPT, locator: { type: "page", page: 2 } }],
    }
    mockReadSource.mockResolvedValue({
      sessionId: "s1",
      parts: [{ type: "file", extractedContent: content }],
    })
    mockListAssets.mockResolvedValue([
      { assetId: "a1", contentHash: content.contentHash, extractedContent: content },
    ])
    const real = await buildClaimRevalidationDeps()
    expect(await real.readAttachmentExcerpt!(source)).toEqual({ excerpt: EXCERPT })
    expect(
      await real.readAttachmentExcerpt!({ ...source, contentHash: "b".repeat(64) })
    ).toBeUndefined()
    expect(await real.readAttachmentExcerpt!({ ...source, partIndex: 1 })).toBeUndefined()
    expect(
      await real.readAttachmentExcerpt!({ ...source, locator: "another page" })
    ).toBeUndefined()
    mockReadSource.mockRejectedValueOnce(new Error("storage failed"))
    await expect(real.readAttachmentExcerpt!(source)).rejects.toThrow("storage failed")
  })

  it("revokes removed assets despite the persisted transcript snapshot and reads current extraction", async () => {
    const content = {
      attachmentId: "a1",
      contentHash: "a".repeat(64),
      status: "ready",
      processor: { id: "pdf", version: "1" },
      segments: [{ id: "s1", text: EXCERPT, locator: { type: "page", page: 2 } }],
    }
    const source = {
      messageId: "m1",
      partIndex: 0,
      attachmentId: "a1",
      contentHash: content.contentHash,
      segmentId: "s1",
      locator: JSON.stringify(content.segments[0]!.locator),
      start: 0,
      end: EXCERPT.length,
    }
    mockReadSource.mockResolvedValue({
      sessionId: "s1",
      parts: [{ type: "file", extractedContent: content }],
    })
    mockListAssets.mockResolvedValue([])
    expect(
      await (
        await buildClaimRevalidationDeps()
      ).readAttachmentExcerpt!(source)
    ).toBeUndefined()
    mockListAssets.mockResolvedValue([
      {
        assetId: "a1",
        contentHash: content.contentHash,
        extractedContent: {
          ...content,
          segments: [{ ...content.segments[0], text: "Changed source: " + EXCERPT }],
        },
      },
    ])
    expect(await (await buildClaimRevalidationDeps()).readAttachmentExcerpt!(source)).toEqual({
      excerpt: ("Changed source: " + EXCERPT).slice(0, EXCERPT.length),
    })
    mockListAssets.mockRejectedValueOnce(new Error("asset database unavailable"))
    await expect(
      (await buildClaimRevalidationDeps()).readAttachmentExcerpt!(source)
    ).rejects.toThrow("asset database unavailable")
  })
  it("propagates real source read failures without caching a false deletion", async () => {
    mockReadSource.mockRejectedValueOnce(new Error("read failed")).mockResolvedValueOnce({
      parts: [{ type: "text", text: EXCERPT }],
    })
    const real = await buildClaimRevalidationDeps()
    await expect(real.readExcerpt("m2")).rejects.toThrow("read failed")
    await expect(real.readExcerpt("m2")).resolves.toMatchObject({ excerpt: EXCERPT })
  })

  it("propagates project lookup failures before deriving a different excerpt hash", async () => {
    mockReadSource.mockResolvedValue({ projectId: "p1", parts: [] })
    mockReadProject.mockRejectedValueOnce(new Error("project read failed"))
    const real = await buildClaimRevalidationDeps()
    await expect(real.readExcerpt("m2")).rejects.toThrow("project read failed")
  })
  it("confirms a claim whose source still says what it said", async () => {
    const d = deps()
    const result = await revalidateClaim("mem1", d)
    expect(result.status).toBe("revalidated")
    expect(d.verdicts).toEqual([{ id: "ev1", state: "valid" }])
    expect(d.patches[0]).toMatchObject({ staleness: "fresh", validatedAt: 5_000 })
  })

  it.each([
    ["message", "message-presence", "import:message:2", undefined],
    ["tool-result", "tool-result-hash", "import:message:2:3", 3],
  ] as const)(
    "preserves colon-bearing message ids for %s evidence",
    async (kind, strategy, sourceId, index) => {
      const partIsTool = jest.fn(() => true)
      const readExcerpt = jest.fn(async () => ({ excerpt: EXCERPT, partIsTool }))
      const d = deps({
        listEvidence: async () => [cite({ kind, sourceId, validationStrategy: strategy })],
        readExcerpt,
      })
      await revalidateClaim("mem1", d)
      expect(readExcerpt).toHaveBeenCalledWith("import:message:2")
      if (index !== undefined) expect(partIsTool).toHaveBeenCalledWith(index)
      expect(d.verdicts).toEqual([{ id: "ev1", state: "valid" }])
    }
  )

  it.each(["m2", "m2:-1", "m2:3junk"])(
    "does not certify a malformed tool anchor %s",
    async (sourceId) => {
      const d = deps({
        listEvidence: async () => [
          cite({ kind: "tool-result", sourceId, validationStrategy: "tool-result-hash" }),
        ],
      })
      await revalidateClaim("mem1", d)
      expect(d.verdicts).toEqual([{ id: "ev1", state: "unverifiable" }])
    }
  )

  it("does not revoke evidence when its storage read fails", async () => {
    const d = deps({
      readExcerpt: async () => {
        throw new Error("storage unavailable")
      },
    })
    await expect(revalidateClaim("mem1", d)).rejects.toThrow("storage unavailable")
    expect(d.invalidated).toEqual([])
    expect(d.verdicts).toEqual([])
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

  it("keeps unreviewed claims quarantined even when cited text is unchanged", async () => {
    const quarantined = deps({ getMemory: async () => claim({ trustState: "quarantined" }) })
    await revalidateClaim("mem1", quarantined)
    expect(quarantined.patches[0]).toMatchObject({ staleness: "fresh" })
    expect(quarantined.patches[0]).not.toHaveProperty("trustState")

    // A row a human marked untrusted is not promoted by a passing re-check.
    const untrusted = deps({ getMemory: async () => claim({ trustState: "untrusted" }) })
    await revalidateClaim("mem1", untrusted)
    expect(untrusted.patches[0]).not.toHaveProperty("trustState")
  })

  it("lifts quarantine after explicit review and a successful evidence recheck", async () => {
    const reviewed = deps({
      getMemory: async () => claim({ trustState: "quarantined", reviewStatus: "verified" }),
    })
    await revalidateClaim("mem1", reviewed)
    expect(reviewed.patches[0]).toMatchObject({ trustState: "trusted", staleness: "fresh" })
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
