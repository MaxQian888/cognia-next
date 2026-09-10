import { assistantReplyToSegments, buildA2UISegment } from "./a2ui-to-segments"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import { trackInboxEvent } from "@/lib/telemetry/inbox-events"

jest.mock("@/lib/telemetry/inbox-events", () => ({ trackInboxEvent: jest.fn() }))

const SURFACE: A2UISegmentContent = {
  components: {
    root: { id: "root", component: "Column", children: ["txt"] },
    txt: { id: "txt", component: "Text", text: "Hi" },
  },
  dataModel: {},
  rootId: "root",
}

const payload = (id = "s1") => ({
  surface: { id, type: "inline" },
  components: Object.values(SURFACE.components),
})
const fence = (value: unknown, language = "a2ui") =>
  `\`\`\`${language}\n${JSON.stringify(value)}\n\`\`\``

describe("buildA2UISegment", () => {
  it("prefers widget.fallbackText when present", () => {
    const seg = buildA2UISegment("s1", {
      ...SURFACE,
      widget: { fallbackText: "User-provided mirror" },
    })
    expect(seg.type).toBe("a2ui")
    expect(seg.surfaceId).toBe("s1")
    expect(seg.plainTextMirror).toBe("User-provided mirror")
  })

  it("falls back to generatePlainTextMirror when widget.fallbackText is empty/missing", () => {
    const seg = buildA2UISegment("s1", SURFACE)
    expect(seg.plainTextMirror).toBe("Hi")
  })

  it("ignores whitespace-only widget.fallbackText", () => {
    const seg = buildA2UISegment("s1", { ...SURFACE, widget: { fallbackText: "   " } })
    expect(seg.plainTextMirror).toBe("Hi")
  })

  it("records generated plain-text mirror downgrades when adapter context is known", () => {
    buildA2UISegment("s1", SURFACE, { adapterId: "adapter-1", platform: "slack" })
    expect(trackInboxEvent).toHaveBeenCalledWith(
      "a2ui.downgrade",
      expect.objectContaining({
        adapterId: "adapter-1",
        fields: expect.objectContaining({ platform: "slack", reason: "missing_fallback_text" }),
      })
    )
  })
})

