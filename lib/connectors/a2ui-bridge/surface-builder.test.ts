/**
 * Tests for the plugin-facing A2UI surface builder.
 *
 * Covers structural validation (empty / duplicate-id / missing-id / bad-root /
 * dangling-child / nested tabs+accordion refs), array→record assembly with
 * defaults and optional passthrough, segment + outbound-request construction,
 * the typed component factories, and the `createA2UIBuilder()` namespace.
 */

import type { A2UIComponent } from "@/types/a2ui/schema"
import {
  A2UISurfaceBuildError,
  validateA2UISurfaceComponents,
  buildA2UISurfaceContent,
  buildA2UIMessageSegment,
  buildA2UIOutboundRequest,
  a2uiComponent,
  createA2UIBuilder,
} from "./surface-builder"

const CONV = { platform: "telegram", adapterId: "tg", chatId: "42" } as never

describe("validateA2UISurfaceComponents", () => {
  it("throws on an empty component list", () => {
    expect(() => validateA2UISurfaceComponents([])).toThrow(A2UISurfaceBuildError)
    expect(() => validateA2UISurfaceComponents([])).toThrow(/at least one/)
  })

  it("throws on a component with an empty id", () => {
    const comps = [{ id: "", component: "Text", text: "x" }] as A2UIComponent[]
    expect(() => validateA2UISurfaceComponents(comps)).toThrow(/non-empty id/)
  })

  it("throws on duplicate ids", () => {
    const comps = [
      { id: "a", component: "Text", text: "x" },
      { id: "a", component: "Text", text: "y" },
    ] as A2UIComponent[]
    expect(() => validateA2UISurfaceComponents(comps)).toThrow(/duplicate component id: a/)
  })

  it("defaults the root to the 'root' component when present", () => {
    const comps = [
      { id: "first", component: "Text", text: "x" },
      { id: "root", component: "Text", text: "y" },
    ] as A2UIComponent[]
    expect(validateA2UISurfaceComponents(comps)).toBe("root")
  })

  it("defaults the root to the first component when no 'root' id exists", () => {
    const comps = [
      { id: "first", component: "Text", text: "x" },
      { id: "second", component: "Text", text: "y" },
    ] as A2UIComponent[]
    expect(validateA2UISurfaceComponents(comps)).toBe("first")
  })

  it("honours an explicit rootId", () => {
    const comps = [
      { id: "a", component: "Text", text: "x" },
      { id: "b", component: "Text", text: "y" },
    ] as A2UIComponent[]
    expect(validateA2UISurfaceComponents(comps, "b")).toBe("b")
  })

  it("throws when the explicit rootId is not among the components", () => {
    const comps = [{ id: "a", component: "Text", text: "x" }] as A2UIComponent[]
    expect(() => validateA2UISurfaceComponents(comps, "missing")).toThrow(
      /rootId "missing" is not among/
    )
  })

  it("throws on a dangling child reference", () => {
    const comps = [
      { id: "root", component: "Column", children: ["a", "ghost"] },
      { id: "a", component: "Text", text: "x" },
    ] as A2UIComponent[]
    expect(() => validateA2UISurfaceComponents(comps)).toThrow(/references unknown child "ghost"/)
  })

  it("validates references in children, footer, and actions arrays", () => {
    const comps = [
      { id: "root", component: "Card", children: ["body"], footer: ["foot"] },
      { id: "body", component: "Text", text: "b" },
      { id: "foot", component: "Text", text: "f" },
      { id: "dlg", component: "Dialog", open: false, children: ["body"], actions: ["foot"] },
    ] as A2UIComponent[]
    expect(() => validateA2UISurfaceComponents(comps, "root")).not.toThrow()
  })

  it("validates nested child refs inside Tabs and Accordion entries", () => {
    const comps = [
      {
        id: "root",
        component: "Tabs",
        tabs: [{ id: "t1", label: "One", children: ["p1"] }],
      },
      { id: "p1", component: "Text", text: "p" },
    ] as A2UIComponent[]
    expect(() => validateA2UISurfaceComponents(comps, "root")).not.toThrow()

    const broken = [
      {
        id: "root",
        component: "Accordion",
        items: [{ id: "i1", title: "One", children: ["missing"] }],
      },
    ] as A2UIComponent[]
    expect(() => validateA2UISurfaceComponents(broken, "root")).toThrow(
      /references unknown child "missing"/
    )
  })
})

