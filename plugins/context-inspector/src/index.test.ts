import { validatePluginManifest } from "@/lib/plugin/core/validation"
import type { PluginManifest } from "@/types/plugin"
import definition from "./index"

describe("context-inspector plugin definition", () => {
  const manifest = definition.manifest as PluginManifest

  it("declares the webview-backed panel declaratively — no imperative registration", () => {
    expect(manifest.contextPanels).toEqual([
      expect.objectContaining({
        id: "inspector",
        webview: "inspector",
        resourceKinds: ["session"],
        activity: "inspect",
      }),
    ])
    expect(manifest.webviews).toEqual([
      expect.objectContaining({ id: "inspector", html: expect.stringContaining("<main>") }),
    ])
    // Panel-only webview: no view container involved.
    expect(manifest.webviews?.[0]).not.toHaveProperty("containerId")
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
