/**
 * The in-tree Python reference plugin's manifest, checked against the same
 * validator the installer runs.
 *
 * This is the consumer that keeps the declarative `kind: "a2ui"` panel class
 * from being a capability nobody uses: before ADR-0145 a `type: "python"`
 * plugin declaring `contextPanels` failed validation outright, so this file
 * failing would mean the panel class regressed to "manifest line only".
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import type { PluginManifest } from "@cognia/plugin-sdk"

const manifest = JSON.parse(
  readFileSync(join(__dirname, "plugin.json"), "utf8")
) as PluginManifest & { i18n?: { locales?: Record<string, Record<string, string>> } }

describe("cognia-python-demo manifest", () => {
  it("declares a declarative A2UI panel with no JS entry anywhere", () => {
    expect(manifest.type).toBe("python")
    expect(manifest).not.toHaveProperty("main")
    expect(manifest.contextPanels).toEqual([
      expect.objectContaining({
        id: "python-demo",
        kind: "a2ui",
        surface: "cognia-python-demo:{resourceKey}",
        activateTool: "build_demo_panel",
        resourceKinds: ["session"],
      }),
    ])
    expect(manifest.contextPanels?.[0]).not.toHaveProperty("entry")
    expect(manifest.contextPanels?.[0]).not.toHaveProperty("webview")
  })

  it("passes validation without a single context-panel diagnostic", () => {
    const result = validatePluginManifest(manifest, { governanceMode: "warn" })
    const codes = (result.diagnostics ?? []).map((diagnostic) => diagnostic.code)
    expect(codes.filter((code) => code.includes("contextPanels"))).toEqual([])
    // The rule that used to make this impossible.
    expect(codes).not.toContain("manifest.contributions.javascript.unsupported_for_python")
    expect(result.valid).toBe(true)
  })

  it("declares the permissions the panel's resource kind requires", () => {
    // `resourceKinds: ["session"]` costs `session:read`, and any panel costs
    // `extension:ui`. The bridge refuses to register the panel without both,
    // and a refusal at enable time is silent unless someone looks at the
    // diagnostics store.
    expect(manifest.permissions).toEqual(expect.arrayContaining(["extension:ui", "session:read"]))
    expect(manifest.capabilities).toContain("context-panel")
  })

  it("ships the panel label in both shipped locales", () => {
    const labelKey = manifest.contextPanels?.[0]?.labelKey as string
    expect(manifest.i18n?.locales?.en?.[labelKey]).toBeTruthy()
    expect(manifest.i18n?.locales?.["zh-CN"]?.[labelKey]).toBeTruthy()
  })

  it("ships every string main.py resolves through ctx.i18n.t in both locales", () => {
    // `build_demo_panel` paints the surface title, the outline and the intro
    // from these keys (PANEL_LABELS in main.py); a key missing from zh-CN is
    // an English string in a Chinese panel.
    const en = Object.keys(manifest.i18n?.locales?.en ?? {}).sort()
    expect(en).toEqual(
      expect.arrayContaining([
        "panel.title",
        "panel.heading",
        "panel.intro",
        "panel.outline.runtime",
        "panel.outline.frames",
        "panel.outline.environments",
      ])
    )
    expect(Object.keys(manifest.i18n?.locales?.["zh-CN"] ?? {}).sort()).toEqual(en)
  })

  it("tags itself python and registers its tools by decorator", () => {
    // The `tools` capability gates the manifest's `tools[]` field; this
    // plugin's tools are `@tool` functions the host discovers at load.
    expect(manifest.capabilities).toContain("python")
    expect(manifest.capabilities).not.toContain("tools")
    expect(manifest).not.toHaveProperty("tools")
  })

  it("pairs the optional chat-interception example with its permission", () => {
    // main.py keeps `onMessageSend` as a clearly-marked optional example; the
    // host aborts the whole Python load when that hook is declared without
    // `hooks:chat-intercept`, so the two must be kept (or removed) together.
    const source = readFileSync(join(__dirname, "main.py"), "utf8")
    const declaresIntercept = source.includes('@hook("onMessageSend")')
    expect(manifest.permissions?.includes("hooks:chat-intercept") ?? false).toBe(declaresIntercept)
    if (declaresIntercept) expect(source).toContain("OPTIONAL, HIGH-RISK EXAMPLE")
  })

  it("answers only its own surfaces' actions", () => {
    // `onA2UIAction` is a broadcast; the demo namespaces its action and
    // filters on the manifest's surface prefix.
    const source = readFileSync(join(__dirname, "main.py"), "utf8")
    const prefix = (manifest.contextPanels?.[0] as { surface?: string }).surface?.split("{")[0]
    expect(prefix).toBe("cognia-python-demo:")
    expect(source).toContain(`SURFACE_PREFIX = "${prefix}"`)
    expect(source).toContain('ACTION_OPEN_SECTION = "python-demo:open-section"')
  })
})
