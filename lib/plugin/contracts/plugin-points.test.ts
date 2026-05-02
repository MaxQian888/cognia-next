import fs from "node:fs"
import path from "node:path"
import {
  CANONICAL_ACTIVATION_PATTERNS,
  CANONICAL_EXTENSION_POINTS,
  CANONICAL_HOOK_POINTS,
  PLUGIN_POINT_CONTRACTS,
  getExtensionPointAliases,
  resolveActivationPattern,
  validateActivationEvent,
  validateExtensionPoint,
  validateHookPoint,
} from "./plugin-points"

describe("plugin point contracts", () => {
  it("has unique canonical extension points", () => {
    expect(new Set(CANONICAL_EXTENSION_POINTS).size).toBe(CANONICAL_EXTENSION_POINTS.length)
  })

  it("has unique canonical hook points", () => {
    expect(new Set(CANONICAL_HOOK_POINTS).size).toBe(CANONICAL_HOOK_POINTS.length)
  })

  it("has unique canonical activation patterns", () => {
    expect(new Set(CANONICAL_ACTIVATION_PATTERNS).size).toBe(CANONICAL_ACTIVATION_PATTERNS.length)
  })

  it("enforces migration metadata for deprecated contracts", () => {
    const deprecated = PLUGIN_POINT_CONTRACTS.filter((entry) => entry.status === "deprecated")
    expect(deprecated.length).toBeGreaterThan(0)
    for (const entry of deprecated) {
      expect(entry.deprecatedIn).toBeDefined()
      expect(entry.replacementId).toBeDefined()
    }
  })

  it("has no registry entries left in virtual status", () => {
    const virtualEntries = PLUGIN_POINT_CONTRACTS.filter((entry) => entry.status === "virtual")
    expect(virtualEntries).toEqual([])
  })

  it("Python SDK PluginHook enum matches canonical hook registry", () => {
    // The Python SDK is a Phase 6 deliverable for cognia-next. Until that
    // lands, skip the parity check rather than fail it — once the SDK file
    // is in place this `it()` block runs unmodified. The Cognia repo path
    // (`plugin-sdk/python/src/cognia`) is preserved as the fallback so we
    // also exercise upstream parity when this test runs in the Cognia repo.
    const candidatePaths = [
      path.join(process.cwd(), "plugin-sdk", "python", "src", "cognia_next", "types.py"),
      path.join(process.cwd(), "plugin-sdk", "python", "src", "cognia", "types.py"),
    ]
    const pyTypesPath = candidatePaths.find((p) => fs.existsSync(p))
    if (!pyTypesPath) {
      // Mark the assertion as skipped without failing the suite.

      console.warn("[plugin-points.test] Python SDK not present yet; skipping enum parity check")
      return
    }
    const source = fs.readFileSync(pyTypesPath, "utf-8")
    const marker = "class PluginHook(Enum):"
    const start = source.indexOf(marker)
    expect(start).toBeGreaterThan(-1)

    const rest = source.slice(start + marker.length)
    const hooks = new Set<string>()
    for (const line of rest.split("\n")) {
      if (!line.startsWith("    ")) {
        if (hooks.size > 0) break
        continue
      }
      const match = line.match(/=\s*"([^"]+)"/)
      if (match?.[1]) {
        hooks.add(match[1])
      }
    }

    const hostHooks = new Set<string>(CANONICAL_HOOK_POINTS)
    const missing = [...hostHooks].filter((hook) => !hooks.has(hook))
    const extra = [...hooks].filter((hook) => !hostHooks.has(hook))
    expect({ missing, extra }).toEqual({ missing: [], extra: [] })
  })

  it("maps extension aliases to canonical IDs", () => {
    const aliases = getExtensionPointAliases()
    expect(aliases["sidebar:top"]).toBe("sidebar.left.top")
    expect(aliases["chat:input"]).toBe("chat.input.actions")
  })

  it("validates known extension points", () => {
    const result = validateExtensionPoint("chat.header", {
      governanceMode: "block",
      hasPermission: () => true,
    })

    expect(result.allowed).toBe(true)
    expect(result.diagnostics).toHaveLength(0)
  })

  it("supports alias extension points with warning diagnostics", () => {
    const result = validateExtensionPoint("sidebar:top", {
      governanceMode: "warn",
      hasPermission: () => true,
    })

    expect(result.allowed).toBe(true)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "plugin.point.alias",
          canonicalId: "sidebar.left.top",
        }),
      ])
    )
  })

  it("rejects unknown extension points in block mode", () => {
    const result = validateExtensionPoint("unknown-point", { governanceMode: "block" })
    expect(result.allowed).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "plugin.point.unknown", severity: "error" }),
      ])
    )
  })

  it("validates known hooks", () => {
    const result = validateHookPoint("onAgentStep", { governanceMode: "block" })
    expect(result.allowed).toBe(true)
  })

  it("rejects unknown hooks in block mode", () => {
    const result = validateHookPoint("onMadeUpHook", { governanceMode: "block" })
    expect(result.allowed).toBe(false)
    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({ code: "plugin.point.unknown", severity: "error" })
    )
  })

  it("resolves activation patterns for dynamic events", () => {
    expect(resolveActivationPattern("onCommand:abc")).toBe("onCommand:*")
    expect(resolveActivationPattern("onTool:test")).toBe("onTool:*")
    expect(resolveActivationPattern("onLanguage:typescript")).toBe("onLanguage:*")
  })

  it("warns for deprecated activation alias", () => {
    const result = validateActivationEvent("onStartup", { governanceMode: "warn" })
    expect(result.allowed).toBe(true)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "plugin.point.deprecated" })])
    )
  })

  it("blocks retired activation events in block mode", () => {
    const result = validateActivationEvent("onLanguage:typescript", { governanceMode: "block" })
    expect(result.allowed).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "plugin.point.deprecated", severity: "error" }),
      ])
    )
  })

  it("emits deprecation diagnostic with retirement note for retired patterns", () => {
    const result = validateActivationEvent("onA2UI:surface", { governanceMode: "warn" })
    expect(result.allowed).toBe(true)
    const diag = result.diagnostics.find((d) => d.code === "plugin.point.deprecated")
    expect(diag).toBeDefined()
    expect(diag?.hint).toContain("onA2UISurfaceCreate")
  })
})
