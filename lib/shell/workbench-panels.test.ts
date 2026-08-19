/**
 * Two jobs, and they are different in kind:
 *
 *  - **Parity.** `WORKBENCH_PANEL_CATALOG` duplicates identities that really
 *    live in `components/artifacts/chat-dock-panels.tsx`, because those panels
 *    are built inside hooks closing over session state and cannot be enumerated
 *    at rest. Duplication is only safe while something notices drift, so the
 *    catalog is checked against the source it copies —  the same answer
 *    `lib/context-workbench/taxonomy-parity.test.ts` gives for the activity
 *    taxonomy.
 *
 *  - **Resolution.** The order/hidden semantics the customizer and the workbench
 *    both depend on.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  WORKBENCH_PANEL_CATALOG,
  isDefaultWorkbenchPanelLayout,
  isWorkbenchPanelHidden,
  resolveWorkbenchPanelLayout,
  workbenchPanelIndex,
  workbenchPanelLayoutOf,
} from "./workbench-panels"
import { DEFAULT_WORKBENCH_PANEL_LAYOUT } from "@/types/shell/workbench-panels"

/**
 * Panel identities declared by the chat dock, scraped from source.
 *
 * The `id:` constants in that file are re-declared here rather than imported:
 * importing the module would pull the whole panel tree (Monaco, the browser
 * pane, Dexie) into a `node`-environment test. A constant added there and not
 * here throws rather than silently dropping the panel from the comparison.
 */
const PANEL_ID_CONSTANTS: Record<string, string> = {
  WORKSPACE_PANEL_ID: "workspace",
  PROJECT_OVERVIEW_PANEL_ID: "project-overview",
  SIDECHAT_PANEL_ID: "session-sidechat",
  SESSION_ARTIFACT_LIST_PANEL_ID: "artifacts",
  TEAM_MEMBERS_PANEL_ID: "team-members",
}

function declaredPanels(): Map<string, string> {
  const source = readFileSync(
    join(__dirname, "../../components/artifacts/chat-dock-panels.tsx"),
    "utf8"
  )
  const pattern =
    /\bid:\s*("(?<literal>[^"]+)"|(?<constant>[A-Z_]+)),\s*\n\s*activity:\s*"(?<activity>[^"]+)"/g
  const found = new Map<string, string>()
  for (const match of source.matchAll(pattern)) {
    const groups = match.groups!
    const id = groups.literal ?? PANEL_ID_CONSTANTS[groups.constant!]
    if (!id) throw new Error(`Unmapped panel id constant: ${groups.constant}`)
    found.set(id, groups.activity!)
  }
  return found
}

describe("WORKBENCH_PANEL_CATALOG parity", () => {
  it("lists every panel the chat dock declares", () => {
    const declared = [...declaredPanels().keys()].sort()
    const cataloged = WORKBENCH_PANEL_CATALOG.map((item) => item.id).sort()
    // A panel missing here is one the user cannot reorder or hide, silently.
    expect(cataloged).toEqual(declared)
  })

  it("agrees with the source on which activity each panel groups under", () => {
    const declared = declaredPanels()
    for (const item of WORKBENCH_PANEL_CATALOG) {
      // A wrong activity would file the panel under a group it never appears
      // in, so the customizer would offer a tab the rail can never show.
      expect([item.id, item.activity]).toEqual([item.id, declared.get(item.id)])
    }
  })

  it("holds no duplicate ids", () => {
    const ids = WORKBENCH_PANEL_CATALOG.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("workbenchPanelLayoutOf", () => {
  it("falls back to the shipped default when nothing is stored", () => {
    expect(workbenchPanelLayoutOf(undefined)).toEqual(DEFAULT_WORKBENCH_PANEL_LAYOUT)
  })

  it("fills in a half-written layout", () => {
    expect(workbenchPanelLayoutOf({ hidden: ["memory"] })).toEqual({
      order: [],
      hidden: ["memory"],
    })
  })
})

describe("resolveWorkbenchPanelLayout", () => {
  const catalog = [...WORKBENCH_PANEL_CATALOG]

  it("leaves an untouched layout in catalog order", () => {
    // The default order is empty on purpose — the panels' own `order:` numbers
    // are the shipped order, and baking today's ids into settings would freeze
    // it the first time the customizer opened.
    const resolved = resolveWorkbenchPanelLayout(catalog, DEFAULT_WORKBENCH_PANEL_LAYOUT)
    expect(resolved.visible.map((item) => item.id)).toEqual(catalog.map((item) => item.id))
    expect(resolved.hidden).toEqual([])
  })

  it("puts stored ids first and appends panels the layout never mentioned", () => {
    const resolved = resolveWorkbenchPanelLayout(catalog, { order: ["memory"], hidden: [] })
    expect(resolved.order[0]?.id).toBe("memory")
    expect(resolved.order).toHaveLength(catalog.length)
  })

  it("keeps a hidden panel's slot in the order so unhiding restores it", () => {
    const resolved = resolveWorkbenchPanelLayout(catalog, {
      order: ["memory", "preview"],
      hidden: ["memory"],
    })
    expect(resolved.order[0]?.id).toBe("memory")
    expect(resolved.hidden.map((item) => item.id)).toEqual(["memory"])
    expect(resolved.visible.map((item) => item.id)).not.toContain("memory")
  })

  it("ignores an id the catalog does not know", () => {
    // An uninstalled plugin leaves its id behind in the stored layout. Inert
    // rather than a problem: it simply stops resolving.
    const resolved = resolveWorkbenchPanelLayout(catalog, {
      order: ["acme:gone"],
      hidden: ["acme:gone"],
    })
    expect(resolved.order.map((item) => item.id)).not.toContain("acme:gone")
    expect(resolved.hidden).toEqual([])
  })
})

describe("workbenchPanelIndex", () => {
  it("sorts unmentioned panels after named ones rather than to the front", () => {
    const layout = { order: ["memory", "preview"], hidden: [] }
    expect(workbenchPanelIndex("memory", layout)).toBe(0)
    expect(workbenchPanelIndex("preview", layout)).toBe(1)
    // Every panel the user never reordered, and every plugin one, lands here —
    // so a third-party panel can never be pushed out of its group.
    expect(workbenchPanelIndex("logs", layout)).toBe(2)
  })
})

describe("isWorkbenchPanelHidden / isDefaultWorkbenchPanelLayout", () => {
  it("reports a hidden panel", () => {
    expect(isWorkbenchPanelHidden("memory", { order: [], hidden: ["memory"] })).toBe(true)
    expect(isWorkbenchPanelHidden("preview", { order: [], hidden: ["memory"] })).toBe(false)
  })

  it("treats only an empty layout as the shipped default", () => {
    expect(isDefaultWorkbenchPanelLayout(DEFAULT_WORKBENCH_PANEL_LAYOUT)).toBe(true)
    expect(isDefaultWorkbenchPanelLayout({ order: ["memory"], hidden: [] })).toBe(false)
    expect(isDefaultWorkbenchPanelLayout({ order: [], hidden: ["memory"] })).toBe(false)
  })
})
