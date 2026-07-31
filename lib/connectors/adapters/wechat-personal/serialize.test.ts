/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { serializeIlinkSegments } from "./serialize"
import type { A2UIMessageSegment } from "@/types/connectors/segment"
import { __resetNumericActionRegistryForTesting } from "./numeric-action-registry"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  __resetNumericActionRegistryForTesting()
})

describe("serializeIlinkSegments", () => {
  it("joins text + markdown into one chunk", async () => {
    const out = await serializeIlinkSegments([
      { type: "text", text: "Hello" },
      { type: "markdown", md: "world" },
    ])
    expect(out.textChunks).toEqual(["Hello\n\nworld"])
    expect(out.downgrades).toEqual([])
  })

  it("falls back to seg.plainTextMirror when no ctx is supplied", async () => {
    const surface: A2UIMessageSegment = {
      type: "a2ui",
      surfaceId: "s1",
      content: { components: {}, dataModel: {}, rootId: "root" },
      plainTextMirror: "Pick: [A] [B]",
    }
    const out = await serializeIlinkSegments([surface])
    expect(out.textChunks).toEqual(["Pick: [A] [B]"])
  })

  it("routes through the per-adapter mapper when ctx is supplied", async () => {
    const surface: A2UIMessageSegment = {
      type: "a2ui",
      surfaceId: "s1",
      content: {
        components: {
          root: { component: "Card", title: "Pick", children: ["y", "n"] },
          y: { component: "Button", text: "Yes" },
          n: { component: "Button", text: "No" },
        },
        dataModel: {},
        rootId: "root",
      },
      plainTextMirror: "Pick",
    }
    const out = await serializeIlinkSegments([surface], {
      adapterId: "adp",
      conversationKey: "wechat-personal:adp:u1",
    })
    expect(out.textChunks[0]).toContain("1) Yes")
    expect(out.textChunks[0]).toContain("2) No")
    const bindings = await getDb().connectorCallbackBindings.toArray()
    // Each plain Button mints a `callback_query` binding under an
    // `a2ui:<surfaceId>:<componentId>:<action>` wire id — same shape every
    // native adapter uses, so the bus's generic callback path can route.
    expect(bindings.filter((b) => b.kind === "callback_query")).toHaveLength(2)
  })

  it("degrades outbound media to a text marker + records a downgrade", async () => {
    const out = await serializeIlinkSegments([
      { type: "image", url: "u" },
      { type: "file", url: "u", name: "a.pdf", mimeType: "application/pdf", sizeBytes: 1 },
    ])
    expect(out.textChunks[0]).toContain("[图片]")
    expect(out.textChunks[0]).toContain("[文件: a.pdf]")
    expect(out.downgrades).toEqual([
      { from: "image", to: "text", reason: "ilink_outbound_media_unsupported" },
      { from: "file", to: "text", reason: "ilink_outbound_media_unsupported" },
    ])
  })

  it("splits text longer than 2000 chars into multiple chunks", async () => {
    const long = "x".repeat(4500)
    const out = await serializeIlinkSegments([{ type: "text", text: long }])
    expect(out.textChunks).toHaveLength(3)
    expect(out.textChunks[0]).toHaveLength(2000)
    expect(out.textChunks[2]).toHaveLength(500)
  })

  it("produces no chunks for an empty segment list", async () => {
    expect((await serializeIlinkSegments([])).textChunks).toEqual([])
  })
})
