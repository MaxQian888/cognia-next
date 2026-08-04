/**
 * @jest-environment jsdom
 */

import {
  builtinManifest,
  getBrowserBuiltinRegistry,
  getBrowserBuiltinRegistryEntry,
} from "./browser-builtin-registry"
import type { PluginManifest } from "@/types/plugin"

describe("browser-builtin-registry", () => {
  it("exposes the built-in plugin entries", () => {
    const entries = getBrowserBuiltinRegistry()
    const ids = entries.map((e) => e.manifest.id).sort()
    expect(ids).toEqual([
      "cognia-agent-team-examples",
      "cognia-anthropic-skills",
      "cognia-appearance-demo",
      "cognia-backend-refactor",
      "cognia-browser-tools",
      "cognia-builtin-characters",
      "cognia-clipboard-history",
      "cognia-clipboard-tools",
      "cognia-computer-use",
      "cognia-context-inspector",
      "cognia-deep-research",
      "cognia-e2b-sandbox",
      "cognia-eval",
      "cognia-goal-insights",
      "cognia-ocr",
      "cognia-playwright-mcp",
      "cognia-prompt-templates",
      "cognia-sandboxed-tools",
      "cognia-scheduler-tools",
      "cognia-scheduling-demo",
      "cognia-screenshot",
      "cognia-share-watch",
      "cognia-skill-recorder",
      "cognia-stagehand-mcp",
      "cognia-web-clone",
      "cognia-web-tools",
      "cognia-work-mode",
      "cognia-workflow-ai",
      "cognia-workspace-tools",
      "pet-daily-quests",
      "ripgrep-tools",
      "sre-agent",
      "strix-security",
      "zhihu-content-pipeline",
    ])
  })

  it("every entry carries an explicit `load` function", () => {
    const entries = getBrowserBuiltinRegistry()
    for (const entry of entries) {
      expect(typeof entry.load).toBe("function")
    }
  })

  it("load() resolves a plugin definition for every entry", async () => {
    for (const entry of getBrowserBuiltinRegistry()) {
      const def = await entry.load!()
      expect(typeof def.activate === "function" || typeof def.manifest === "object").toBe(true)
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

  it("hides the reference plugin outside the E2E runtime", () => {
    expect(getBrowserBuiltinRegistryEntry("ui-surface-reference")).toBeUndefined()
    expect(getBrowserBuiltinRegistry().map((entry) => entry.manifest.id)).not.toContain(
      "ui-surface-reference"
    )
  })

  it("bundles the reference plugin and stylesheet in the E2E runtime", () => {
    const env = jest.replaceProperty(process, "env", {
      ...process.env,
      NEXT_PUBLIC_E2E: "1",
    })
    try {
      expect(getBrowserBuiltinRegistryEntry("ui-surface-reference")?.bundledStyles).toContain(
        ".ref-badge"
      )
      expect(getBrowserBuiltinRegistry().map((entry) => entry.manifest.id)).toContain(
        "ui-surface-reference"
      )
    } finally {
      env.restore()
    }
  })

  it("isolates the surface harness from unrelated builtin schema contributions", () => {
    const env = jest.replaceProperty(process, "env", {
      ...process.env,
      NEXT_PUBLIC_E2E: "1",
    })
    window.history.replaceState({}, "", "/e2e/plugin-ui-surfaces")
    try {
      expect(getBrowserBuiltinRegistry().map((entry) => entry.manifest.id)).toEqual([
        "ui-surface-reference",
      ])
    } finally {
      window.history.replaceState({}, "", "/")
      env.restore()
    }
  })

  it("returns undefined for unknown ids", () => {
    expect(getBrowserBuiltinRegistryEntry("nope")).toBeUndefined()
  })

  it("returns a fresh diagnostic array per entry copy", () => {
    const a = getBrowserBuiltinRegistry()
    const b = getBrowserBuiltinRegistry()
    expect(a[0]?.compatibilityDiagnostics).not.toBe(b[0]?.compatibilityDiagnostics)
  })

  describe("builtinManifest", () => {
    const base = {
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      description: "from plugin.json",
      type: "frontend",
      capabilities: ["tools"],
      main: "src/index.ts",
      activationEvents: ["onStartup"],
    }

    it("overlays the module manifest's contribution arrays on the plugin.json base", () => {
      const mod = {
        default: {
          manifest: {
            id: "demo",
            name: "Demo",
            version: "1.0.0",
            type: "frontend",
            capabilities: ["tools", "workflow-template"],
            main: "src/index.ts",
            workflowTemplates: [{ id: "t1" }],
            dexie: { tables: [{ name: "rows", schema: "&id" }] },
          },
          activate: async () => undefined,
        },
      }
      const merged = builtinManifest(base, mod) as PluginManifest & {
        workflowTemplates?: unknown[]
      }
      // Module manifest arrays ride along…
      expect(merged.workflowTemplates).toEqual([{ id: "t1" }])
      expect(merged.dexie).toBeDefined()
      expect(merged.capabilities).toEqual(["tools", "workflow-template"])
      // …while plugin.json-only identity fields survive.
      expect(merged.description).toBe("from plugin.json")
      expect(merged.activationEvents).toEqual(["onStartup"])
      expect(merged.id).toBe("demo")
    })

    it("keeps the plugin.json id authoritative over a drifted module id", () => {
      const mod = { default: { manifest: { ...base, id: "drifted" }, activate: async () => {} } }
      expect(builtinManifest(base, mod).id).toBe("demo")
    })

    it("falls back to the plugin.json manifest for activate-only modules", () => {
      const mod = { default: { activate: async () => undefined } }
      expect(builtinManifest(base, mod)).toBe(base)
    })

    it("hydrates the zhihu-content-pipeline entry with its declarative contributions", () => {
      const manifest = getBrowserBuiltinRegistryEntry("zhihu-content-pipeline")
        ?.manifest as PluginManifest & { workflowTemplates?: unknown[]; skills?: unknown[] }
      expect(manifest.workflowTemplates?.length).toBe(1)
      expect(manifest.skills?.length).toBeGreaterThan(0)
      expect(manifest.dexie).toBeDefined()
      expect(manifest.description).toBeTruthy()
    })

    it("discovers the SRE Agent with materialized tools and subagent", () => {
      const manifest = getBrowserBuiltinRegistryEntry("sre-agent")?.manifest
      expect(manifest?.tools?.map((tool) => tool.name)).toEqual([
        "sre_query_logs",
        "sre_query_trace",
        "sre_query_metrics",
        "sre_validate_timeline",
      ])
      expect(manifest?.subagents?.[0]?.id).toBe("incident-diagnostician")
    })
  })
})
