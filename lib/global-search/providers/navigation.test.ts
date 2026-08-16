import { makeProviderInput, makeTestContext } from "../testing"
import { navigationCandidates, navigationProvider } from "./navigation"

describe("navigation provider", () => {
  it("lists the two guild views plus the platform catalog", () => {
    const rows = navigationCandidates(makeTestContext({ platform: "tauri" }))
    expect(rows[0]!.title).toBe("desktop.guildRail.directMessages")
    expect(rows[1]!.title).toBe("desktop.guildRail.canvas")
    expect(rows.some((r) => r.id === "page:browser")).toBe(true)
    // Mobile drops desktop-only destinations.
    const mobile = navigationCandidates(makeTestContext({ platform: "mobile" }))
    expect(mobile.some((r) => r.id === "page:browser")).toBe(false)
  })

  it("matches labels, ids and routes", async () => {
    const byLabel = await navigationProvider.search(
      makeProviderInput("desktop.guildRail.workflows", { ctx: makeTestContext() })
    )
    expect(byLabel.items[0]).toMatchObject({
      id: "navigation:page:workflows",
      kind: "navigation",
      meta: "/workflows",
      action: { type: "navigate", href: "/workflows" },
    })
    const byRoute = await navigationProvider.search(makeProviderInput("/scheduler"))
    expect(byRoute.items.map((i) => i.id)).toContain("navigation:page:scheduler")
    const guild = await navigationProvider.search(makeProviderInput("canvas"))
    expect(guild.items[0]!.action).toEqual({ type: "switch-guild", kind: "canvas" })
    expect(guild.items[0]!.icon).toBeDefined()
  })

  it("suggests the first few destinations", async () => {
    const items = await navigationProvider.suggest!({
      ctx: makeTestContext(),
      limit: 3,
      signal: new AbortController().signal,
    })
    expect(items).toHaveLength(3)
    expect(items[0]!.score).toBeGreaterThan(items[2]!.score)
  })
})
