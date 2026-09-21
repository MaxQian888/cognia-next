import {
  buildAttachmentManifestEntries,
  runAttachmentBuiltinTool,
  type AttachmentToolDeps,
} from "./attachment-builtin-tools"
import type { SessionAsset } from "@/lib/db/session-assets"

function asset(overrides: Partial<SessionAsset> = {}) {
  return {
    sessionId: "trusted",
    assetId: "asset",
    filename: "source.txt",
    mediaType: "text/plain",
    byteSize: 12,
    contentHash: "a".repeat(64),
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    temporary: false,
    sourceAvailable: true,
    extractedContent: {
      attachmentId: "asset",
      contentHash: "a".repeat(64),
      status: "ready" as const,
      processor: { id: "text", version: "1" },
      segments: [
        { id: "first", text: "abcdef", locator: { type: "page" as const, page: 1 } },
        { id: "second", text: "ghij", locator: { type: "page" as const, page: 2 } },
      ],
    },
    ...overrides,
  }
}
function deps(rows = [asset()]): AttachmentToolDeps {
  return {
    list: jest.fn(async () => rows),
    getMetadata: jest.fn(async (_sessionId, assetId) =>
      rows.find((row) => row.assetId === assetId)
    ),
    search: jest.fn(async () => ({
      strategy: "bm25" as const,
      hits: [],
      budget: { limit: 100, used: 0, truncated: false },
    })),
  }
}
const context = { sessionId: "trusted" }

