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
})
