/**
 * Integration coverage for the five Employee Digital Twin Dexie tables and
 * their CRUD modules. Lives next to `lib/db/twin-{sources,chunks,profile,
 * drafts,jobs}.ts`. Hits the schema-version-14 indexes, multi-twin isolation,
 * cascade deletes, and the twinJobs FIFO claim path.
 */

import "fake-indexeddb/auto"
import {
  createTwinSource,
  deleteAllTwinSourcesForTwin,
  deleteTwinSource,
  findTwinSourceByFingerprint,
  getTwinSource,
  getTwinSourcesByIds,
  listTwinSourcesByTwin,
  listTwinSourcesByTwinAndKind,
  listTwinSourcesByTwinAndStatus,
  updateTwinSource,
} from "./twin-sources"
import {
  bulkCreateTwinChunks,
  countTwinChunksByTwin,
  createTwinChunk,
  deleteTwinChunk,
  deleteTwinChunksBySource,
  getTwinChunk,
  getTwinChunkByVectorDocId,
  getTwinChunksByIds,
  getTwinChunksByVectorDocIds,
  listTwinChunksBySource,
  listTwinChunksByTwin,
  updateTwinChunk,
} from "./twin-chunks"
import {
  appendDecisions,
  appendPlaybooks,
  appendStyleSamples,
  deleteTwinProfile,
  ensureTwinProfile,
  getTwinProfile,
  resetTwinProfile,
  setTwinProfile,
  setVoiceSummary,
  upsertEntities,
} from "./twin-profile"
import {
  bulkCreateTwinDrafts,
  createTwinDraft,
  deleteTwinDraft,
  deleteTwinDraftsByJob,
  getTwinDraft,
  listPendingTwinDraftsSortedByQuality,
  listTwinDraftsByTwin,
  listTwinDraftsByTwinAndKind,
  listTwinDraftsByTwinAndStatus,
  markTwinDraftAccepted,
  markTwinDraftRejected,
  updateTwinDraft,
} from "./twin-drafts"
import {
  claimNextQueuedJob,
  completeJob,
  createTwinJob,
  deleteTwinJob,
  failJob,
  getTwinJob,
  listActiveJobsByTwin,
  listJobsByTwinAndKind,
  listJobsByTwinAndStatus,
  listTwinJobsByTwin,
  releaseClaim,
  requeueJob,
  updateJobProgress,
} from "./twin-jobs"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  // The twin tables seed nothing; just clear to be safe.
  const db = getDb()
  await Promise.all([
    db.twinSources.clear(),
    db.twinChunks.clear(),
    db.twinProfile.clear(),
    db.twinDrafts.clear(),
    db.twinJobs.clear(),
  ])
})

// ─────────────────────────────────────────────────────────────────────────────
// twinSources
// ─────────────────────────────────────────────────────────────────────────────

