/**
 * Tests for the OneBot A2UI mapper — text + image projection only.
 */

import { buildOneBotA2UISegments } from "./a2ui-mapper"
import type { A2UISegmentContent } from "@/types/connectors/segment"

describe("buildOneBotA2UISegments", () => {
  it("emits a single text segment for a Card + Text surface", () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Card", title: "Daily", children: ["t1"] },
        t1: { id: "t1", component: "Text", text: "Body" },
      },
      dataModel: {},
      rootId: "root",
    }
    const segments = buildOneBotA2UISegments(surface, "Daily / Body")
    expect(segments).toEqual([{ type: "text", text: "【Daily】\nBody" }])
  })

  it("emits an image segment for each Image component", () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Column", children: ["t1", "i1"] },
        t1: { id: "t1", component: "Text", text: "Look:" },
        i1: { id: "i1", component: "Image", src: "https://x/y.png", alt: "Chart" },
      },
      dataModel: {},
      rootId: "root",
    }
    const segments = buildOneBotA2UISegments(surface, "Look: image")
    expect(segments.map((s) => s.type)).toEqual(["text", "image"])
    expect(segments[1]).toMatchObject({ type: "image", url: "https://x/y.png", alt: "Chart" })
  })

  it("appends an Available actions tail when surface contains interactive components", () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Column", children: ["t1", "b1", "b2"] },
        t1: { id: "t1", component: "Text", text: "Choose:" },
        b1: { id: "b1", component: "Button", text: "Yes", action: "yes" },
        b2: { id: "b2", component: "Button", text: "No", action: "no" },
      },
      dataModel: {},
      rootId: "root",
    }
    const mirror = "Choose:\n[Yes]\n[No]"
    const segments = buildOneBotA2UISegments(surface, mirror)
    expect(segments).toEqual([
      { type: "text", text: "Choose:" },
      { type: "text", text: `\n— Available actions —\n${mirror}` },
    ])
  })

  it("falls back to the plain text mirror when surface produces nothing visible", () => {
    const surface: A2UISegmentContent = {
      components: {
        root: { id: "root", component: "Chart", chartType: "bar" },
      },
      dataModel: {},
      rootId: "root",
    }
    const segments = buildOneBotA2UISegments(surface, "Chart mirror")
    expect(segments).toEqual([{ type: "text", text: "Chart mirror" }])
  })
})

it("preserves canonical card descriptions and alert messages alongside other content", () => {
  const surface: A2UISegmentContent = {
    rootId: "root",
    dataModel: {},
    components: {
      root: {
        component: "Card",
        title: "Report",
        description: "Summary",
        children: ["alert", "legacy"],
      },
      alert: { component: "Alert", title: "Warning", message: "Review required" },
      legacy: { component: "Alert", text: "Legacy alert" },
    },
  }
  expect(buildOneBotA2UISegments(surface, "")).toEqual([
    { type: "text", text: "【Report】\nSummary\n⚠️ Warning: Review required\n⚠️ Legacy alert" },
  ])
})

it("keeps links, dividers, primitive text and URL-backed images in render order", () => {
  const components = {
    root: {
      component: "Column",
      children: [
        "card",
        "named",
        "bare",
        "badLink",
        "divider",
        "number",
        "boolean",
        "empty",
        "image",
        "badImage",
        "alert",
        "emptyAlert",
      ],
    },
    card: { component: "Card" },
    named: { component: "Link", text: "Docs", href: "https://example.com/docs" },
    bare: { component: "Link", href: "https://example.com" },
    badLink: { component: "Link", text: "No target" },
    divider: { component: "Divider" },
    number: { component: "Text", text: 42 },
    boolean: { component: "Text", text: false },
    empty: { component: "Text" },
    image: { component: "Image", url: "https://example.com/image.png" },
    badImage: { component: "Image" },
    alert: { component: "Alert", title: "Notice" },
    emptyAlert: { component: "Alert" },
  }
  expect(buildOneBotA2UISegments({ components, rootId: "root", dataModel: {} }, "")).toEqual([
    { type: "text", text: "Docs (https://example.com/docs)\nhttps://example.com\n———\n42\nfalse" },
    { type: "image", url: "https://example.com/image.png", alt: undefined },
    { type: "text", text: "⚠️ Notice" },
  ])
})

it("does not insert empty text around an image-only surface", () => {
  expect(
    buildOneBotA2UISegments(
      {
        rootId: "image",
        dataModel: {},
        components: {
          image: { component: "Image", src: "https://example.com/image.png" },
        },
      },
      ""
    )
  ).toEqual([{ type: "image", url: "https://example.com/image.png", alt: undefined }])
})

it("uses a visible fallback for an unsupported surface with no mirror", () => {
  expect(
    buildOneBotA2UISegments(
      {
        rootId: "chart",
        dataModel: {},
        components: {
          chart: { component: "Chart" },
        },
      },
      ""
    )
  ).toEqual([{ type: "text", text: "[empty]" }])
})
