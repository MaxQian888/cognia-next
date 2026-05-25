/**
 * @jest-environment jsdom
 */

import {
  getBrowserBuiltinRegistry,
  getBrowserBuiltinRegistryEntry,
} from "./browser-builtin-registry"

describe("browser-builtin-registry", () => {
  it("exposes the eleven built-in plugin entries", () => {
    const entries = getBrowserBuiltinRegistry()
    const ids = entries.map((e) => e.manifest.id).sort()
    expect(ids).toEqual([
      "cognia-agent-team-examples",
      "cognia-backend-refactor",
      "cognia-clipboard-history",
      "cognia-clipboard-tools",
      "cognia-prompt-templates",
      "cognia-screenshot",
      "cognia-web-tools",
      "cognia-workflow-ai",
      "cognia-workspace-tools",
      "github-delivery",
      "zhihu-content-pipeline",
    ])
  })

  it("every entry carries an explicit `load` function", () => {
    const entries = getBrowserBuiltinRegistry()
    for (const entry of entries) {
      expect(typeof entry.load).toBe("function")
    }
  })

  it("no entry leaves a runtime.browser.unsupported diagnostic", () => {
    const entries = getBrowserBuiltinRegistry()
    for (const entry of entries) {
      expect(entry.compatibilityDiagnostics).toEqual([])
    }
  })

  it("getBrowserBuiltinRegistryEntry resolves by plugin id", () => {
    const entry = getBrowserBuiltinRegistryEntry("cognia-screenshot")
    expect(entry?.path).toBe("builtin://cognia-screenshot")
  })

  it("returns undefined for unknown ids", () => {
    expect(getBrowserBuiltinRegistryEntry("nope")).toBeUndefined()
  })

  it("returns a fresh diagnostic array per entry copy", () => {
    const a = getBrowserBuiltinRegistry()
    const b = getBrowserBuiltinRegistry()
    expect(a[0]?.compatibilityDiagnostics).not.toBe(b[0]?.compatibilityDiagnostics)
  })
})
