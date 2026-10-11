import { readFileSync } from "node:fs"
import { join } from "node:path"

import { PLUGIN_RAIL_WIDTH } from "./plugin-rail-width"

describe("PLUGIN_RAIL_WIDTH", () => {
  it("actually sizes the section-nav pane", () => {
    // The constant existed once with no importer, so the nav rail stayed on
    // percentages. A constant nothing reads is the same bug as no constant.
    const source = readFileSync(join(__dirname, "plugin-panel.tsx"), "utf8")
    const leftPane = /leftPane=\{\{([\s\S]*?)\n {6}\}\}/.exec(source)?.[1]
    expect(leftPane).toBeDefined()
    expect(leftPane).toContain("defaultSize: PLUGIN_RAIL_WIDTH")
    // Percentage bounds would clamp the pinned default below itself on a
    // narrow window, so the whole rail has to be expressed in one unit. The
    // right pane is deliberately still proportional, hence the scoped read.
    expect(leftPane).not.toMatch(/(?:min|max)Size: \d/)
  })

  it("is a CSS length react-resizable-panels can interpret as a fixed size", () => {
    expect(PLUGIN_RAIL_WIDTH).toMatch(/^\d+(\.\d+)?(px|rem|em)$/)
  })
})
