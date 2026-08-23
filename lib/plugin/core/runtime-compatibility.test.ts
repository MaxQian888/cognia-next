import type { PluginManifest } from "@/types/plugin"
import { collectPluginRuntimeProfileDiagnostics } from "./runtime-compatibility"

function manifest(patch: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "demo.plugin",
    name: "Demo",
    version: "1.0.0",
    description: "Demo plugin",
    type: "frontend",
    capabilities: [],
    ...patch,
  }
}

describe("collectPluginRuntimeProfileDiagnostics", () => {
  it("accepts an explicitly supported Headless runtime", () => {
    expect(
      collectPluginRuntimeProfileDiagnostics(
        manifest({ runtimeCompatibility: { headless: { availability: "supported" } } }),
        "headless"
      )
    ).toEqual([])
  })

  it("inherits browser compatibility for frontend Headless plugins", () => {
    expect(
      collectPluginRuntimeProfileDiagnostics(
        manifest({ runtimeCompatibility: { browser: { availability: "supported" } } }),
        "headless"
      )
    ).toEqual([])
  })

  it("inherits Tauri compatibility for Node-target plugins", () => {
    expect(
      collectPluginRuntimeProfileDiagnostics(
        manifest({
          type: "hybrid",
          engines: { node: ">=20.0.0" },
          runtimeCompatibility: { tauri: { availability: "supported" } },
        }),
        "headless"
      )
    ).toEqual([])
  })

  it("reports degraded, blocked, and undeclared profiles", () => {
    expect(
      collectPluginRuntimeProfileDiagnostics(
        manifest({
          runtimeCompatibility: {
            headless: { availability: "degraded", reason: "No interactive UI" },
          },
        }),
        "headless"
      )
    ).toEqual([expect.objectContaining({ severity: "warning", code: "runtime.headless.degraded" })])
    expect(
      collectPluginRuntimeProfileDiagnostics(
        manifest({ runtimeCompatibility: { headless: { availability: "unsupported" } } }),
        "headless"
      )
    ).toEqual([
      expect.objectContaining({ severity: "error", code: "runtime.headless.unsupported" }),
    ])
    expect(collectPluginRuntimeProfileDiagnostics(manifest(), "browser")).toEqual([
      expect.objectContaining({ severity: "error", code: "runtime.browser.unsupported" }),
    ])
  })

  it("keeps the desktop profile unrestricted", () => {
    expect(collectPluginRuntimeProfileDiagnostics(manifest(), "tauri")).toEqual([])
  })
})
