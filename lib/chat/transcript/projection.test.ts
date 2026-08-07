import type { StoredMessage } from "@cognia/agent-config-types"
import {
  TRANSCRIPT_DETAIL_PAGE_BYTE_LIMIT,
  TRANSCRIPT_DETAIL_PAGE_DEFAULT,
  TRANSCRIPT_DETAIL_PAGE_MAX,
  TRANSCRIPT_SUMMARY_BYTE_LIMIT,
  TRANSCRIPT_SUMMARY_MEDIA_LIMIT,
  TRANSCRIPT_TIMELINE_PAGE_DEFAULT,
  TRANSCRIPT_TIMELINE_PAGE_MAX,
} from "@cognia/agent-config-types"

import {
  encodeTimelineCursor,
  encodeTurnDetailCursor,
  projectTranscriptTimeline,
  validateTimelineCursor,
  validateTurnDetailCursor,
} from "./projection"

function message(
  id: string,
  role: StoredMessage["role"],
  parts: StoredMessage["parts"],
  options: {
    turnKey?: string
    createdAt?: number
    metadata?: StoredMessage["metadata"]
  } = {}
): StoredMessage {
  return {
    id,
    sessionId: "session-1",
    role,
    parts,
    createdAt: options.createdAt ?? (Number(id.replace(/\D/g, "")) || 1),
    turnKey: options.turnKey,
    metadata: options.metadata,
  }
}

function text(value: string): StoredMessage["parts"][number] {
  return { type: "text", text: value, state: "done" } as StoredMessage["parts"][number]
}

describe("transcript projection", () => {
  it("publishes the negotiated paging and preview budgets", () => {
    expect({
      timelineDefault: TRANSCRIPT_TIMELINE_PAGE_DEFAULT,
      timelineMax: TRANSCRIPT_TIMELINE_PAGE_MAX,
      detailDefault: TRANSCRIPT_DETAIL_PAGE_DEFAULT,
      detailMax: TRANSCRIPT_DETAIL_PAGE_MAX,
      detailBytes: TRANSCRIPT_DETAIL_PAGE_BYTE_LIMIT,
      summaryBytes: TRANSCRIPT_SUMMARY_BYTE_LIMIT,
      summaryMedia: TRANSCRIPT_SUMMARY_MEDIA_LIMIT,
    }).toEqual({
      timelineDefault: 30,
      timelineMax: 100,
      detailDefault: 100,
      detailMax: 200,
      detailBytes: 2 * 1024 * 1024,
      summaryBytes: 64 * 1024,
      summaryMedia: 12,
    })
  })

  it("groups a user message and following assistant/system output into stable turns", () => {
    const items = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 7,
      messages: [
        message("s0", "system", [text("connected")], { createdAt: 1 }),
        message("u1", "user", [text("first question")], { createdAt: 2 }),
        message("a1", "assistant", [text("working")], { createdAt: 3 }),
        message("s1", "system", [text("approval recorded")], { createdAt: 4 }),
        message("u2", "user", [text("second question")], { createdAt: 5 }),
        message("a2", "assistant", [text("final answer")], { createdAt: 6 }),
      ],
    })

    expect(items.map((item) => [item.kind, item.itemKey])).toEqual([
      ["system", "system:s0"],
      ["completed-turn", "turn:u1"],
      ["completed-turn", "turn:u2"],
    ])
    expect(items[1]).toMatchObject({
      kind: "completed-turn",
      turnKey: "turn:u1",
      revision: 7,
      userMessages: [{ id: "u1", text: "first question" }],
      finalResponse: { id: "a1", text: "working" },
      collapsed: { messageCount: 3, trailingCount: 1 },
    })
  })

  it("respects persisted turn keys, exposes active turns in full, and projects assistant-only rows", () => {
    const items = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 9,
      activeTurnKey: "provider-turn",
      messages: [
        message("a0", "assistant", [text("orphan answer")], { createdAt: 1 }),
        message("u1", "user", [text("one")], { turnKey: "provider-turn", createdAt: 2 }),
        message("u2", "user", [text("two")], { turnKey: "provider-turn", createdAt: 3 }),
        message("a1", "assistant", [text("streaming")], {
          turnKey: "provider-turn",
          createdAt: 4,
        }),
      ],
    })

    expect(items[0]).toMatchObject({
      kind: "completed-turn",
      turnKey: "turn:a0",
      userMessages: [],
      finalResponse: { id: "a0", text: "orphan answer" },
    })
    expect(items[1]).toMatchObject({
      kind: "active-turn",
      turnKey: "provider-turn",
      messages: [{ id: "u1" }, { id: "u2" }, { id: "a1" }],
    })
  })

  it("caps summary bytes and media references while retaining detail counts", () => {
    const imageParts = Array.from({ length: 20 }, (_, index) => ({
      type: "file",
      mediaType: "image/png",
      filename: `${index}.png`,
      url: `cognia-media:hash-${index}`,
    })) as StoredMessage["parts"]
    const items = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 1,
      messages: [
        message("u1", "user", [text("x".repeat(100_000))], { createdAt: 1 }),
        message("a1", "assistant", [text("界".repeat(100_000)), ...imageParts], {
          createdAt: 2,
        }),
      ],
    })
    const turn = items[0]
    expect(turn.kind).toBe("completed-turn")
    if (turn.kind !== "completed-turn") throw new Error("expected a completed turn")

    expect(new TextEncoder().encode(JSON.stringify(turn)).byteLength).toBeLessThanOrEqual(
      TRANSCRIPT_SUMMARY_BYTE_LIMIT
    )
    expect(turn.userMessages[0].truncated).toBe(true)
    expect(turn.finalResponse?.truncated).toBe(true)
    expect(turn.finalResponse?.media).toHaveLength(TRANSCRIPT_SUMMARY_MEDIA_LIMIT)
    expect(turn.collapsed.mediaCount).toBe(20)
  })

  it("summarizes branch groups using explicit selection or the highest branch index", () => {
    const items = projectTranscriptTimeline({
      sessionId: "session-1",
      revision: 2,
      activeBranchByGroup: { answer: "a0" },
      messages: [
        message("u1", "user", [text("question")], { createdAt: 1 }),
        message("a0", "assistant", [text("old")], {
          createdAt: 2,
          metadata: { branchGroupId: "answer", branchIndex: 0 },
        }),
        message("a1", "assistant", [text("new")], {
          createdAt: 3,
          metadata: { branchGroupId: "answer", branchIndex: 1 },
        }),
        message("a2", "assistant", [text("latest")], {
          createdAt: 4,
          metadata: { branchGroupId: "other", branchIndex: 3 },
        }),
      ],
    })
    const turn = items[0]
    if (turn.kind !== "completed-turn") throw new Error("expected a completed turn")

    expect(turn.branchSummary?.groups).toEqual([
      {
        groupId: "answer",
        selectedMessageId: "a0",
        messageIds: ["a0", "a1"],
      },
      { groupId: "other", selectedMessageId: "a2", messageIds: ["a2"] },
    ])
  })
})

