import { evaluatePluginCompatibility, type CompatibilityRuntime } from "./compatibility"
import type { PluginManifest } from "@/types/plugin"

function createManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "example-plugin",
    name: "Example Plugin",
    version: "1.0.0",
    description: "Example",
    type: "frontend",
    capabilities: ["tools"],
    main: "index.js",
    ...overrides,
  }
}

const runtime: CompatibilityRuntime = {
  cogniaVersion: "0.1.0",
  nodeVersion: "20.0.0",
  pythonVersion: "3.11.0",
}

describe("evaluatePluginCompatibility", () => {
  it("returns compatible when engine requirements are satisfied", () => {
    const manifest = createManifest({
      engines: {
        cognia: ">=0.1.0",
        node: ">=18.0.0",
      },
    })

    const result = evaluatePluginCompatibility(manifest, runtime)
    expect(result.compatible).toBe(true)
    expect(result.diagnostics.some((entry) => entry.severity === "error")).toBe(false)
  })

  it("returns structured error diagnostics on host version mismatch", () => {
    const manifest = createManifest({
      engines: {
        cognia: ">=9.0.0",
      },
    })

    const result = evaluatePluginCompatibility(manifest, runtime)
    expect(result.compatible).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "compat.cognia_engine_mismatch",
          field: "engines.cognia",
          severity: "error",
          expected: ">=9.0.0",
          actual: "0.1.0",
        }),
      ])
    )
  })

  it("returns error when python plugin runs without python runtime info", () => {
    const manifest = createManifest({
      type: "python",
      pythonMain: "main.py",
      engines: {
        cognia: ">=0.1.0",
        python: ">=3.10.0",
      },
    })

    const result = evaluatePluginCompatibility(manifest, {
      cogniaVersion: "0.1.0",
      nodeVersion: "20.0.0",
    })
    expect(result.compatible).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "compat.python_runtime_unavailable",
          severity: "error",
        }),
      ])
    )
  })

  it("returns warning when engines.cognia is missing", () => {
    const manifest = createManifest()
    const result = evaluatePluginCompatibility(manifest, runtime)

    expect(result.compatible).toBe(true)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "compat.cognia_engine_missing",
          severity: "warning",
        }),
      ])
    )
  })

  it("returns error when host version is below minAppVersion", () => {
    const manifest = createManifest({
      engines: {
        cognia: ">=0.1.0",
      },
      minAppVersion: "0.2.0",
    })

    const result = evaluatePluginCompatibility(manifest, runtime)

    expect(result.compatible).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "compat.min_app_version_mismatch",
          field: "minAppVersion",
          severity: "error",
          expected: "0.2.0",
          actual: "0.1.0",
        }),
      ])
    )
  })

  it("returns built-in specific alignment diagnostic when engines.cognia and minAppVersion diverge", () => {
    const manifest = createManifest({
      id: "cognia-shell-tools",
      engines: {
        cognia: ">=0.2.0",
      },
      minAppVersion: "0.1.0",
    })

    const result = evaluatePluginCompatibility(manifest, runtime)

    expect(result.compatible).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "compat.builtin_version_alignment_mismatch",
          field: "minAppVersion",
          severity: "error",
          expected: ">=0.2.0",
          actual: "0.1.0",
          hint: expect.stringContaining("Built-in plugins should align"),
        }),
      ])
    )
  })
})
