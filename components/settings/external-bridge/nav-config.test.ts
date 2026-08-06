import { ALL_BRIDGE_SCOPES, type BridgeScope } from "@/types/wiki"

import {
  BRIDGE_NAV_GROUPS,
  BRIDGE_NAV_ITEMS,
  DEFAULT_BRIDGE_PANEL,
  groupBridgeScopes,
  resolveBridgePanel,
} from "./nav-config"

describe("external-bridge nav-config", () => {
  it("exposes every grouped item in the flat list", () => {
    const grouped = BRIDGE_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id))
    expect(BRIDGE_NAV_ITEMS.map((i) => i.id)).toEqual(grouped)
  })

  it("resolves a known deep link and falls back otherwise", () => {
    expect(resolveBridgePanel("audit")).toBe("audit")
    expect(resolveBridgePanel("nope")).toBe(DEFAULT_BRIDGE_PANEL)
    expect(resolveBridgePanel(null)).toBe(DEFAULT_BRIDGE_PANEL)
  })
})

describe("groupBridgeScopes", () => {
  it("keeps every scope — a new one must not silently vanish from the UI", () => {
    const grouped = groupBridgeScopes().flatMap((g) => g.scopes)
    expect(grouped.sort()).toEqual([...ALL_BRIDGE_SCOPES].sort())
  })

  it("buckets by namespace prefix", () => {
    const groups = groupBridgeScopes()
    const wiki = groups.find((g) => g.id === "wiki")
    expect(wiki?.scopes).toEqual(["wiki:cognia", "wiki:user-repo"])
    const runtime = groups.find((g) => g.id === "runtime")
    expect(runtime?.scopes).toContain("runtime:skills")
    expect(runtime?.scopes).toContain("runtime:agent-teams")
    expect(groups.find((g) => g.id === "workflow")?.scopes).toEqual(["workflow:run"])
  })

  it("renders a scope with an unrecognised prefix rather than dropping it", () => {
    // The grouping is derived from the prefix, not a hand-maintained list, so a
    // future `billing:read` must still appear — just after the known groups.
    const groups = groupBridgeScopes(["wiki:cognia", "billing:read" as BridgeScope])
    expect(groups.at(-1)).toMatchObject({ id: "billing", scopes: ["billing:read"] })
  })

  it("orders known groups deterministically", () => {
    const ids = groupBridgeScopes().map((g) => g.id)
    expect(ids.indexOf("wiki")).toBeLessThan(ids.indexOf("rag"))
    expect(ids.indexOf("rag")).toBeLessThan(ids.indexOf("runtime"))
  })
})
