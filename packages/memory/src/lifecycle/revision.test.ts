import type { Memory } from "../types/memory"
import {
  buildRevisionSnapshot,
  isRevisionSnapshot,
  memoryIdentity,
  textEffectiveFrom,
  wasLiveAt,
} from "./revision"

const T0 = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

function mem(over: Partial<Memory> = {}): Memory {
  return {
    id: "live",
    scope: "global",
    type: "semantic",
    text: "User prefers npm",
    tags: ["tooling"],
    importance: 6,
    createdAt: T0,
    updatedAt: T0 + HOUR,
    lastAccessedAt: T0 + 2 * HOUR,
    accessCount: 9,
    version: 3,
    status: "active",
    pinned: true,
    provenance: "user",
    ...over,
  }
}

describe("textEffectiveFrom", () => {
  it("is revisedAt when present, else createdAt", () => {
    expect(textEffectiveFrom({ createdAt: 10 })).toBe(10)
    expect(textEffectiveFrom({ createdAt: 10, revisedAt: 20 })).toBe(20)
  })
})

describe("isRevisionSnapshot / memoryIdentity", () => {
  it("identifies snapshots by revisionOf", () => {
    expect(isRevisionSnapshot({})).toBe(false)
    expect(isRevisionSnapshot({ revisionOf: "owner" })).toBe(true)
  })

  it("maps a snapshot to its owner's id and a live row to itself", () => {
    expect(memoryIdentity({ id: "snap", revisionOf: "owner" })).toBe("owner")
    expect(memoryIdentity({ id: "live" })).toBe("live")
  })
})

describe("buildRevisionSnapshot", () => {
  const NOW = T0 + 10 * HOUR

  it("preserves the outgoing text as an invalidated snapshot chained to its owner", () => {
    const current = mem({ revisedAt: T0 + 3 * HOUR })
    const snap = buildRevisionSnapshot(current, { id: "snap1", now: NOW, reason: "edit" })
    expect(snap).toEqual({
      id: "snap1",
      scope: "global",
      type: "semantic",
      text: "User prefers npm",
      tags: ["tooling"],
      importance: 6,
      createdAt: T0,
      updatedAt: NOW,
      lastAccessedAt: T0 + 2 * HOUR,
      accessCount: 0,
      version: 3,
      status: "invalidated",
      invalidatedAt: NOW,
      supersededById: "live",
      pinned: false,
      provenance: "user",
      revisionOf: "live",
      revisionReason: "edit",
      revisedAt: T0 + 3 * HOUR,
    })
  })

  it("sets revisedAt to createdAt when the owner was never revised", () => {
    const snap = buildRevisionSnapshot(mem(), { id: "s", now: NOW, reason: "consolidation" })
    expect(snap.revisedAt).toBe(T0)
    expect(snap.revisionReason).toBe("consolidation")
  })

  it("copies tags rather than sharing the array", () => {
    const current = mem()
    const snap = buildRevisionSnapshot(current, { id: "s", now: NOW, reason: "edit" })
    expect(snap.tags).toEqual(current.tags)
    expect(snap.tags).not.toBe(current.tags)
  })

  it("never carries vector, key or source-message links", () => {
    const current = mem({
      vectorDocId: "vec",
      key: "pkg-manager",
      sourceMessageId: "msg",
      sourceSessionId: "sess",
      conflictWithIds: ["other"],
      retrievalFeedback: { positive: 3, negative: 0 },
      beliefInputs: { evidenceCount: 2, distinctSessions: 2 },
    })
    const snap = buildRevisionSnapshot(current, { id: "s", now: NOW, reason: "edit" })
    for (const field of [
      "vectorDocId",
      "key",
      "sourceMessageId",
      "sourceSessionId",
      "conflictWithIds",
      "retrievalFeedback",
      "beliefInputs",
    ]) {
      expect(field in snap).toBe(false)
    }
  })

  it("copies namespace, attribution and governance fields when present", () => {
    const current = mem({
      scope: "character",
      characterId: "c1",
      projectId: "p1",
      agentId: "a1",
      branch: "main",
      pathPattern: "lib/",
      projectMemoryKind: "decision",
      sourceChannel: "mcp",
      sourcePluginId: "plug",
      evidenceState: "supported",
      contaminationState: "external-context",
      sensitivity: "sensitive",
      compactedAt: T0 + HOUR,
      reviewStatus: "verified",
      trustState: "trusted",
      staleness: "fresh",
      confidence: 0.8,
      expiresAt: T0 + 100 * HOUR,
    })
    const snap = buildRevisionSnapshot(current, { id: "s", now: NOW, reason: "compaction" })
    expect(snap).toMatchObject({
      scope: "character",
      characterId: "c1",
      projectId: "p1",
      agentId: "a1",
      branch: "main",
      pathPattern: "lib/",
      projectMemoryKind: "decision",
      sourceChannel: "mcp",
      sourcePluginId: "plug",
      evidenceState: "supported",
      contaminationState: "external-context",
      sensitivity: "sensitive",
      compactedAt: T0 + HOUR,
      reviewStatus: "verified",
      trustState: "trusted",
      staleness: "fresh",
      confidence: 0.8,
      expiresAt: T0 + 100 * HOUR,
    })
  })

  it("copies explicit null confidence/expiry", () => {
    const snap = buildRevisionSnapshot(mem({ confidence: null, expiresAt: null }), {
      id: "s",
      now: NOW,
      reason: "edit",
    })
    expect(snap.confidence).toBeNull()
    expect(snap.expiresAt).toBeNull()
  })

  it("omits optional fields the owner does not have", () => {
    const snap = buildRevisionSnapshot(mem(), { id: "s", now: NOW, reason: "edit" })
    for (const field of [
      "characterId",
      "projectId",
      "agentId",
      "branch",
      "pathPattern",
      "projectMemoryKind",
      "sourceChannel",
      "sourcePluginId",
      "evidenceState",
      "contaminationState",
      "sensitivity",
      "compactedAt",
      "reviewStatus",
      "trustState",
      "staleness",
      "confidence",
      "expiresAt",
    ]) {
      expect(field in snap).toBe(false)
    }
  })

  it("does not mutate the owner", () => {
    const current = mem()
    const before = JSON.stringify(current)
    buildRevisionSnapshot(current, { id: "s", now: NOW, reason: "edit" })
    expect(JSON.stringify(current)).toBe(before)
  })

  it("produces a row that is live exactly over its preserved window", () => {
    const current = mem({ revisedAt: T0 + 3 * HOUR })
    const snap = buildRevisionSnapshot(current, { id: "s", now: NOW, reason: "edit" })
    expect(wasLiveAt(snap, T0 + 2 * HOUR)).toBe(false)
    expect(wasLiveAt(snap, T0 + 3 * HOUR)).toBe(true)
    expect(wasLiveAt(snap, NOW - 1)).toBe(true)
    expect(wasLiveAt(snap, NOW)).toBe(false)
  })
})

