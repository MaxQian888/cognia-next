import {
  buildMemoryContextSnapshot,
  markSnapshotDelivered,
  snapshotContentHash,
  MEMORY_SNAPSHOT_TTL_MS,
} from "./context-snapshot"

describe("buildMemoryContextSnapshot", () => {
  it("binds reader, refs, bytes and budget into a prepared receipt", () => {
    const snap = buildMemoryContextSnapshot({
      reader: { characterId: "c1", projectId: "p1" },
      memoryRefs: [{ id: "m1", version: 3 }],
      sectionText: "## What you remember\n- fact",
      budget: { limit: 900, used: 42, truncated: false },
      degraded: false,
      now: 1000,
    })
    expect(snap).toMatchObject({
      createdAt: 1000,
      reader: { characterId: "c1", projectId: "p1" },
      memoryRefs: [{ id: "m1", version: 3 }],
      budget: { limit: 900, used: 42, truncated: false },
      degraded: false,
      delivery: "prepared",
      expiresAt: 1000 + MEMORY_SNAPSHOT_TTL_MS,
    })
    expect(snap.id).toBe(`memctx:1000:${snapshotContentHash("## What you remember\n- fact")}`)
  })

  it("gives identical deliveries the same id — a retry is not a new receipt", () => {
    const a = buildMemoryContextSnapshot({
      reader: {},
      memoryRefs: [],
      sectionText: "same bytes",
      budget: { limit: 1, used: 0, truncated: false },
      degraded: false,
      now: 5,
    })
    const b = buildMemoryContextSnapshot({
      reader: { characterId: "different" },
      memoryRefs: [{ id: "m" }],
      sectionText: "same bytes",
      budget: { limit: 9, used: 9, truncated: true },
      degraded: true,
      now: 5,
    })
    // Id binds (now, bytes) — the payload fields differ but the delivered
    // section is the same, so the receipts coincide.
    expect(a.id).toBe(b.id)
    expect(a.contentHash).toBe(b.contentHash)
  })

  it("changes id when the rendered bytes change", () => {
    const base = {
      reader: {},
      memoryRefs: [],
      budget: { limit: 1, used: 0, truncated: false },
      degraded: false,
      now: 5,
    }
    const a = buildMemoryContextSnapshot({ ...base, sectionText: "a" })
    const b = buildMemoryContextSnapshot({ ...base, sectionText: "b" })
    expect(a.id).not.toBe(b.id)
  })
})

describe("markSnapshotDelivered", () => {
  const prepared = buildMemoryContextSnapshot({
    reader: {},
    memoryRefs: [],
    sectionText: "s",
    budget: { limit: 1, used: 0, truncated: false },
    degraded: false,
    now: 1000,
  })

  it("upgrades prepared → delivered inside the TTL", () => {
    expect(markSnapshotDelivered(prepared, 2000).delivery).toBe("delivered")
  })

  it("marks a past-TTL snapshot expired rather than delivered", () => {
    // A stale receipt must not impersonate a fresh delivery.
    expect(markSnapshotDelivered(prepared, 1000 + MEMORY_SNAPSHOT_TTL_MS + 1).delivery).toBe(
      "expired"
    )
  })

  it("honours a custom ttl", () => {
    const short = buildMemoryContextSnapshot({
      reader: {},
      memoryRefs: [],
      sectionText: "s",
      budget: { limit: 1, used: 0, truncated: false },
      degraded: false,
      now: 1000,
      ttlMs: 10,
    })
    expect(markSnapshotDelivered(short, 1009).delivery).toBe("delivered")
    expect(markSnapshotDelivered(short, 1011).delivery).toBe("expired")
  })
})
