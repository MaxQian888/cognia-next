import { readFileSync } from "node:fs"
import { join } from "node:path"

import { SETTINGS_CAPABILITIES, resolveRouteBootCapabilities } from "./route-capabilities"

describe("resolveRouteBootCapabilities", () => {
  it.each([
    ["/", "", []],
    ["/plugins", "", ["plugin-runtime"]],
    ["/workflows/editor", "", ["workflow-automation"]],
    ["/integrations", "", ["integrations"]],
    ["/me/mcp", "", ["integrations"]],
    ["/memory", "", ["knowledge-agents"]],
    ["/me/memory-settings", "", ["knowledge-agents"]],
    ["/me/ocr", "", ["knowledge-agents"]],
    ["/squads", "", ["knowledge-agents", "desktop-tools"]],
    ["/me/scheduler", "", ["workflow-automation"]],
    ["/me/workflows-settings", "", ["workflow-automation"]],
    ["/me/a2ui", "", ["workflow-automation"]],
    ["/skills", "", ["knowledge-agents", "desktop-tools"]],
    ["/me/terminal", "", ["desktop-tools"]],
    ["/settings", "?section=plugins", ["plugin-runtime"]],
    ["/settings", "?section=workflows", ["workflow-automation"]],
    ["/settings", "?section=memory", ["knowledge-agents"]],
    ["/settings", "?section=skills", ["knowledge-agents", "desktop-tools"]],
    ["/settings", "?section=desktop", ["desktop-tools"]],
    // Desktop UI automation, not the workflow engine. This pointed at
    // `workflow-automation`, so opening the section prefetched the wrong bundle
    // and every automation command it drives was still loading.
    ["/settings", "?section=automation", ["desktop-tools"]],
    ["/settings", "?section=connections", ["integrations"]],
    ["/settings", "?section=scheduled-tasks", ["workflow-automation"]],
  ])("maps %s%s to its runtime capability", (pathname, search, expected) => {
    expect(resolveRouteBootCapabilities(pathname as string, search as string)).toEqual(expected)
  })

  it("requests nothing for a section id that does not exist", () => {
    expect(resolveRouteBootCapabilities("/settings", "?section=computer-use")).toEqual([])
  })
})

/**
 * Seven of the twenty keys here were not section ids at all, so a third of the
 * table silently never fired and nothing failed. The map is typed
 * `Record<string, _>` on purpose (importing `SettingsSectionId` would drag the
 * nav config's icon imports into the boot path), so the invariant is checked
 * here instead, by reading the union out of the nav config source.
 */
describe("SETTINGS_CAPABILITIES", () => {
  function settingsSectionIds(): Set<string> {
    const source = readFileSync(
      join(__dirname, "..", "..", "components", "settings", "settings-nav-config.ts"),
      "utf8"
    )
    const union = /export type SettingsSectionId =([\s\S]*?)\n\nexport interface NavItem/.exec(
      source
    )
    if (!union) throw new Error("SettingsSectionId union not found in settings-nav-config.ts")
    const ids = [...union[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
    expect(ids.length).toBeGreaterThan(20)
    return new Set(ids)
  }

  it("keys every entry on a section id the settings shell can actually render", () => {
    const ids = settingsSectionIds()
    const dead = Object.keys(SETTINGS_CAPABILITIES).filter((key) => !ids.has(key))
    expect(dead).toEqual([])
  })
})