describe("wasLiveAt", () => {
  it("an active row is live from its effective time onward", () => {
    const row = mem({ revisedAt: T0 + 5 * HOUR })
    expect(wasLiveAt(row, T0 + 4 * HOUR)).toBe(false)
    expect(wasLiveAt(row, T0 + 5 * HOUR)).toBe(true)
    expect(wasLiveAt(row, T0 + 500 * HOUR)).toBe(true)
  })

  it("an active row without revisedAt starts at createdAt", () => {
    expect(wasLiveAt(mem(), T0 - 1)).toBe(false)
    expect(wasLiveAt(mem(), T0)).toBe(true)
  })

  it("an invalidated row is live over [effectiveFrom, invalidatedAt)", () => {
    const row = mem({ status: "invalidated", invalidatedAt: T0 + 10 * HOUR })
    expect(wasLiveAt(row, T0 - 1)).toBe(false)
    expect(wasLiveAt(row, T0)).toBe(true)
    expect(wasLiveAt(row, T0 + 10 * HOUR - 1)).toBe(true)
    expect(wasLiveAt(row, T0 + 10 * HOUR)).toBe(false)
  })

  it("an invalidated row without invalidatedAt is never live", () => {
    expect(wasLiveAt(mem({ status: "invalidated" }), T0 + HOUR)).toBe(false)
  })

  it("an expiry at or before asOf ends it", () => {
    const row = mem({ expiresAt: T0 + 5 * HOUR })
    expect(wasLiveAt(row, T0 + 5 * HOUR - 1)).toBe(true)
    expect(wasLiveAt(row, T0 + 5 * HOUR)).toBe(false)
    expect(wasLiveAt(mem({ expiresAt: null }), T0 + 5 * HOUR)).toBe(true)
  })
})
