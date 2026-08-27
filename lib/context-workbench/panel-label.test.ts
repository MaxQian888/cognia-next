import {
  resolvePluginWorkbenchLabel,
  resolveWorkbenchPanelLabel,
  type WorkbenchLabelTranslator,
} from "./panel-label"

/** A translator that knows exactly the keys it is given, and throws otherwise. */
function translator(catalogue: Record<string, string>): WorkbenchLabelTranslator {
  const t = ((key: string) => {
    if (!(key in catalogue)) throw new Error(`MISSING_MESSAGE: Could not resolve \`${key}\``)
    return catalogue[key]
  }) as unknown as WorkbenchLabelTranslator
  t.has = (candidate: string) => candidate in catalogue
  return t
}

describe("resolveWorkbenchPanelLabel", () => {
  it("resolves a first-party panel straight from its host key", () => {
    const t = translator({ "contextWorkbench.panels.comments": "Comments" })
    expect(
      resolveWorkbenchPanelLabel(t, { labelKey: "contextWorkbench.panels.comments" }, "comments")
    ).toBe("Comments")
  })

  it("scopes a plugin key into the plugin's own overlay namespace", () => {
    const t = translator({ "plugin.sre-agent.panel.incidents": "事件" })
    expect(
      resolveWorkbenchPanelLabel(
        t,
        { labelKey: "panel.incidents", label: "Incidents", pluginId: "sre-agent" },
        "sre-agent:incidents"
      )
    ).toBe("事件")
  })

  it("uses the literal label when the plugin ships no overlay for this locale", () => {
    const t = translator({})
    expect(
      resolveWorkbenchPanelLabel(
        t,
        { labelKey: "panel.incidents", label: "Incidents", pluginId: "sre-agent" },
        "sre-agent:incidents"
      )
    ).toBe("Incidents")
  })

  it("never calls the translator for a plugin key the catalogue lacks", () => {
    // The bug this module exists for: `t()` on an unknown key throws
    // MISSING_MESSAGE, which took down the whole quick-switch dialog.
    const seen: string[] = []
    const t = ((key: string) => {
      seen.push(key)
      throw new Error("MISSING_MESSAGE")
    }) as unknown as WorkbenchLabelTranslator
    t.has = () => false

    expect(
      resolveWorkbenchPanelLabel(t, { labelKey: "panel.x", label: "X", pluginId: "acme" }, "acme:x")
    ).toBe("X")
    expect(seen).toEqual([])
  })

  it("falls back to the key, then to the caller's fallback", () => {
    const t = translator({})
    expect(resolveWorkbenchPanelLabel(t, { labelKey: "panel.x", pluginId: "acme" }, "acme:x")).toBe(
      "panel.x"
    )
    expect(resolveWorkbenchPanelLabel(t, { pluginId: "acme" }, "acme:x")).toBe("acme:x")
    expect(resolveWorkbenchPanelLabel(t, {}, "orphan")).toBe("orphan")
  })

  it("tolerates a translator with no has() at all", () => {
    // `useTranslations()` exposes `has` at runtime, but test doubles across the
    // repo mock it away — resolving must degrade to the literal label, not throw.
    const t = (() => {
      throw new Error("MISSING_MESSAGE")
    }) as unknown as WorkbenchLabelTranslator
    expect(
      resolveWorkbenchPanelLabel(t, { labelKey: "panel.x", label: "X", pluginId: "acme" }, "acme:x")
    ).toBe("X")
  })
})

describe("resolvePluginWorkbenchLabel", () => {
  it("skips the overlay lookup entirely for a source with no pluginId", () => {
    const t = translator({ "plugin.undefined.panel.x": "wrong" })
    expect(resolvePluginWorkbenchLabel(t, { labelKey: "panel.x", label: "X" }, "x")).toBe("X")
  })
})
