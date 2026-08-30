import type { MemoryJob } from "@/types/memory/governance"
import {
  buildJobCheckpoint,
  legacyTranscriptCheckpoint,
  resolveJobTranscriptWindow,
  transcriptJobIdentity,
} from "./transcript-window"

type Entry = { id?: string; role: string; text: string }

const msg = (id: string, role = "user"): Entry => ({ id, role, text: `${id} body` })

function jobWith(patch: Partial<Pick<MemoryJob, "dedupeKey" | "checkpoint">>) {
  return { dedupeKey: "turn-extraction:s1:turn:2", ...patch }
}

describe("buildJobCheckpoint", () => {
  it("pins the window to the first and last message ids", () => {
    expect(buildJobCheckpoint([msg("m1"), msg("m2"), msg("m3")], 7)).toEqual({
      transcriptRevision: 7,
      firstMessageId: "m1",
      lastMessageId: "m3",
      messageCount: 3,
    })
  })

  it("defaults a missing revision to 0 rather than dropping the checkpoint", () => {
    // A session row written before `transcriptRevision` existed still deserves
    // id-pinned recovery; only the drift signal degrades.
    expect(buildJobCheckpoint([msg("m1")], undefined)?.transcriptRevision).toBe(0)
  })

  it("returns undefined when an endpoint carries no id, never a fabricated one", () => {
    expect(buildJobCheckpoint([], 1)).toBeUndefined()
    expect(buildJobCheckpoint([{ role: "user", text: "no id" }], 1)).toBeUndefined()
    expect(buildJobCheckpoint([msg("m1"), { role: "user", text: "no id" }], 1)).toBeUndefined()
  })
})

describe("transcriptJobIdentity", () => {
  it("derives the identity from the checkpoint and keeps the count as the tail", () => {
    const checkpoint = buildJobCheckpoint([msg("m1"), msg("m2")], 3)
    expect(transcriptJobIdentity(checkpoint, "turn:2")).toBe("m2:2")
  })

  it("preserves each caller's own legacy shape when there is no checkpoint", () => {
    // The two shipped job kinds use different fallbacks. Collapsing them to one
    // shape would orphan every in-flight job of the other kind.
    expect(transcriptJobIdentity(undefined, "turn:4")).toBe("turn:4")
    expect(transcriptJobIdentity(undefined, "4")).toBe("4")
  })
})

describe("legacyTranscriptCheckpoint", () => {
  it.each([
    ["turn-extraction:s1:turn:2", 2],
    ["session-distill:s1:12", 12],
    ["project-mining:s1:m9:3", 3],
  ])("reads the trailing count off %s", (key, expected) => {
    expect(legacyTranscriptCheckpoint(key)).toBe(expected)
  })

  it.each(["vector-reconcile:2026-08-30", "turn-extraction:s1:turn:0", "no-digits"])(
    "returns undefined for %s",
    (key) => {
      expect(legacyTranscriptCheckpoint(key)).toBeUndefined()
    }
  )
})

