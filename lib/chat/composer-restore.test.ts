import type { UIMessage } from "ai"

jest.mock("@/lib/db/session-assets", () => ({ getSessionAsset: jest.fn() }))

import { composeTurnText } from "@/lib/chat/prompt-preamble"
import { STEER_PREFIX } from "@/lib/claude/steer"
import {
  composerRestoreFromMessage,
  isEmptyComposerRestore,
  mergeComposerRestores,
  type ComposerRestoreDeps,
} from "./composer-restore"

const extraction = (attachmentId: string) => ({
  attachmentId,
  contentHash: "a".repeat(64),
  status: "ready",
  processor: { id: "test", version: "1" },
  segments: [{ id: "s1", text: "body", locator: { type: "text", start: 0, end: 4 } }],
})

function deps(assets: Record<string, { blob: Blob; filename: string; mediaType: string }>) {
  return {
    getSessionAsset: jest.fn(async (_sessionId: string, assetId: string) =>
      assets[assetId] ? { ...assets[assetId], assetId } : undefined
    ),
  } as unknown as ComposerRestoreDeps
}

function message(parts: unknown[], metadata?: Record<string, unknown>) {
  return { parts, metadata } as unknown as Pick<UIMessage, "parts" | "metadata">
}

describe("composerRestoreFromMessage", () => {
  it("restores typed text without the envelope, and keeps the envelope to re-send", async () => {
    const turn = composeTurnText("compare these", [
      { kind: "references", text: "Referenced context: spec.md" },
    ])
    const summary = { sections: ["references"], references: [{ kind: "file", title: "spec.md" }] }
    const payload = await composerRestoreFromMessage(
      "s1",
      message([{ type: "text", text: turn.text }], { promptPreamble: summary }),
      { deps: deps({}) }
    )
    expect(payload.text).toBe("compare these")
    expect(payload.carried).toEqual([{ preamble: turn.preamble, summary }])
  })

  it("strips the steer framing a replayed follow-up may carry", async () => {
    const payload = await composerRestoreFromMessage(
      "s1",
      message([{ type: "text", text: `${STEER_PREFIX}also do this` }]),
      { deps: deps({}) }
    )
    expect(payload.text).toBe("also do this")
  })

  it("rebuilds attachments from the session asset store, once per source", async () => {
    const blob = new Blob(["%PDF"], { type: "application/pdf" })
    const d = deps({ a1: { blob, filename: "spec.pdf", mediaType: "application/pdf" } })
    const payload = await composerRestoreFromMessage(
      "s1",
      message([
        { type: "file", filename: "spec.pdf", extractedContent: extraction("a1") },
        { type: "file", filename: "spec.pdf", extractedContent: extraction("a1") },
        { type: "text", text: "read it" },
      ]),
      { deps: d }
    )
    expect(payload.files).toHaveLength(1)
    expect(payload.files[0]?.name).toBe("spec.pdf")
    expect(payload.files[0]?.type).toBe("application/pdf")
    expect(payload.missing).toEqual([])
    expect(d.getSessionAsset).toHaveBeenCalledWith("s1", "a1")
  })

  it("rebuilds an inline screenshot from its data URL", async () => {
    const payload = await composerRestoreFromMessage(
      "s1",
      message([
        { type: "file", url: "data:image/png;base64,iVBORw0KGgo=", mediaType: "image/png" },
      ]),
      { deps: deps({}) }
    )
    expect(payload.files).toHaveLength(1)
    expect(payload.files[0]?.type).toBe("image/png")
    expect(payload.files[0]?.name).toBe("attachment-1.png")
    expect(payload.files[0]?.size).toBeGreaterThan(0)
  })

  it("names an attachment whose original is gone instead of dropping it silently", async () => {
    const payload = await composerRestoreFromMessage(
      "s1",
      message([
        {
          type: "file",
          filename: "notes.txt",
          text: "extracted",
          extractedContent: extraction("gone"),
        },
      ]),
      { deps: deps({}) }
    )
    expect(payload.files).toEqual([])
    expect(payload.missing).toEqual(["notes.txt"])
  })

  it("stages chip citations, but not refs whose token is still in the text", async () => {
    const payload = await composerRestoreFromMessage(
      "s1",
      message([{ type: "text", text: "see @src/app.ts" }], {
        mentions: [
          { kind: "file", id: "src/app.ts", raw: "@src/app.ts" },
          { kind: "entity", id: "memory:m1", label: "Deploy notes" },
        ],
      }),
      { deps: deps({}) }
    )
    expect(payload.citations).toEqual([{ kind: "entity", id: "memory:m1", label: "Deploy notes" }])
  })

  it("prefers the persisted reply target, falling back to the queue entry's", async () => {
    const fallback = { messageId: "m0", preview: "earlier" }
    const persisted = { messageId: "m1", preview: "answer" }
    const withMeta = await composerRestoreFromMessage(
      "s1",
      message([{ type: "text", text: "x" }], { replyTo: persisted }),
      { replyTo: fallback, deps: deps({}) }
    )
    expect(withMeta.replyTo).toEqual(persisted)
    const withoutMeta = await composerRestoreFromMessage(
      "s1",
      message([{ type: "text", text: "x" }]),
      { replyTo: fallback, deps: deps({}) }
    )
    expect(withoutMeta.replyTo).toEqual(fallback)
  })
})

describe("mergeComposerRestores", () => {
  it("joins follow-ups in send order and keeps every file, citation and envelope", () => {
    const a = new File(["a"], "a.png", { type: "image/png" })
    const b = new File(["b"], "b.png", { type: "image/png" })
    const merged = mergeComposerRestores([
      {
        text: "first",
        files: [a],
        citations: [{ kind: "entity", id: "memory:m1" }],
        replyTo: { messageId: "m1", preview: "p" },
        carried: [{ preamble: "<p1>" }],
        missing: [],
      },
      {
        text: "",
        files: [b],
        citations: [{ kind: "entity", id: "memory:m1" }],
        replyTo: { messageId: "m2", preview: "q" },
        carried: [{ preamble: "<p2>" }],
        missing: ["gone.txt"],
      },
      { text: "third", files: [], citations: [], carried: [], missing: [] },
    ])
    expect(merged.text).toBe("first\n\nthird")
    expect(merged.files).toEqual([a, b])
    expect(merged.citations).toEqual([{ kind: "entity", id: "memory:m1" }])
    expect(merged.replyTo).toEqual({ messageId: "m1", preview: "p" })
    expect(merged.carried.map((c) => c.preamble)).toEqual(["<p1>", "<p2>"])
    expect(merged.missing).toEqual(["gone.txt"])
  })

  it("reports an empty restore", () => {
    expect(
      isEmptyComposerRestore({ text: "", files: [], citations: [], carried: [], missing: [] })
    ).toBe(true)
    expect(
      isEmptyComposerRestore({ text: "x", files: [], citations: [], carried: [], missing: [] })
    ).toBe(false)
  })
})