describe("transcript cursors", () => {
  it("round-trips an opaque timeline cursor bound to session, direction, and revision", () => {
    const cursor = encodeTimelineCursor({
      sessionId: "session-1",
      revision: 11,
      direction: "backward",
      position: 30,
    })

    expect(cursor).not.toContain("session-1")
    expect(
      validateTimelineCursor(cursor, {
        sessionId: "session-1",
        revision: 11,
        direction: "backward",
      })
    ).toEqual({
      ok: true,
      value: { version: 1, sessionId: "session-1", revision: 11, direction: "backward", position: 30 },
    })
    expect(
      validateTimelineCursor(cursor, {
        sessionId: "session-1",
        revision: 12,
        direction: "backward",
      })
    ).toEqual({ ok: false, code: "TRANSCRIPT_STALE" })
    expect(
      validateTimelineCursor(cursor, {
        sessionId: "session-2",
        revision: 11,
        direction: "backward",
      })
    ).toEqual({ ok: false, code: "INVALID_PARAMS" })
    expect(
      validateTimelineCursor("not a cursor", {
        sessionId: "session-1",
        revision: 11,
        direction: "backward",
      })
    ).toEqual({ ok: false, code: "INVALID_PARAMS" })
  })

  it("binds detail cursors to turn and detail revisions", () => {
    const cursor = encodeTurnDetailCursor({
      sessionId: "session-1",
      revision: 5,
      turnKey: "turn:u1",
      detailRevision: 3,
      position: 100,
    })

    expect(
      validateTurnDetailCursor(cursor, {
        sessionId: "session-1",
        revision: 5,
        turnKey: "turn:u1",
        detailRevision: 3,
      })
    ).toMatchObject({ ok: true, value: { position: 100 } })
    expect(
      validateTurnDetailCursor(cursor, {
        sessionId: "session-1",
        revision: 5,
        turnKey: "turn:u1",
        detailRevision: 4,
      })
    ).toEqual({ ok: false, code: "TRANSCRIPT_STALE" })
    expect(
      validateTurnDetailCursor(cursor, {
        sessionId: "session-1",
        revision: 5,
        turnKey: "turn:u2",
        detailRevision: 3,
      })
    ).toEqual({ ok: false, code: "TURN_NOT_FOUND" })
  })
})
