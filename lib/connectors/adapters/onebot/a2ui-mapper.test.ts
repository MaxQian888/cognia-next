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
