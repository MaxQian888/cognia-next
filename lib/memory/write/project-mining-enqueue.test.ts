/** @jest-environment node */
import {
  projectMiningCheckpoint,
  projectMiningDedupeKey,
  selectProjectMiningWindows,
} from "./project-mining-enqueue"
import type { ProjectWindowMessage } from "@cognia/memory/extract/project-windows"

/** A window's worth of text that clears the ≥2-signal salience bar. */
const SALIENT_USER = "Why does pnpm build fail in packages/memory/src/index.ts?"
const SALIENT_ASSISTANT =
  "It must be added to SERVER_ONLY_PACKAGES, because the static export breaks otherwise."

function transcript(count: number, salient = true): ProjectWindowMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: salient
      ? index % 2 === 0
        ? SALIENT_USER
        : SALIENT_ASSISTANT
      : `just chatting number ${index}`,
  }))
}

describe("selectProjectMiningWindows", () => {
  it("holds back the trailing window on the live turn path", () => {
    // 26 messages ≈ 3 windows at the 12-message default.
    const all = selectProjectMiningWindows(transcript(26), { includeTrailing: true })
    const closed = selectProjectMiningWindows(transcript(26), { includeTrailing: false })
    expect(all.length).toBeGreaterThan(1)
    expect(closed).toHaveLength(all.length - 1)
    expect(closed.at(-1)?.lastMessageId).not.toBe(all.at(-1)?.lastMessageId)
  })

  it("selects nothing from a short conversation until it goes idle", () => {
    // The single window is still open, so the live path must not queue it —
    // this is what stops every turn from re-mining the same growing text.
    expect(selectProjectMiningWindows(transcript(6), { includeTrailing: false })).toEqual([])
    expect(selectProjectMiningWindows(transcript(6), { includeTrailing: true })).toHaveLength(1)
  })

  it("drops windows that carry no project signal", () => {
    expect(selectProjectMiningWindows(transcript(26, false), { includeTrailing: true })).toEqual([])
  })

  it("keeps window identity stable when the tail grows", () => {
    // The first window's identity must not move when the conversation
    // continues; if it did, every later turn would re-mine the whole session.
    const shorter = selectProjectMiningWindows(transcript(26), { includeTrailing: true })
    const longer = selectProjectMiningWindows(transcript(30), { includeTrailing: true })
    expect(longer[0]?.firstMessageId).toBe(shorter[0]?.firstMessageId)
    expect(longer[0]?.lastMessageId).toBe(shorter[0]?.lastMessageId)
  })
})

describe("projectMiningDedupeKey", () => {
  const window = {
    firstMessageId: "m0",
    lastMessageId: "m11",
    messages: transcript(12),
    estimatedTokens: 100,
  }

  it("ends in the message count so a checkpoint-less row still resolves", () => {
    const key = projectMiningDedupeKey({ sessionId: "s1", window })
    expect(key).toBe("project-mining:s1:m0:m11:12")
    expect(key.endsWith(":12")).toBe(true)
  })

  it("namespaces a backfill run so its queued jobs can be withdrawn as a group", () => {
    expect(projectMiningDedupeKey({ sessionId: "s1", window, runId: "run7" })).toBe(
      "project-mining:run7:s1:m0:m11:12"
    )
  })
})

describe("projectMiningCheckpoint", () => {
  it("pins the window by message id, not by index", () => {
    expect(
      projectMiningCheckpoint(
        { firstMessageId: "a", lastMessageId: "z", messages: transcript(4), estimatedTokens: 1 },
        7
      )
    ).toEqual({
      transcriptRevision: 7,
      firstMessageId: "a",
      lastMessageId: "z",
      messageCount: 4,
    })
  })

  it("defaults a missing revision to 0 rather than fabricating one", () => {
    expect(
      projectMiningCheckpoint(
        { firstMessageId: "a", lastMessageId: "b", messages: transcript(2), estimatedTokens: 1 },
        undefined
      ).transcriptRevision
    ).toBe(0)
  })
})
