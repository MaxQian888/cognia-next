import { assistantReplyToSegments, buildA2UISegment } from "./a2ui-to-segments"
import type { A2UISegmentContent } from "@/types/connectors/segment"

const SURFACE: A2UISegmentContent = {
  components: {
    root: { id: "root", component: "Column", children: ["txt"] },
    txt: { id: "txt", component: "Text", text: "Hi" },
  },
  dataModel: {},
  rootId: "root",
}

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
})

describe("assistantReplyToSegments", () => {
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
