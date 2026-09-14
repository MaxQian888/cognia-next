import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import type { PluginManifest } from "@cognia/plugin-sdk"
import definition from "./index"

describe("context-inspector plugin definition", () => {
  const manifest = definition.manifest as PluginManifest

  it("declares the webview-backed panel declaratively — no imperative registration", () => {
    expect(manifest.contextPanels).toEqual([
      expect.objectContaining({
        id: "inspector",
        kind: "webview",
        webview: "inspector",
        resourceKinds: ["session"],
        activity: "inspect",
      }),
    ])
    // Panel-only webview: no view container involved.
    expect(manifest.contextPanels?.[0]).not.toHaveProperty("entry")
  })

  it("declares the inspector webview plus the probe webview `register()` renders", () => {
    expect(manifest.webviews).toHaveLength(2)
    expect(manifest.webviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "inspector",
          titleKey: "panel.inspector",
          html: expect.stringContaining("<main>"),
        }),
        expect.objectContaining({
          id: "inspector-probe",
          titleKey: "panel.probe",
          html: expect.stringContaining("Inspector probe"),
        }),
      ])
    )
    // Neither webview mounts in a view container.
    for (const webview of manifest.webviews ?? []) {
      expect(webview).not.toHaveProperty("containerId")
    }
  })

  it("every *Key the overlay declares resolves in BOTH manifest locales", () => {
    const locales = manifest.i18n?.locales as Record<string, Record<string, string>>
    const keys = [
      ...(manifest.webviews ?? []).map((webview) => webview.titleKey),
      ...(manifest.contextPanels ?? []).map((panel) => panel.labelKey),
    ].filter((key): key is string => typeof key === "string")
    expect(keys.length).toBeGreaterThan(0)
    for (const locale of ["en", "zh-CN"]) {
      for (const key of keys) {
        expect(Object.keys(locales[locale] ?? {})).toContain(key)
      }
    }
  })

  it("its merged manifest passes validation without context-panel diagnostics", () => {
    // This is the declarative chain's front door: a regression in the
    // webview/contextPanels cross-reference shows up here before install.
    const result = validatePluginManifest(manifest, { governanceMode: "warn" })
    expect(result.diagnostics ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: expect.stringContaining("contextPanels") }),
      ])
    )
    expect(result.valid).toBe(true)
  })

  it("activates without registering anything", async () => {
    const info = jest.fn()
    const hooks = await definition.activate({ logger: { info } } as never)
    expect(info).toHaveBeenCalled()
    expect(hooks).toBeUndefined()
  })
})