describe("resolveJobTranscriptWindow", () => {
  const full = [msg("m1"), msg("m2"), msg("m3"), msg("m4")]

  it("resolves the id window, not a prefix of the current transcript", () => {
    const checkpoint = {
      transcriptRevision: 1,
      firstMessageId: "m2",
      lastMessageId: "m3",
      messageCount: 2,
    }
    const result = resolveJobTranscriptWindow(jobWith({ checkpoint }), full, 1)
    expect(result).toEqual({ ok: true, transcript: [full[1], full[2]] })
  })

  it("replays the ORIGINAL content after a same-length edit — the bug this fixes", () => {
    // Legacy count slicing would hand back `edited` here, because the length is
    // unchanged. The id window resolves to the messages that actually exist.
    const edited = [msg("m1"), { id: "m2b", role: "user", text: "rewritten" }, msg("m3"), msg("m4")]
    const checkpoint = buildJobCheckpoint([msg("m1"), msg("m2")], 1)!
    expect(resolveJobTranscriptWindow(jobWith({ checkpoint }), edited, 2)).toEqual({
      ok: false,
      code: "source_missing",
      terminal: true,
    })
    // …whereas the legacy path silently accepts the rewritten message.
    const legacy = resolveJobTranscriptWindow(
      jobWith({ dedupeKey: "turn-extraction:s1:turn:2" }),
      edited,
      2
    )
    expect(legacy).toEqual({ ok: true, transcript: [edited[0], edited[1]] })
  })

  it("is terminal, not retryable, when a window endpoint is gone", () => {
    const checkpoint = {
      transcriptRevision: 1,
      firstMessageId: "m1",
      lastMessageId: "gone",
      messageCount: 2,
    }
    expect(resolveJobTranscriptWindow(jobWith({ checkpoint }), full, 1)).toEqual({
      ok: false,
      code: "source_missing",
      terminal: true,
    })
  })

  it("reports snapshot_changed when the window still resolves but spans a different count", () => {
    // A message was inserted between the endpoints.
    const checkpoint = {
      transcriptRevision: 1,
      firstMessageId: "m1",
      lastMessageId: "m3",
      messageCount: 2,
    }
    expect(resolveJobTranscriptWindow(jobWith({ checkpoint }), full, 1)).toEqual({
      ok: false,
      code: "snapshot_changed",
      terminal: true,
    })
  })

  it("proceeds — flagged — when the revision advanced but the window verified intact", () => {
    // `updateMessageMetadata` bumps the revision without changing any text.
    // Treating that as fatal would discard the majority of valid jobs.
    const checkpoint = {
      transcriptRevision: 1,
      firstMessageId: "m1",
      lastMessageId: "m2",
      messageCount: 2,
    }
    expect(resolveJobTranscriptWindow(jobWith({ checkpoint }), full, 9)).toEqual({
      ok: true,
      transcript: [full[0], full[1]],
      resultCode: "revision_advanced_window_intact",
    })
  })

  it("does not flag drift when the session revision is unknown", () => {
    const checkpoint = {
      transcriptRevision: 1,
      firstMessageId: "m1",
      lastMessageId: "m2",
      messageCount: 2,
    }
    const result = resolveJobTranscriptWindow(jobWith({ checkpoint }), full, undefined)
    expect(result).toEqual({ ok: true, transcript: [full[0], full[1]] })
  })

  it("ignores a stale duplicate id before the window start", () => {
    const withDuplicate = [msg("m3"), msg("m1"), msg("m2"), msg("m3")]
    const checkpoint = {
      transcriptRevision: 1,
      firstMessageId: "m1",
      lastMessageId: "m3",
      messageCount: 3,
    }
    expect(resolveJobTranscriptWindow(jobWith({ checkpoint }), withDuplicate, 1)).toEqual({
      ok: true,
      transcript: [withDuplicate[1], withDuplicate[2], withDuplicate[3]],
    })
  })

  it("falls back to the legacy count for rows written before checkpoints existed", () => {
    expect(
      resolveJobTranscriptWindow(jobWith({ dedupeKey: "session-distill:s1:3" }), full, 5)
    ).toEqual({ ok: true, transcript: [full[0], full[1], full[2]] })
  })

  it("loads a checkpointed job whose dedupe key has no trailing count", () => {
    // This is what unblocks job kinds that do not encode a count in their key.
    const checkpoint = {
      transcriptRevision: 1,
      firstMessageId: "m1",
      lastMessageId: "m2",
      messageCount: 2,
    }
    expect(
      resolveJobTranscriptWindow(
        jobWith({ dedupeKey: "project-mining:run-a", checkpoint }),
        full,
        1
      )
    ).toEqual({ ok: true, transcript: [full[0], full[1]] })
  })

  it("stays retryable when neither a checkpoint nor a usable count is available", () => {
    // The tail may simply not have been persisted yet.
    expect(
      resolveJobTranscriptWindow(jobWith({ dedupeKey: "vector-reconcile:x" }), full, 1)
    ).toEqual({
      ok: false,
      code: "transcript_checkpoint_unavailable",
      terminal: false,
    })
    expect(resolveJobTranscriptWindow(jobWith({ dedupeKey: "a:99" }), full, 1)).toEqual({
      ok: false,
      code: "transcript_checkpoint_unavailable",
      terminal: false,
    })
  })
})