describe("buildA2UISurfaceContent", () => {
  it("keys components by id and resolves the root", () => {
    const content = buildA2UISurfaceContent({
      components: [a2uiComponent.column("root", ["title"]), a2uiComponent.text("title", "Hi")],
    })
    expect(content.rootId).toBe("root")
    expect(Object.keys(content.components)).toEqual(["root", "title"])
    expect(content.components.title).toEqual({ id: "title", component: "Text", text: "Hi" })
    expect(content.dataModel).toEqual({})
  })

  it("passes through dataModel, surfaceType, title, catalogId and widget", () => {
    const content = buildA2UISurfaceContent({
      components: [a2uiComponent.text("root", { path: "/msg" })],
      dataModel: { msg: "bound" },
      surfaceType: "dialog",
      title: "T",
      catalogId: "cat",
      widget: { fallbackText: "fb" },
    })
    expect(content.dataModel).toEqual({ msg: "bound" })
    expect(content.surfaceType).toBe("dialog")
    expect(content.title).toBe("T")
    expect(content.catalogId).toBe("cat")
    expect(content.widget).toEqual({ fallbackText: "fb" })
  })

  it("omits optional fields when not provided", () => {
    const content = buildA2UISurfaceContent({ components: [a2uiComponent.text("root", "x")] })
    expect(content).not.toHaveProperty("surfaceType")
    expect(content).not.toHaveProperty("title")
    expect(content).not.toHaveProperty("catalogId")
    expect(content).not.toHaveProperty("widget")
  })

  it("propagates validation errors", () => {
    expect(() => buildA2UISurfaceContent({ components: [] })).toThrow(A2UISurfaceBuildError)
  })
})

describe("buildA2UIMessageSegment", () => {
  it("wraps content into an a2ui segment with a generated plain-text mirror", () => {
    const seg = buildA2UIMessageSegment("surf-1", {
      components: [a2uiComponent.text("root", "Hello world")],
    })
    expect(seg.type).toBe("a2ui")
    expect(seg.surfaceId).toBe("surf-1")
    expect(seg.content.rootId).toBe("root")
    expect(typeof seg.plainTextMirror).toBe("string")
    expect(seg.plainTextMirror.length).toBeGreaterThan(0)
  })

  it("prefers widget.fallbackText for the mirror when provided", () => {
    const seg = buildA2UIMessageSegment("surf-2", {
      components: [a2uiComponent.text("root", "ignored")],
      widget: { fallbackText: "explicit mirror" },
    })
    expect(seg.plainTextMirror).toBe("explicit mirror")
  })
})

describe("buildA2UIOutboundRequest", () => {
  it("builds a request carrying a single a2ui surface with a fresh idempotency key", () => {
    const req = buildA2UIOutboundRequest({
      conversationRef: CONV,
      surfaceId: "surf-3",
      components: [a2uiComponent.text("root", "Hi")],
    })
    expect(req.conversationRef).toBe(CONV)
    expect(req.segments).toHaveLength(1)
    expect(req.segments[0]).toMatchObject({ type: "a2ui", surfaceId: "surf-3" })
    expect(typeof req.metadata?.idempotencyKey).toBe("string")
    expect(req.metadata?.idempotencyKey?.length).toBeGreaterThan(0)
  })

  it("appends a trailing markdown segment when text is non-empty", () => {
    const req = buildA2UIOutboundRequest({
      conversationRef: CONV,
      surfaceId: "surf-4",
      components: [a2uiComponent.text("root", "Hi")],
      text: "see above",
    })
    expect(req.segments).toHaveLength(2)
    expect(req.segments[1]).toEqual({ type: "markdown", md: "see above" })
  })

  it("skips the markdown segment for whitespace-only text", () => {
    const req = buildA2UIOutboundRequest({
      conversationRef: CONV,
      components: [a2uiComponent.text("root", "Hi")],
      text: "   ",
    })
    expect(req.segments).toHaveLength(1)
  })

  it("honours an explicit idempotencyKey and mints a surfaceId when omitted", () => {
    const req = buildA2UIOutboundRequest({
      conversationRef: CONV,
      components: [a2uiComponent.text("root", "Hi")],
      idempotencyKey: "my-key",
    })
    expect(req.metadata?.idempotencyKey).toBe("my-key")
    const seg = req.segments[0] as { surfaceId: string }
    expect(seg.surfaceId).toMatch(/^plugin-a2ui-/)
  })
})