describe("assistantReplyToSegments", () => {
  it.each(["a2ui", "A2UI", "json", ""])("extracts %s fences", (language) => {
    expect(assistantReplyToSegments({ text: fence(payload(), language) })[0]).toMatchObject({
      type: "a2ui",
      surfaceId: "s1",
      content: SURFACE,
    })
  })

  it("extracts raw JSON and uses a non-root first component", () => {
    const out = assistantReplyToSegments({
      text: JSON.stringify({
        ...payload(),
        components: [{ id: "title", component: "Text", text: "hello" }],
      }),
    })
    expect(out[0]).toMatchObject({ type: "a2ui", content: { rootId: "title" } })
  })

  it("preserves widget metadata and its explicit fallback", () => {
    const value = payload()
    const out = assistantReplyToSegments({
      text: fence({
        ...value,
        surface: { ...value.surface, widget: { fallbackText: "Accessible overview" } },
      }),
    })
    expect(out[0]).toMatchObject({
      type: "a2ui",
      plainTextMirror: "Accessible overview",
      content: { widget: { fallbackText: "Accessible overview" } },
    })
  })

  it("preserves unrelated fences and prose around multiple surfaces", () => {
    const prefix = `${fence({ example: true }, "json")}\n${fence(payload(), "typescript")}\n`
    const out = assistantReplyToSegments({
      text: `${prefix}${fence(payload())}\nBetween\n${fence(payload("s2"))}\nEnd`,
    })
    expect(out.map((s) => s.type)).toEqual(["markdown", "a2ui", "markdown", "a2ui", "markdown"])
    expect(out[0]).toEqual({ type: "markdown", md: prefix })
    expect(out[2]).toEqual({ type: "markdown", md: "\nBetween\n" })
    expect(out[4]).toEqual({ type: "markdown", md: "\nEnd" })
  })

  it("keeps the tool snapshot authoritative without printing duplicate JSON", () => {
    const out = assistantReplyToSegments({
      text: fence(payload()),
      a2uiSurfaces: { s1: SURFACE },
    })
    expect(out).toEqual([buildA2UISegment("s1", SURFACE)])
  })

  it("reduces protocol updates, merges data, replaces data, and drops deleted surfaces", () => {
    const out = assistantReplyToSegments({
      text: fence([
        { type: "createSurface", surfaceId: "s1", title: "Survey", surfaceType: "panel" },
        {
          type: "updateComponents",
          surfaceId: "s1",
          components: Object.values(SURFACE.components),
        },
        { type: "dataModelUpdate", surfaceId: "s1", data: { stale: true } },
        {
          type: "dataModelUpdate",
          surfaceId: "s1",
          data: { person: { name: "Ada" } },
          merge: false,
        },
        { type: "dataModelUpdate", surfaceId: "s1", data: { person: { age: 30 } } },
        { type: "surfaceReady", surfaceId: "s1" },
        { type: "createSurface", surfaceId: "deleted" },
        { type: "deleteSurface", surfaceId: "deleted" },
      ]),
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: "a2ui",
      content: { title: "Survey", dataModel: { person: { name: "Ada", age: 30 } } },
    })
    expect((out[0] as { content: A2UISegmentContent }).content.dataModel).not.toHaveProperty(
      "stale"
    )
  })

  it("supports implicit surfaces from protocol component and data updates", () => {
    const out = assistantReplyToSegments({
      text: fence([
        { type: "dataModelUpdate", surfaceId: "s1", data: { title: "Bound" } },
        {
          type: "updateComponents",
          surfaceId: "s1",
          components: [{ id: "label", component: "Text", text: { path: "/title" } }],
        },
      ]),
    })
    expect(out[0]).toMatchObject({
      type: "a2ui",
      content: { rootId: "label", dataModel: { title: "Bound" } },
    })
  })

  it.each([
    "```a2ui\n{broken}\n```",
    '```a2ui\n{"surface":',
    fence({ unrelated: true }),
    fence({ ...payload(), components: [] }),
    fence({ ...payload(), components: [null] }),
    fence({ ...payload(), components: [{ id: 1, component: "Text" }] }),
    fence({ ...payload(), components: [{ id: "__proto__", component: "Text" }] }),
    fence({ ...payload(), components: [{ id: "x" }] }),
    fence({
      ...payload(),
      components: [{ id: "root", component: "Column", children: ["missing"] }],
    }),
    fence({ ...payload(), components: [{ id: "root", component: "Column", children: ["root"] }] }),
    fence([{ type: "updateComponents", surfaceId: 123, components: [] }]),
    fence([{ type: "deleteSurface", surfaceId: "s1" }]),
    fence([{ type: "dataModelUpdate", surfaceId: "s1", data: [] }]),
    fence([{ type: "createSurface", surfaceId: "s1" }, { type: "unknown" }]),
  ])("preserves invalid or incomplete content: %s", (text) => {
    expect(assistantReplyToSegments({ text })).toEqual([{ type: "markdown", md: text }])
  })

  it("projects the fenced simplified A2UI reply from Feishu instead of sending its JSON", () => {
    const payload = {
      surface: { id: "cognia-analysis", type: "inline", title: "Cognia Next 分析" },
      components: Object.values(SURFACE.components),
    }
    const out = assistantReplyToSegments({
      text: `项目速览：\n\n\`\`\`a2ui\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\n分析完成。`,
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    })
    expect(out.map((segment) => segment.type)).toEqual(["markdown", "a2ui", "markdown"])
    expect(out[1]).toMatchObject({
      surfaceId: "cognia-analysis",
      content: { ...SURFACE, title: "Cognia Next 分析", surfaceType: "inline" },
      plainTextMirror: "Hi",
    })
    expect(JSON.stringify(out)).not.toContain("```a2ui")
  })

  it("emits surfaces in surfaceOrder ahead of trailing markdown", () => {
    const out = assistantReplyToSegments({
      text: "Look at the card above.",
      a2uiSurfaces: { s1: SURFACE, s2: SURFACE },
      a2uiSurfaceOrder: ["s1", "s2"],
    })
    expect(out.map((s) => s.type)).toEqual(["a2ui", "a2ui", "markdown"])
    expect((out[0] as { surfaceId: string }).surfaceId).toBe("s1")
    expect((out[1] as { surfaceId: string }).surfaceId).toBe("s2")
  })

  it("uses object key order when surfaceOrder is omitted", () => {
    const out = assistantReplyToSegments({
      text: "x",
      a2uiSurfaces: { s1: SURFACE, s2: SURFACE },
    })
    expect(
      out.filter((s) => s.type === "a2ui").map((s) => (s as { surfaceId: string }).surfaceId)
    ).toEqual(["s1", "s2"])
  })

  it("omits the markdown segment when reply text is empty", () => {
    const out = assistantReplyToSegments({
      text: "",
      a2uiSurfaces: { s1: SURFACE },
      a2uiSurfaceOrder: ["s1"],
    })
    expect(out.map((s) => s.type)).toEqual(["a2ui"])
  })

  it("returns a single empty text segment when reply is empty and has no surfaces", () => {
    expect(assistantReplyToSegments({ text: "" })).toEqual([{ type: "text", text: "" }])
  })

  it("preserves trailing whitespace in markdown unless it is the whole reply", () => {
    const out = assistantReplyToSegments({
      text: "Header\n\nBody\n",
    })
    expect(out).toEqual([{ type: "markdown", md: "Header\n\nBody\n" }])
  })

  it("skips surfaceOrder entries that are missing from a2uiSurfaces", () => {
    const out = assistantReplyToSegments({
      text: "x",
      a2uiSurfaces: { s1: SURFACE },
      a2uiSurfaceOrder: ["missing", "s1"],
    })
    expect(out.filter((s) => s.type === "a2ui")).toHaveLength(1)
  })
})