describe("twinSources CRUD", () => {
  const baseDraft = {
    twinId: "twin_alice",
    kind: "document" as const,
    format: "markdown" as const,
    source: "/notes/onboarding.md",
    title: "Onboarding notes",
    bytes: 4096,
    fingerprint: "sha256:aaa",
    redacted: false,
  }

  it("creates a source with sensible defaults", async () => {
    const src = await createTwinSource(baseDraft)
    expect(src.id).toMatch(/^tws_/)
    expect(src.status).toBe("pending")
    expect(src.chunkCount).toBe(0)
    expect(src.importedAt).toBeGreaterThan(0)
  })

  it("round-trips via getTwinSource", async () => {
    const created = await createTwinSource(baseDraft)
    const fetched = await getTwinSource(created.id)
    expect(fetched).toEqual(created)
  })

  it("persists import-time speakers and omits them when absent", async () => {
    const withSpeakers = await createTwinSource({
      ...baseDraft,
      fingerprint: "sha256:spk",
      speakers: ["Alice Zhang", "张伟"],
    })
    const fetched = await getTwinSource(withSpeakers.id)
    expect(fetched?.speakers).toEqual(["Alice Zhang", "张伟"])

    const without = await createTwinSource({ ...baseDraft, fingerprint: "sha256:nospk" })
    const fetchedWithout = await getTwinSource(without.id)
    expect(fetchedWithout?.speakers).toBeUndefined()
  })

  it("filters by twinId + kind / status", async () => {
    const a = await createTwinSource(baseDraft)
    const b = await createTwinSource({ ...baseDraft, kind: "chat", format: "claude-export" })
    await createTwinSource({ ...baseDraft, twinId: "twin_bob", kind: "document" })

    const aliceDocs = await listTwinSourcesByTwinAndKind("twin_alice", "document")
    expect(aliceDocs.map((r) => r.id)).toEqual([a.id])

    const aliceChats = await listTwinSourcesByTwinAndKind("twin_alice", "chat")
    expect(aliceChats.map((r) => r.id)).toEqual([b.id])

    const pendingAlice = await listTwinSourcesByTwinAndStatus("twin_alice", "pending")
    expect(pendingAlice).toHaveLength(2)
  })

  it("listTwinSourcesByTwin returns newest first", async () => {
    const older = await createTwinSource({ ...baseDraft, fingerprint: "sha256:old" })
    // Force a clearly later timestamp.
    await new Promise((r) => setTimeout(r, 5))
    const newer = await createTwinSource({ ...baseDraft, fingerprint: "sha256:new" })
    const list = await listTwinSourcesByTwin("twin_alice")
    expect(list.map((r) => r.id)).toEqual([newer.id, older.id])
  })

  it("findTwinSourceByFingerprint isolates by twinId (compound index)", async () => {
    await createTwinSource(baseDraft)
    await createTwinSource({ ...baseDraft, twinId: "twin_bob", fingerprint: "sha256:aaa" })
    const aliceHit = await findTwinSourceByFingerprint("twin_alice", "sha256:aaa")
    expect(aliceHit?.twinId).toBe("twin_alice")
    const bobHit = await findTwinSourceByFingerprint("twin_bob", "sha256:aaa")
    expect(bobHit?.twinId).toBe("twin_bob")
    // A fingerprint that exists only under another twin must not leak across.
    expect(await findTwinSourceByFingerprint("twin_carol", "sha256:aaa")).toBeUndefined()
  })

  it("getTwinSourcesByIds batch-fetches in one round-trip, dropping missing ids", async () => {
    const a = await createTwinSource({ ...baseDraft, fingerprint: "fp-a" })
    const b = await createTwinSource({ ...baseDraft, fingerprint: "fp-b" })
    const rows = await getTwinSourcesByIds([a.id, "tws_missing", b.id])
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort())
    expect(await getTwinSourcesByIds([])).toEqual([])
  })

  it("updateTwinSource patches fields and returns the new row", async () => {
    const src = await createTwinSource(baseDraft)
    const updated = await updateTwinSource(src.id, { status: "parsed", chunkCount: 12 })
    expect(updated?.status).toBe("parsed")
    expect(updated?.chunkCount).toBe(12)
  })

  it("deleteTwinSource cascades to chunks", async () => {
    const src = await createTwinSource(baseDraft)
    await createTwinChunk(buildChunkDraft(src.id, "twin_alice", "doc-1"))
    await createTwinChunk(buildChunkDraft(src.id, "twin_alice", "doc-2"))
    await deleteTwinSource(src.id)
    expect(await getTwinSource(src.id)).toBeUndefined()
    expect(await listTwinChunksBySource(src.id)).toEqual([])
  })

  it("deleteAllTwinSourcesForTwin wipes both sources and chunks for that twin", async () => {
    const aliceSrc = await createTwinSource(baseDraft)
    await createTwinChunk(buildChunkDraft(aliceSrc.id, "twin_alice", "doc-keep-me"))
    const bobSrc = await createTwinSource({ ...baseDraft, twinId: "twin_bob" })
    await createTwinChunk(buildChunkDraft(bobSrc.id, "twin_bob", "bob-chunk"))

    await deleteAllTwinSourcesForTwin("twin_alice")

    expect(await listTwinSourcesByTwin("twin_alice")).toEqual([])
    expect(await listTwinChunksByTwin("twin_alice")).toEqual([])
    // Bob untouched.
    expect((await listTwinSourcesByTwin("twin_bob")).map((r) => r.id)).toEqual([bobSrc.id])
    expect(await countTwinChunksByTwin("twin_bob")).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// twinChunks
// ─────────────────────────────────────────────────────────────────────────────

function buildChunkDraft(sourceId: string, twinId: string, vectorDocId: string) {
  return {
    twinId,
    sourceId,
    content: `original ${vectorDocId}`,
    contentRedacted: `redacted ${vectorDocId}`,
    charStart: 0,
    charEnd: 100,
    vectorBackend: "qdrant" as const,
    vectorCollection: `cognia_twin_${twinId}`,
    vectorDocId,
    strategy: "paragraph" as const,
    tokenCount: 25,
    metadata: { headingPath: ["Onboarding"] },
  }
}

describe("twinChunks CRUD", () => {
  it("bulkCreateTwinChunks writes everything and round-trips", async () => {
    const drafts = [
      buildChunkDraft("src_1", "twin_alice", "v1"),
      buildChunkDraft("src_1", "twin_alice", "v2"),
      buildChunkDraft("src_1", "twin_alice", "v3"),
    ]
    const rows = await bulkCreateTwinChunks(drafts)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.id.startsWith("twc_"))).toBe(true)

    const ids = rows.map((r) => r.id)
    expect(await getTwinChunksByIds(ids)).toHaveLength(3)
  })

  it("bulkCreateTwinChunks short-circuits on empty input", async () => {
    expect(await bulkCreateTwinChunks([])).toEqual([])
    expect(await getTwinChunksByIds([])).toEqual([])
    expect(await getTwinChunksByVectorDocIds([])).toEqual([])
  })

  it("getTwinChunkByVectorDocId hits the unique index", async () => {
    await bulkCreateTwinChunks([
      buildChunkDraft("src_1", "twin_alice", "needle"),
      buildChunkDraft("src_1", "twin_alice", "v2"),
    ])
    const hit = await getTwinChunkByVectorDocId("needle")
    expect(hit?.vectorDocId).toBe("needle")
  })

  it("getTwinChunksByVectorDocIds returns all matches in any order", async () => {
    await bulkCreateTwinChunks([
      buildChunkDraft("src_1", "twin_alice", "a"),
      buildChunkDraft("src_1", "twin_alice", "b"),
      buildChunkDraft("src_1", "twin_alice", "c"),
    ])
    const hits = await getTwinChunksByVectorDocIds(["a", "c"])
    expect(hits.map((r) => r.vectorDocId).sort()).toEqual(["a", "c"])
  })

  it("listTwinChunksByTwin honours offset / limit", async () => {
    await bulkCreateTwinChunks(
      Array.from({ length: 5 }, (_, i) => buildChunkDraft("src_1", "twin_alice", `id-${i}`))
    )
    const sliced = await listTwinChunksByTwin("twin_alice", { offset: 1, limit: 2 })
    expect(sliced).toHaveLength(2)
  })

  it("updateTwinChunk mutates non-immutable fields", async () => {
    const c = await createTwinChunk(buildChunkDraft("src_1", "twin_alice", "u1"))
    const updated = await updateTwinChunk(c.id, { entityTags: ["alice", "ProjectX"] })
    expect(updated?.entityTags).toEqual(["alice", "ProjectX"])
  })

  it("getTwinChunk + deleteTwinChunk round-trip", async () => {
    const c = await createTwinChunk(buildChunkDraft("src_1", "twin_alice", "del"))
    expect(await getTwinChunk(c.id)).toBeDefined()
    await deleteTwinChunk(c.id)
    expect(await getTwinChunk(c.id)).toBeUndefined()
  })

  it("deleteTwinChunksBySource removes only that source's chunks", async () => {
    await bulkCreateTwinChunks([
      buildChunkDraft("src_a", "twin_alice", "a1"),
      buildChunkDraft("src_a", "twin_alice", "a2"),
      buildChunkDraft("src_b", "twin_alice", "b1"),
    ])
    expect(await deleteTwinChunksBySource("src_a")).toBe(2)
    expect(await listTwinChunksBySource("src_a")).toEqual([])
    expect((await listTwinChunksBySource("src_b")).map((r) => r.vectorDocId)).toEqual(["b1"])
  })

  it("countTwinChunksByTwin isolates per twin", async () => {
    await bulkCreateTwinChunks([
      buildChunkDraft("src_a", "twin_alice", "a"),
      buildChunkDraft("src_b", "twin_bob", "b"),
    ])
    expect(await countTwinChunksByTwin("twin_alice")).toBe(1)
    expect(await countTwinChunksByTwin("twin_bob")).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// twinProfile
// ─────────────────────────────────────────────────────────────────────────────

describe("twinProfile CRUD", () => {
  it("ensureTwinProfile creates an empty profile when missing", async () => {
    const profile = await ensureTwinProfile("twin_alice")
    expect(profile.id).toBe("twin_alice")
    expect(profile.styleSamples).toEqual([])
    expect(profile.playbooks).toEqual([])
    expect(profile.entities).toEqual([])
    expect(profile.decisions).toEqual([])
    expect(profile.voiceSummary).toBe("")
  })

  it("ensureTwinProfile returns the existing row when present", async () => {
    const first = await ensureTwinProfile("twin_alice")
    const second = await ensureTwinProfile("twin_alice")
    expect(first.id).toBe(second.id)
    expect(first.updatedAt).toBe(second.updatedAt)
  })

  it("setVoiceSummary persists the new voice", async () => {
    await setVoiceSummary("twin_alice", "Concise. Pragmatic. Pun-averse.")
    const profile = await getTwinProfile("twin_alice")
    expect(profile?.voiceSummary).toContain("Pragmatic")
  })

  it("appendStyleSamples writes embeddings when an embeddingFn is provided", async () => {
    const fn = jest.fn(async (text: string) => (text === "summary one" ? [0.1, 0.2] : [0.3, 0.4]))
    await appendStyleSamples(
      "twin_alice",
      [
        {
          id: "s1",
          contextLabel: "test",
          original: "original one",
          summary: "summary one",
          sourceChunkId: "c1",
          tone: ["concise"],
          addedAt: 1,
          addedBy: "distill",
        },
        {
          id: "s2",
          contextLabel: "test",
          original: "original two",
          summary: "summary two",
          sourceChunkId: "c2",
          tone: ["warm"],
          addedAt: 2,
          addedBy: "distill",
        },
      ],
      { embeddingFn: fn }
    )
    expect(fn).toHaveBeenCalledTimes(2)
    const profile = await getTwinProfile("twin_alice")
    expect(profile?.styleSamples[0].embedding).toEqual([0.1, 0.2])
    expect(profile?.styleSamples[1].embedding).toEqual([0.3, 0.4])
  })

  it("appendStyleSamples writes no embedding when embeddingFn is omitted", async () => {
    await appendStyleSamples("twin_alice", [
      {
        id: "s3",
        contextLabel: "test",
        original: "original",
        summary: "x",
        sourceChunkId: "c3",
        tone: [],
        addedAt: 3,
        addedBy: "distill",
      },
    ])
    const profile = await getTwinProfile("twin_alice")
    expect(profile?.styleSamples.find((s) => s.id === "s3")?.embedding).toBeUndefined()
  })

  it("appendStyleSamples persists samples even when embeddingFn rejects per-sample", async () => {
    const fn = jest.fn(async (text: string) => {
      if (text === "ok-summary") return [0.5, 0.5]
      throw new Error("embed failed")
    })
    await appendStyleSamples(
      "twin_alice",
      [
        {
          id: "s4",
          contextLabel: "test",
          original: "original ok",
          summary: "ok-summary",
          sourceChunkId: "c4",
          tone: [],
          addedAt: 4,
          addedBy: "distill",
        },
        {
          id: "s5",
          contextLabel: "test",
          original: "original broken",
          summary: "broken",
          sourceChunkId: "c5",
          tone: [],
          addedAt: 5,
          addedBy: "distill",
        },
      ],
      { embeddingFn: fn }
    )
    const profile = await getTwinProfile("twin_alice")
    expect(profile?.styleSamples.find((s) => s.id === "s4")?.embedding).toEqual([0.5, 0.5])
    expect(profile?.styleSamples.find((s) => s.id === "s5")?.embedding).toBeUndefined()
  })

  it("appendStyleSamples / appendPlaybooks / appendDecisions accumulate without dedupe", async () => {
    await appendStyleSamples("twin_alice", [
      {
        id: "ss_1",
        contextLabel: "rejection-email",
        original: "Sorry, can't do that.",
        summary: "rejection",
        sourceChunkId: "c1",
        tone: ["concise"],
        addedAt: 1,
        addedBy: "distill",
      },
    ])
    await appendStyleSamples("twin_alice", [
      {
        id: "ss_2",
        contextLabel: "approval",
        original: "Yes — happy to help.",
        summary: "approval",
        sourceChunkId: "c2",
        tone: ["warm"],
        addedAt: 2,
        addedBy: "distill",
      },
    ])
    await appendPlaybooks("twin_alice", [
      {
        id: "pb_1",
        title: "Triage P1",
        trigger: "Someone reports outage",
        steps: [{ order: 1, action: "Acknowledge" }],
        examples: [],
        confidence: 0.7,
      },
    ])
    await appendDecisions("twin_alice", [
      {
        id: "d_1",
        context: "Pick logger",
        choice: "pino",
        rationale: "Performant",
        sourceChunkIds: ["c3"],
      },
    ])
    const profile = await getTwinProfile("twin_alice")
    expect(profile?.styleSamples.map((s) => s.id)).toEqual(["ss_1", "ss_2"])
    expect(profile?.playbooks.map((p) => p.id)).toEqual(["pb_1"])
    expect(profile?.decisions.map((d) => d.id)).toEqual(["d_1"])
  })

  it("upsertEntities deduplicates by lowercase name and keeps the latest record", async () => {
    await upsertEntities("twin_alice", [
      {
        name: "Alice",
        aliases: [],
        role: "person",
        firstSeenChunkId: "c1",
      },
    ])
    await upsertEntities("twin_alice", [
      {
        name: "alice",
        aliases: ["alice@example.com"],
        role: "person",
        firstSeenChunkId: "c2",
      },
    ])
    const profile = await getTwinProfile("twin_alice")
    expect(profile?.entities).toHaveLength(1)
    expect(profile?.entities[0].aliases).toContain("alice@example.com")
  })

  it("setTwinProfile overwrites and bumps updatedAt", async () => {
    const initial = await ensureTwinProfile("twin_alice")
    const before = initial.updatedAt
    // Force a clock tick.
    await new Promise((r) => setTimeout(r, 5))
    await setTwinProfile({ ...initial, voiceSummary: "v2" })
    const after = await getTwinProfile("twin_alice")
    expect(after?.voiceSummary).toBe("v2")
    expect(after?.updatedAt).toBeGreaterThanOrEqual(before)
  })

  it("resetTwinProfile wipes the row back to empty", async () => {
    await ensureTwinProfile("twin_alice")
    await setVoiceSummary("twin_alice", "filled")
    await resetTwinProfile("twin_alice")
    const cleared = await getTwinProfile("twin_alice")
    expect(cleared?.voiceSummary).toBe("")
    expect(cleared?.styleSamples).toEqual([])
  })

  it("deleteTwinProfile removes the row entirely", async () => {
    await ensureTwinProfile("twin_alice")
    await deleteTwinProfile("twin_alice")
    expect(await getTwinProfile("twin_alice")).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// twinDrafts
// ─────────────────────────────────────────────────────────────────────────────

function buildDraft(overrides: Partial<Parameters<typeof createTwinDraft>[0]> = {}) {
  return {
    twinId: "twin_alice",
    jobId: "job_1",
    kind: "skill" as const,
    payload: {
      kind: "skill" as const,
      data: { name: "Triage P1" },
    },
    provenance: { chunkIds: ["c1"], rationale: "frequent pattern" },
    ...overrides,
  }
}

describe("twinDrafts CRUD", () => {
  it("create / get round-trip with default status", async () => {
    const created = await createTwinDraft(buildDraft())
    expect(created.status).toBe("pending")
    expect(created.id).toMatch(/^twd_/)
    expect(await getTwinDraft(created.id)).toEqual(created)
  })

  it("bulkCreateTwinDrafts honours empty input", async () => {
    expect(await bulkCreateTwinDrafts([])).toEqual([])
  })

  it("bulkCreateTwinDrafts accepts mixed kinds", async () => {
    const rows = await bulkCreateTwinDrafts([
      buildDraft(),
      buildDraft({
        kind: "character",
        payload: { kind: "character", data: { name: "Twin Alice" } },
      }),
    ])
    expect(rows).toHaveLength(2)
    const skills = await listTwinDraftsByTwinAndKind("twin_alice", "skill")
    const characters = await listTwinDraftsByTwinAndKind("twin_alice", "character")
    expect(skills).toHaveLength(1)
    expect(characters).toHaveLength(1)
  })

  it("listPendingTwinDraftsSortedByQuality places lowest score first, unscored last", async () => {
    await createTwinDraft({
      ...buildDraft(),
      evaluation: { qualityScore: 0.9, concerns: [], suggestions: [] },
    })
    await createTwinDraft({
      ...buildDraft(),
      evaluation: { qualityScore: 0.2, concerns: ["thin"], suggestions: [] },
    })
    await createTwinDraft(buildDraft()) // no evaluation
    const sorted = await listPendingTwinDraftsSortedByQuality("twin_alice")
    expect(sorted.map((d) => d.evaluation?.qualityScore ?? null)).toEqual([0.2, 0.9, null])
  })

  it("markTwinDraftAccepted / Rejected stamps reviewedAt", async () => {
    const draft = await createTwinDraft(buildDraft())
    const accepted = await markTwinDraftAccepted(draft.id, "skill_xyz", "looks good")
    expect(accepted?.status).toBe("accepted")
    expect(accepted?.acceptedAsId).toBe("skill_xyz")
    expect(accepted?.reviewerNote).toBe("looks good")
    expect(accepted?.reviewedAt).toBeGreaterThan(0)

    const other = await createTwinDraft(buildDraft())
    const rejected = await markTwinDraftRejected(other.id, "duplicate")
    expect(rejected?.status).toBe("rejected")
    expect(rejected?.reviewerNote).toBe("duplicate")
  })

  it("updateTwinDraft applies arbitrary patches", async () => {
    const draft = await createTwinDraft(buildDraft())
    const patched = await updateTwinDraft(draft.id, {
      evaluation: { qualityScore: 0.5, concerns: ["thin"], suggestions: [] },
    })
    expect(patched?.evaluation?.qualityScore).toBe(0.5)
  })

  it("listTwinDraftsByTwin / Status / Kind respect twinId scoping", async () => {
    await createTwinDraft(buildDraft())
    await createTwinDraft(buildDraft({ twinId: "twin_bob" }))
    expect(await listTwinDraftsByTwin("twin_alice")).toHaveLength(1)
    expect(await listTwinDraftsByTwin("twin_bob")).toHaveLength(1)
    expect(await listTwinDraftsByTwinAndStatus("twin_alice", "pending")).toHaveLength(1)
  })

  it("deleteTwinDraft / deleteTwinDraftsByJob remove targeted rows", async () => {
    const a = await createTwinDraft(buildDraft({ jobId: "job_a" }))
    await createTwinDraft(buildDraft({ jobId: "job_a" }))
    await createTwinDraft(buildDraft({ jobId: "job_b" }))
    expect(await deleteTwinDraftsByJob("job_a")).toBe(2)
    await deleteTwinDraft(a.id) // already gone — should not throw
    expect((await listTwinDraftsByTwin("twin_alice")).map((d) => d.jobId)).toEqual(["job_b"])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// twinJobs
// ─────────────────────────────────────────────────────────────────────────────

describe("twinJobs CRUD + scheduler", () => {
  it("createTwinJob defaults to queued/0 progress", async () => {
    const job = await createTwinJob({
      twinId: "twin_alice",
      kind: "ingest",
      sourceIds: ["src_1"],
    })
    expect(job.status).toBe("queued")
    expect(job.progress).toBe(0)
    expect(job.retryCount).toBe(0)
    expect(job.id).toMatch(/^twj_/)
  })

  it("listTwinJobsByTwin / Kind / Status filter by composite indexes", async () => {
    const jobA = await createTwinJob({
      twinId: "twin_alice",
      kind: "ingest",
      sourceIds: [],
    })
    await createTwinJob({ twinId: "twin_alice", kind: "distill", sourceIds: [] })
    await createTwinJob({ twinId: "twin_bob", kind: "ingest", sourceIds: [] })

    expect((await listTwinJobsByTwin("twin_alice")).length).toBe(2)
    expect((await listJobsByTwinAndKind("twin_alice", "ingest"))[0].id).toBe(jobA.id)
    expect((await listJobsByTwinAndStatus("twin_alice", "queued")).length).toBe(2)
  })

  it("listActiveJobsByTwin returns queued + running + paused, oldest first", async () => {
    const queued = await createTwinJob({ twinId: "twin_alice", kind: "ingest", sourceIds: [] })
    await new Promise((r) => setTimeout(r, 5))
    const running = await createTwinJob({
      twinId: "twin_alice",
      kind: "distill",
      sourceIds: [],
      status: "running",
      phase: "style-agent",
      progress: 40,
    })
    await createTwinJob({
      twinId: "twin_alice",
      kind: "ingest",
      sourceIds: [],
      status: "completed",
      phase: "completed",
      progress: 100,
    })
    const active = await listActiveJobsByTwin("twin_alice")
    expect(active.map((j) => j.id)).toEqual([queued.id, running.id])
  })

  it("claimNextQueuedJob marks the picked job running, FIFO by queuedAt", async () => {
    const first = await createTwinJob({ twinId: "twin_alice", kind: "ingest", sourceIds: [] })
    await new Promise((r) => setTimeout(r, 5))
    await createTwinJob({ twinId: "twin_alice", kind: "ingest", sourceIds: [] })
    const claimed = await claimNextQueuedJob("twin_alice")
    expect(claimed?.id).toBe(first.id)
    expect(claimed?.status).toBe("running")
    expect(claimed?.startedAt).toBeGreaterThan(0)

    // Re-fetch to confirm persistence (not just the in-memory return).
    const refreshed = await getTwinJob(first.id)
    expect(refreshed?.status).toBe("running")
  })

  it("claimNextQueuedJob without a twinId picks any queued job", async () => {
    const job = await createTwinJob({ twinId: "twin_alice", kind: "ingest", sourceIds: [] })
    const claimed = await claimNextQueuedJob()
    expect(claimed?.id).toBe(job.id)
  })

  it("claimNextQueuedJob returns undefined when nothing is queued", async () => {
    const claimed = await claimNextQueuedJob("twin_alice")
    expect(claimed).toBeUndefined()
  })

  it("updateJobProgress patches the row in place", async () => {
    const job = await createTwinJob({ twinId: "twin_alice", kind: "distill", sourceIds: [] })
    await updateJobProgress(job.id, { phase: "knowledge-agent", progress: 30 })
    const refreshed = await getTwinJob(job.id)
    expect(refreshed?.phase).toBe("knowledge-agent")
    expect(refreshed?.progress).toBe(30)
  })

  it("completeJob sets status/progress and stores draft ids", async () => {
    const job = await createTwinJob({
      twinId: "twin_alice",
      kind: "distill",
      sourceIds: [],
      status: "running",
      phase: "synthesizer",
      progress: 80,
    })
    await completeJob(job.id, { outputDraftIds: ["twd_1", "twd_2"], llmTokensUsed: 12345 })
    const done = await getTwinJob(job.id)
    expect(done?.status).toBe("completed")
    expect(done?.progress).toBe(100)
    expect(done?.outputDraftIds).toEqual(["twd_1", "twd_2"])
    expect(done?.llmTokensUsed).toBe(12345)
    expect(done?.completedAt).toBeGreaterThan(0)
  })

  it("completeJob persists per-agent partialFailures from a degraded distill run", async () => {
    const job = await createTwinJob({
      twinId: "twin_alice",
      kind: "distill",
      sourceIds: [],
      status: "running",
      phase: "synthesizer",
      progress: 80,
    })
    await completeJob(job.id, {
      outputDraftIds: ["twd_1"],
      partialFailures: { knowledge: "timed out after 90s", playbook: "LLM returned no JSON" },
    })
    const done = await getTwinJob(job.id)
    expect(done?.status).toBe("completed")
    expect(done?.partialFailures).toEqual({
      knowledge: "timed out after 90s",
      playbook: "LLM returned no JSON",
    })
  })

  it("failJob records the message and increments retryCount", async () => {
    const job = await createTwinJob({ twinId: "twin_alice", kind: "ingest", sourceIds: [] })
    await failJob(job.id, "OCR worker dropped")
    const failed = await getTwinJob(job.id)
    expect(failed?.status).toBe("failed")
    expect(failed?.errorMessage).toBe("OCR worker dropped")
    expect(failed?.retryCount).toBe(1)
    await failJob(job.id, "still bad")
    const failedAgain = await getTwinJob(job.id)
    expect(failedAgain?.retryCount).toBe(2)
  })

  it("deleteTwinJob removes the row", async () => {
    const job = await createTwinJob({ twinId: "twin_alice", kind: "ingest", sourceIds: [] })
    await deleteTwinJob(job.id)
    expect(await getTwinJob(job.id)).toBeUndefined()
  })

  it("claimNextQueuedJob stamps a lease deadline (T1.4)", async () => {
    await createTwinJob({ twinId: "twin_alice", kind: "ingest", sourceIds: [] })
    const claimed = await claimNextQueuedJob("twin_alice", 1_000_000)
    expect(claimed?.leaseExpiresAt).toBeGreaterThan(1_000_000)
  })

  it("updateJobProgress refreshes the lease (T1.4)", async () => {
    const job = await createTwinJob({ twinId: "twin_alice", kind: "distill", sourceIds: [] })
    await claimNextQueuedJob("twin_alice", 1_000)
    await updateJobProgress(job.id, { phase: "knowledge-agent", progress: 30 })
    const refreshed = await getTwinJob(job.id)
    // Refreshed to Date.now()+TTL — far beyond the tiny claim clock above.
    expect(refreshed?.leaseExpiresAt).toBeGreaterThan(1_000_000)
  })

  it("reclaims a running job whose lease has expired (T1.4)", async () => {
    const job = await createTwinJob({ twinId: "twin_alice", kind: "ingest", sourceIds: [] })
    const claimed = await claimNextQueuedJob("twin_alice", 1_000)
    expect(claimed?.id).toBe(job.id)
    const leaseAt = claimed!.leaseExpiresAt!
    // No queued rows remain; claiming past the lease reclaims the stuck row.
    const reclaimed = await claimNextQueuedJob("twin_alice", leaseAt + 1)
    expect(reclaimed?.id).toBe(job.id)
    expect(reclaimed?.status).toBe("running")
  })

  it("does NOT reclaim a running job with a live lease (T1.4)", async () => {
    await createTwinJob({ twinId: "twin_alice", kind: "ingest", sourceIds: [] })
    const claimed = await claimNextQueuedJob("twin_alice", 1_000)
    const within = claimed!.leaseExpiresAt! - 1
    expect(await claimNextQueuedJob("twin_alice", within)).toBeUndefined()
  })

  it("releaseClaim requeues without burning retry budget, unlike requeueJob (T1.5)", async () => {
    const job = await createTwinJob({ twinId: "twin_alice", kind: "ingest", sourceIds: [] })
    await claimNextQueuedJob("twin_alice", 1_000)
    await releaseClaim(job.id)
    const released = await getTwinJob(job.id)
    expect(released?.status).toBe("queued")
    expect(released?.retryCount).toBe(0) // seat contention is not a failure
    expect(released?.leaseExpiresAt).toBeUndefined()

    // Contrast: requeueJob (a genuine transient failure) DOES advance the budget.
    await claimNextQueuedJob("twin_alice", 2_000)
    await requeueJob(job.id, 3_000)
    expect((await getTwinJob(job.id))?.retryCount).toBe(1)
  })
})