describe("session attachment tools", () => {
  it("publishes only session-bound read contracts", () => {
    expect(buildAttachmentManifestEntries().map((entry) => entry.name)).toEqual([
      "attachment_list",
      "attachment_search",
      "attachment_read",
    ])
    for (const entry of buildAttachmentManifestEntries()) {
      expect(entry.jsonSchema.additionalProperties).toBe(false)
      expect(entry.jsonSchema.properties).not.toHaveProperty("sessionId")
    }
  })
  it("rejects forged scope, invalid bounds and unknown tools before storage", async () => {
    const storage = deps()
    for (const [name, args] of [
      ["attachment_list", { sessionId: "other" }],
      ["attachment_read", { assetId: "asset", maxChars: NaN }],
      ["attachment_search", { query: " " }],
    ] as const) {
      await expect(runAttachmentBuiltinTool(name, args, storage, context)).resolves.toMatchObject({
        ok: false,
        code: "invalid_arguments",
      })
    }
    await expect(runAttachmentBuiltinTool("unknown", {}, storage, context)).resolves.toMatchObject({
      code: "unknown_tool",
    })
    await expect(
      runAttachmentBuiltinTool("attachment_list", {}, storage, { sessionId: " " })
    ).resolves.toMatchObject({ code: "session_required" })
    expect(storage.list).not.toHaveBeenCalled()
  })
  it("lists bounded metadata without loading originals and reports missing sources", async () => {
    const rows = [asset(), { ...asset({ assetId: "second" }), sourceAvailable: false }]
    const storage = deps(rows)
    await expect(
      runAttachmentBuiltinTool("attachment_list", { limit: 1 }, storage, context)
    ).resolves.toMatchObject({ total: 2, nextOffset: 1, assets: [{ assetId: "asset" }] })
    await expect(
      runAttachmentBuiltinTool("attachment_list", { offset: 1 }, storage, context)
    ).resolves.toMatchObject({
      nextOffset: null,
      assets: [{ assetId: "second", sourceAvailable: false }],
    })
    expect(storage.list).toHaveBeenCalledWith("trusted")
    expect(storage.getMetadata).not.toHaveBeenCalled()
  })
  it("pages every source character with stable revision and page locators", async () => {
    const storage = deps()
    let args: Record<string, unknown> | null = { assetId: "asset" }
    const texts = []
    while (args) {
      const result = (await runAttachmentBuiltinTool(
        "attachment_read",
        { ...args, maxChars: 3 },
        storage,
        context
      )) as { segments: { text: string; locator: unknown }[]; next: Record<string, unknown> | null }
      texts.push(...result.segments.map((segment) => segment.text))
      for (const segment of result.segments) expect(segment.locator).toMatchObject({ type: "page" })
      args = result.next
    }
    expect(texts.join("")).toBe("abcdefghij")
    expect(storage.getMetadata).toHaveBeenCalledWith("trusted", "asset")
    await expect(
      runAttachmentBuiltinTool(
        "attachment_read",
        { assetId: "asset", expectedRevision: 2 },
        storage,
        context
      )
    ).resolves.toMatchObject({ code: "revision_changed", revision: 1 })
    await expect(
      runAttachmentBuiltinTool(
        "attachment_read",
        { assetId: "asset", segmentId: "second", offset: 1 },
        storage,
        context
      )
    ).resolves.toMatchObject({
      segments: [{ text: "hij", startOffset: 1, endOffset: 4 }],
      next: null,
    })
  })
  it("reports missing extraction, assets, segment and invalid offsets explicitly", async () => {
    await expect(
      runAttachmentBuiltinTool("attachment_read", { assetId: "missing" }, deps(), context)
    ).resolves.toMatchObject({ code: "attachment_not_found" })
    await expect(
      runAttachmentBuiltinTool(
        "attachment_read",
        { assetId: "asset" },
        deps([asset({ extractedContent: undefined })]),
        context
      )
    ).resolves.toMatchObject({ code: "extraction_unavailable" })
    await expect(
      runAttachmentBuiltinTool(
        "attachment_read",
        { assetId: "asset", segmentId: "missing" },
        deps(),
        context
      )
    ).resolves.toMatchObject({ code: "segment_not_found" })
    await expect(
      runAttachmentBuiltinTool("attachment_read", { assetId: "asset", offset: 10 }, deps(), context)
    ).resolves.toMatchObject({ code: "invalid_offset" })
  })
  it("screens the full segment before paging so split PII cannot bypass the gate", async () => {
    const row = asset()
    row.extractedContent!.segments[0].text = "person@example.com"
    await expect(
      runAttachmentBuiltinTool(
        "attachment_read",
        { assetId: "asset", maxChars: 3 },
        deps([row]),
        context
      )
    ).resolves.toMatchObject({ code: "attachment_content_blocked_by_pii_gate" })
  })
  it("passes search budgets and source offsets through", async () => {
    const storage = deps()
    await expect(
      runAttachmentBuiltinTool(
        "attachment_search",
        { query: "abcdef", topK: 3, tokenBudget: 100 },
        storage,
        context
      )
    ).resolves.toMatchObject({ ok: true, strategy: "bm25" })
    expect(storage.search).toHaveBeenCalledWith("trusted", "abcdef", { topK: 3, tokenBudget: 100 })
  })
  it("verifies complete search evidence before returning partial excerpts", async () => {
    const row = asset()
    const storage = deps([row])
    storage.search = jest.fn(async () => ({
      strategy: "bm25" as const,
      hits: [
        {
          assetId: row.assetId,
          contentHash: row.contentHash,
          filename: row.filename,
          processor: row.extractedContent!.processor,
          status: "ready" as const,
          score: 1,
          segment: { ...row.extractedContent!.segments[0], text: "bcd" },
          sourceStart: 1,
          sourceEnd: 4,
          fullTextLength: 6,
          truncated: true,
        },
      ],
      budget: { limit: 100, used: 30, truncated: true },
    }))
    await expect(
      runAttachmentBuiltinTool("attachment_search", { query: "bcd" }, storage, context)
    ).resolves.toMatchObject({
      ok: true,
      hits: [{ sourceStart: 1, sourceEnd: 4, fullTextLength: 6, truncated: true }],
    })
    row.extractedContent!.segments[0].text = "changed"
    await expect(
      runAttachmentBuiltinTool("attachment_search", { query: "bcd" }, storage, context)
    ).resolves.toMatchObject({ code: "revision_changed" })
    row.extractedContent!.segments[0].text = "abcd person@example.com"
    await expect(
      runAttachmentBuiltinTool("attachment_search", { query: "bcd" }, storage, context)
    ).resolves.toMatchObject({ code: "attachment_content_blocked_by_pii_gate" })
  })

  it("keeps extracted text readable when the original is missing", async () => {
    const row = { ...asset(), sourceAvailable: false }
    await expect(
      runAttachmentBuiltinTool("attachment_read", { assetId: "asset" }, deps([row]), context)
    ).resolves.toMatchObject({
      ok: true,
      asset: { sourceAvailable: false },
      segments: [{ text: "abcdef" }, { text: "ghij" }],
    })
  })

  it("returns cancellation and storage failures without leaking exception text", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runAttachmentBuiltinTool("attachment_list", {}, deps(), {
        ...context,
        abortSignal: controller.signal,
      })
    ).resolves.toMatchObject({ code: "cancelled" })
    const storage = deps()
    storage.list = jest.fn().mockRejectedValue(new Error("person@example.com"))
    await expect(
      runAttachmentBuiltinTool("attachment_list", {}, storage, context)
    ).resolves.toEqual({ ok: false, code: "attachment_storage_unavailable" })
  })
})
