import {
  chatExportPayload,
  workflowImagePayload,
  backupPayload,
  a2uiPayload,
  discoverItemPayload,
  usageCardPayload,
} from "./payload"
import { decodeBase64 } from "./encoding"
import type { SharedCharacterDef } from "./discover-item"

describe("chatExportPayload", () => {
  it("maps each export format to the right kind, utf8 encoding", () => {
    const r = { content: "<h1/>", mimeType: "text/html" }
    expect(chatExportPayload(r, "html", "T")).toMatchObject({ kind: "chat-html", encoding: "utf8" })
    expect(chatExportPayload(r, "animated", "T").kind).toBe("chat-animated")
    expect(chatExportPayload(r, "markdown", "T").kind).toBe("chat-md")
    expect(chatExportPayload(r, "json", "T").kind).toBe("chat-json")
    expect(chatExportPayload(r, "text", "T").kind).toBe("chat-text")
  })

  it("carries content, mime and title through", () => {
    const p = chatExportPayload({ content: "hello", mimeType: "text/plain" }, "text", "My chat")
    expect(p).toEqual({
      kind: "chat-text",
      mime: "text/plain",
      data: "hello",
      encoding: "utf8",
      title: "My chat",
    })
  })
})

// jsdom's Blob has no `arrayBuffer()`, so fake a Blob-like with the one method
// the builder uses. Real runtimes (browser / Tauri / Capacitor) implement it.
function blobLike(bytes: number[], type = ""): Blob {
  return { type, arrayBuffer: async () => new Uint8Array(bytes).buffer } as unknown as Blob
}

describe("workflowImagePayload", () => {
  it("base64-encodes the blob bytes", async () => {
    const p = await workflowImagePayload(blobLike([1, 2, 3, 4], "image/png"), "Flow")
    expect(p.kind).toBe("workflow-png")
    expect(p.encoding).toBe("base64")
    expect(Array.from(decodeBase64(p.data))).toEqual([1, 2, 3, 4])
  })

  it("defaults the mime to image/png", async () => {
    const p = await workflowImagePayload(blobLike([0]), "Flow")
    expect(p.mime).toBe("image/png")
  })
})

describe("backupPayload / a2uiPayload", () => {
  it("wraps a backup as utf8 json", () => {
    expect(backupPayload('{"a":1}', "B")).toEqual({
      kind: "backup",
      mime: "application/json",
      data: '{"a":1}',
      encoding: "utf8",
      title: "B",
    })
  })
  it("wraps an a2ui app as utf8 json", () => {
    expect(a2uiPayload('{"app":1}', "App").kind).toBe("a2ui")
  })
})

describe("usageCardPayload", () => {
  it("wraps a card document as utf8 html", () => {
    expect(usageCardPayload('<!DOCTYPE html><div class="ucard"/>', "Usage")).toEqual({
      kind: "usage-card",
      mime: "text/html",
      data: '<!DOCTYPE html><div class="ucard"/>',
      encoding: "utf8",
      title: "Usage",
    })
  })
})

describe("discoverItemPayload", () => {
  it("wraps a sanitized definition as a utf8 discover-item payload", () => {
    const def: SharedCharacterDef = {
      kind: "character",
      name: "Researcher",
      systemPrompt: "Be careful.",
    }
    const payload = discoverItemPayload(def, def.name)
    expect(payload).toEqual({
      kind: "discover-item",
      mime: "application/json",
      data: JSON.stringify(def),
      encoding: "utf8",
      title: "Researcher",
    })
  })
})