describe("a2uiComponent factories", () => {
  it("text / button / card / row / column", () => {
    expect(a2uiComponent.text("t", "hi", { variant: "heading1" })).toEqual({
      id: "t",
      component: "Text",
      text: "hi",
      variant: "heading1",
    })
    expect(a2uiComponent.button("b", "OK", "confirm", { variant: "primary" })).toEqual({
      id: "b",
      component: "Button",
      text: "OK",
      action: "confirm",
      variant: "primary",
    })
    expect(a2uiComponent.card("c", { title: "Card", children: ["x"] })).toEqual({
      id: "c",
      component: "Card",
      title: "Card",
      children: ["x"],
    })
    expect(a2uiComponent.row("r", ["a", "b"], { gap: 2 })).toEqual({
      id: "r",
      component: "Row",
      children: ["a", "b"],
      gap: 2,
    })
    expect(a2uiComponent.column("col", ["a"])).toEqual({
      id: "col",
      component: "Column",
      children: ["a"],
    })
  })

  it("alert / image / link / badge / divider", () => {
    expect(a2uiComponent.alert("a", "watch out", { variant: "warning" })).toEqual({
      id: "a",
      component: "Alert",
      message: "watch out",
      variant: "warning",
    })
    expect(a2uiComponent.image("img", "https://x/y.png", { alt: "y" })).toEqual({
      id: "img",
      component: "Image",
      src: "https://x/y.png",
      alt: "y",
    })
    expect(a2uiComponent.link("l", "Docs", { href: "https://x" })).toEqual({
      id: "l",
      component: "Link",
      text: "Docs",
      href: "https://x",
    })
    expect(a2uiComponent.badge("bd", "New")).toEqual({
      id: "bd",
      component: "Badge",
      text: "New",
    })
    expect(a2uiComponent.divider("d", { text: "or" })).toEqual({
      id: "d",
      component: "Divider",
      text: "or",
    })
  })

  it("select / textField / list", () => {
    expect(
      a2uiComponent.select("s", { path: "/v" }, [{ value: "a", label: "A" }], { label: "Pick" })
    ).toEqual({
      id: "s",
      component: "Select",
      value: { path: "/v" },
      options: [{ value: "a", label: "A" }],
      label: "Pick",
    })
    expect(a2uiComponent.textField("tf", { path: "/name" }, { placeholder: "Name" })).toEqual({
      id: "tf",
      component: "TextField",
      value: { path: "/name" },
      placeholder: "Name",
    })
    expect(a2uiComponent.list("ls", { items: { path: "/rows" }, emptyText: "none" })).toEqual({
      id: "ls",
      component: "List",
      items: { path: "/rows" },
      emptyText: "none",
    })
  })
})

describe("createA2UIBuilder", () => {
  it("exposes surface / segment / message / component and round-trips", () => {
    const b = createA2UIBuilder()
    const content = b.surface({ components: [a2uiComponent.text("root", "Hi")] })
    expect(content.rootId).toBe("root")

    const seg = b.segment("s1", content)
    expect(seg).toMatchObject({ type: "a2ui", surfaceId: "s1" })

    const req = b.message({
      conversationRef: CONV,
      surfaceId: "s2",
      components: [
        a2uiComponent.card("root", { title: "Hi", children: ["btn"] }),
        a2uiComponent.button("btn", "Go", "go"),
      ],
    })
    expect(req.segments[0]).toMatchObject({ type: "a2ui", surfaceId: "s2" })
    expect(b.component).toBe(a2uiComponent)
  })
})
