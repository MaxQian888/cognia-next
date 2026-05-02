import type { PluginManifest } from "@/types/plugin"
import { buildExtensionDescriptor, derivePluginInstallRootKind } from "./descriptor"

function createManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "example-plugin",
    name: "Example Plugin",
    version: "1.0.0",
    description: "Example plugin",
    type: "frontend",
    capabilities: ["tools"],
    main: "dist/index.js",
    ...overrides,
  }
}

describe("plugin descriptor normalization", () => {
  it("maps non-dev sources to the installed root by default", () => {
    expect(derivePluginInstallRootKind("local")).toBe("installed")
    expect(derivePluginInstallRootKind("git")).toBe("installed")
    expect(derivePluginInstallRootKind("marketplace")).toBe("installed")
  })

  it("maps builtin and dev sources to dedicated install roots", () => {
    expect(derivePluginInstallRootKind("builtin")).toBe("builtin")
    expect(derivePluginInstallRootKind("dev")).toBe("dev")
  })

  it("builds a dev descriptor with reload operations and warning compatibility summary", () => {
    const descriptor = buildExtensionDescriptor({
      manifest: createManifest(),
      source: "dev",
      path: "/plugins/example-plugin",
      pluginDirectory: "/plugins",
      compatibilityDiagnostics: [
        {
          code: "compat.cognia_engine_missing",
          severity: "warning",
          message: "cognia engine is missing",
          field: "engines.cognia",
        },
      ],
    })

    expect(descriptor.installRoot.kind).toBe("dev")
    expect(descriptor.source).toBe("dev")
    expect(descriptor.identity).toEqual({
      canonicalId: "example-plugin",
      observedSources: ["dev"],
      activeSource: "dev",
    })
    expect(descriptor.resolvedPath).toBe("/plugins/example-plugin")
    expect(descriptor.compatibility.status).toBe("warning")
    expect(descriptor.availableOperations).toEqual(
      expect.arrayContaining(["reload", "disable", "uninstall"])
    )
  })

  it("normalizes observed sources for canonical identity projection", () => {
    const descriptor = buildExtensionDescriptor({
      manifest: createManifest(),
      source: "marketplace",
      path: "/plugins/example-plugin",
      observedSources: ["local", "marketplace", "local"],
    })

    expect(descriptor.identity).toEqual({
      canonicalId: "example-plugin",
      observedSources: ["local", "marketplace"],
      activeSource: "marketplace",
    })
  })
})
