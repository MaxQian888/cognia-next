import { SETTINGS_ROUTE, settingsHref } from "./deep-link"
import { SETTINGS_NAV } from "@/components/settings/settings-nav-config"

describe("settingsHref", () => {
  it("builds a section link", () => {
    expect(settingsHref("providers")).toBe("/settings?section=providers")
  })

  it("adds the focus param that use-setting-focus consumes", () => {
    // The point of `focus` is landing on the control, not the top of the pane.
    expect(settingsHref("providers", "anthropic-key")).toBe(
      "/settings?section=providers&focus=anthropic-key"
    )
  })

  it("drops a focus id that use-setting-focus would reject", () => {
    // That hook guards its selector with /^[a-z0-9-]+$/i; emitting an id it
    // refuses would produce a link that silently does nothing.
    expect(settingsHref("providers", "not a control id")).toBe("/settings?section=providers")
    expect(settingsHref("providers", "a.b")).toBe("/settings?section=providers")
    expect(settingsHref("providers", "")).toBe("/settings?section=providers")
  })

  it("produces a URL the settings route can parse back", () => {
    const url = new URL(settingsHref("external-bridge", "agent-command"), "https://x.test")
    expect(url.pathname).toBe(SETTINGS_ROUTE)
    expect(url.searchParams.get("section")).toBe("external-bridge")
    expect(url.searchParams.get("focus")).toBe("agent-command")
  })

  it("resolves to a section the settings navigation actually renders", () => {
    const known = new Set(SETTINGS_NAV.map((item) => item.id))
    for (const item of SETTINGS_NAV) {
      const section = new URL(settingsHref(item.id), "https://x.test").searchParams.get("section")
      expect(known.has(section as (typeof SETTINGS_NAV)[number]["id"])).toBe(true)
    }
  })
})
