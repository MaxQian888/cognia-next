import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { serializeIlinkSegments } from "./serialize"
import type { A2UIMessageSegment } from "@/types/connectors/segment"
import {
  __peekNumericActionForTesting,
  __resetNumericActionRegistryForTesting,
} from "./numeric-action-registry"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetNumericActionRegistryForTesting()
})
afterAll(dbFixture.dispose)

describe("serializeIlinkSegments", () => {
  it("joins text + markdown into one chunk", async () => {
    const out = await serializeIlinkSegments([
      { type: "text", text: "Hello" },
      { type: "markdown", md: "world" },
    ])
    expect(out.textChunks).toEqual(["Hello\n\nworld"])
    expect(out.downgrades).toEqual([])
  })

  it("preserves unsupported interactive content as explicit text downgrades", async () => {
    const out = await serializeIlinkSegments([
      { type: "emoji", code: "smile" },
      { type: "poll", question: "Pick one", options: ["A", "B"] },
      {
        type: "card",
        card: { kind: "example", payload: { title: "Complete title", body: "Complete body" } },
      },
    ])
    expect(out.textChunks.join("")).toContain("smile")
    expect(out.textChunks.join("")).toContain("Pick one\n1. A\n2. B")
    expect(out.textChunks.join("")).toContain("Complete body")
    expect(out.downgrades.map((value) => value.from)).toEqual(["emoji", "poll", "card"])
  })

  it("preserves leading indentation and trailing whitespace across text chunks", async () => {
    const text = "    " + "x".repeat(2100) + "  \n"
    const out = await serializeIlinkSegments([{ type: "code", code: text }])
    expect(out.textChunks.join("")).toBe(text)
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

  it("preserves ordered media parts without text placeholders", async () => {
    const image = { type: "image" as const, url: "u" }
    const file = {
      type: "file" as const,
      url: "u",
      name: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
    }
    const out = await serializeIlinkSegments([
      { type: "text", text: "before" },
      image,
      { type: "text", text: "between" },
      file,
    ])
    expect(out.parts).toEqual([
      { type: "text", text: "before" },
      { type: "media", segment: image },
      { type: "text", text: "between" },
      { type: "media", segment: file },
    ])
    expect(out.downgrades).toEqual([])
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

it("uses unique digits across surfaces in one message and caps the combined menu at nine", async () => {
  const ctx = { adapterId: "ad", conversationKey: "wechat-personal:ad:u1" }
  const surfaces: A2UIMessageSegment[] = Array.from({ length: 10 }, (_, i) => ({
    type: "a2ui",
    surfaceId: `s${i}`,
    plainTextMirror: `Surface ${i}`,
    content: {
      rootId: "button",
      dataModel: {},
      components: {
        button: { component: "Button", text: `Action ${i}` },
      },
    },
  }))
  const out = await serializeIlinkSegments(surfaces, ctx)
  const text = out.textChunks.join("")
  expect(text).toContain("1) Action 0")
  expect(text).toContain("2) Action 1")
  expect(text).toContain("9) Action 8")
  expect(text).not.toContain("10) Action")
  expect(text).not.toContain("1) Action 9")
  expect(__peekNumericActionForTesting(ctx.conversationKey, 1)).toBe("a2ui:s0:button:button")
  expect(__peekNumericActionForTesting(ctx.conversationKey, 9)).toBe("a2ui:s8:button:button")
  expect(await getDb().connectorCallbackBindings.count()).toBe(9)
})

it("retains mention, reply, location, and code context while preserving audio and video", async () => {
  const out = await serializeIlinkSegments([
    { type: "code", code: "return 1" },
    { type: "mention", userId: "u1", displayName: "Alice" },
    { type: "mention", userId: "u2" },
    { type: "reply", messageId: "m1", snippet: "Previous question" },
    { type: "location", lat: 1, lon: 2, name: "Office" },
    { type: "location", lat: 3, lon: 4 },
    { type: "voice", url: "audio" },
    { type: "video", url: "video" },
  ])
  expect(out.textChunks).toEqual([
    "return 1\n\n@Alice\n\n@u2\n\n> Previous question\n\n📍 Office\n\n📍 3,4",
  ])
  expect(out.downgrades.map((entry) => entry.from)).toEqual(["voice"])
})

it("does not split surrogate pairs at text chunk boundaries", async () => {
  const text = "x".repeat(1999) + "😀" + "end"
  const out = await serializeIlinkSegments([{ type: "text", text }])
  expect(out.textChunks).toEqual(["x".repeat(1999), "😀end"])
})
