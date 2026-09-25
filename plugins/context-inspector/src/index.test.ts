import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import type { PluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import definition, { currentInspectorStrings } from "./index"
import { INSPECTOR_STRING_KEYS } from "./inspector-html"

const LOCALES = manifestJson.i18n.locales as Record<string, Record<string, string>>

function activateWith(locale: "en" | "zh-CN") {
  const disposers: Array<() => void> = []
  const info = jest.fn()
  const ctx = {
    logger: { info },
    i18n: { t: (key: string) => LOCALES[locale][key] ?? key },
    lifecycle: { onDispose: (dispose: () => void) => disposers.push(dispose) },
  }
  return {
    ctx,
    info,
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

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
        }),
        expect.objectContaining({
          id: "inspector-probe",
          titleKey: "panel.probe",
        }),
      ])
    )
    for (const webview of manifest.webviews ?? []) {
      expect(webview.html).toContain("<main>")
    }
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

  it("is opt-in and labelled as a developer tool", () => {
    // No activation events: it never auto-enables (and never lazily activates
    // on a session workbench) for users who did not ask for it.
    expect(manifest.activationEvents).toBeUndefined()
    expect(manifest.name).toMatch(/Developer/)
    expect(LOCALES.en["panel.inspector"]).toMatch(/Developer/)
    expect(LOCALES["zh-CN"]["panel.inspector"]).toMatch(/开发者/)
  })

  it("ships every frame string in both locales", () => {
    for (const locale of ["en", "zh-CN"]) {
      for (const key of INSPECTOR_STRING_KEYS) {
        expect(LOCALES[locale][`frame.${key}`]).toEqual(expect.any(String))
      }
    }
    expect(Object.keys(LOCALES["zh-CN"]).sort()).toEqual(Object.keys(LOCALES.en).sort())
  })

  it("activates without registering anything and bakes the user's language into the frames", async () => {
    // Before activation (discovery / validation) the frames read English.
    expect(currentInspectorStrings().title).toBe(LOCALES.en["frame.title"])
    const { ctx, info, dispose } = activateWith("zh-CN")
    const hooks = await definition.activate(ctx as never)
    expect(info).toHaveBeenCalled()
    expect(hooks).toBeUndefined()
    // The webview bridge reads `html` after activate() returns.
    const inspector = manifest.webviews?.find((webview) => webview.id === "inspector")
    expect(inspector?.html).toContain(LOCALES["zh-CN"]["frame.title"])
    expect(inspector?.html).toContain(LOCALES["zh-CN"]["frame.gateNote"])
    const probe = manifest.webviews?.find((webview) => webview.id === "inspector-probe")
    expect(probe?.html).toContain(LOCALES["zh-CN"]["frame.probeTitle"])
    // Disposing the activation falls back to English.
    dispose()
    expect(inspector?.html).toContain(LOCALES.en["frame.title"])
    expect(inspector?.html).not.toContain(LOCALES["zh-CN"]["frame.title"])
  })
})
