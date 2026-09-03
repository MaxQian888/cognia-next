/**
 * @jest-environment jsdom
 */

import {
  builtinManifest,
  getBrowserBuiltinRegistry,
  getBrowserBuiltinRegistryEntry,
} from "./browser-builtin-registry"
import { loadPluginStyles, removePluginStyles } from "@/lib/plugin/styles/plugin-stylesheet"
import type { PluginManifest } from "@/types/plugin"

describe("browser-builtin-registry", () => {
  it("exposes the built-in plugin entries", () => {
    const entries = getBrowserBuiltinRegistry()
    const ids = entries.map((e) => e.manifest.id).sort()
    expect(ids).toEqual([
      "cognia-agent-team-examples",
      "cognia-anime-effort",
      "cognia-anthropic-skills",
      "cognia-appearance-demo",
      "cognia-arknights-theme",
      "cognia-backend-refactor",
      "cognia-browser-tools",
      "cognia-builtin-characters",
      "cognia-clipboard-history",
      "cognia-clipboard-tools",
      "cognia-computer-use",
      "cognia-context-inspector",
      "cognia-deep-research",
      "cognia-documents",
      "cognia-e2b-sandbox",
      "cognia-eval",
      "cognia-goal-insights",
      "cognia-ocr",
      "cognia-office",
      "cognia-pdf",
      "cognia-playwright-mcp",
      "cognia-presentations",
      "cognia-prompt-templates",
      "cognia-sandboxed-tools",
      "cognia-scheduler-tools",
      "cognia-scheduling-demo",
      "cognia-screenshot",
      "cognia-share-watch",
      "cognia-skill-recorder",
      "cognia-stagehand-mcp",
      "cognia-visualize",
      "cognia-web-clone",
      "cognia-web-tools",
      "cognia-work-mode",
      "cognia-workflow-ai",
      "cognia-workspace-tools",
      "figma-external-service",
      "github-delivery",
      "pet-daily-quests",
      "ripgrep-tools",
      "sre-agent",
      "strix-security",
      "zhihu-content-pipeline",
    ])
  })

  it("every entry carries either a legacy loader or an external asset", () => {
    const entries = getBrowserBuiltinRegistry()
    for (const entry of entries) {
      expect(typeof entry.load === "function" || Boolean(entry.asset)).toBe(true)
    }
  })

  it("legacy load() resolves a plugin definition", async () => {
    for (const entry of getBrowserBuiltinRegistry()) {
      if (!entry.load) continue
      const def = await entry.load()
      expect(typeof def.activate === "function" || typeof def.manifest === "object").toBe(true)
    }
  })

  it("keeps migrated heavy plugins out of the static module graph", () => {
    for (const pluginId of [
      "cognia-office",
      "cognia-pdf",
      "cognia-documents",
      "cognia-presentations",
      "cognia-visualize",
    ]) {
      const entry = getBrowserBuiltinRegistryEntry(pluginId)
      expect(entry?.load).toBeUndefined()
      expect(entry?.asset).toEqual(
        expect.objectContaining({
          url: expect.stringMatching(
            new RegExp(`^/_cognia/builtin-plugins/${pluginId}/[a-f0-9]{64}\\.cjs$`)
          ),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          sharedModules: expect.any(Array),
        })
      )
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

  it("ships GitHub Delivery with its complete integration export namespace", () => {
    const entry = getBrowserBuiltinRegistryEntry("github-delivery")

    expect(entry?.manifest.runtimeCompatibility).toMatchObject({
      tauri: { availability: "supported" },
      browser: { availability: "degraded" },
      mobile: { availability: "degraded" },
      headless: { availability: "degraded" },
    })
    expect(entry?.manifest.activationEvents).toBeUndefined()
    expect(entry?.moduleExports).toEqual(
      expect.objectContaining({
        listGithubResources: expect.any(Function),
        checkGithubHealth: expect.any(Function),
        normalizeGithub: expect.any(Function),
        openPr: expect.any(Function),
        runIssueLoop: expect.any(Function),
      })
    )
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

  /**
   * Having the CSS on the entry is not having it in the document. `manifest.styles`
   * is the gate the host reads first, so this drives the real load path instead
   * of asserting the constant back to itself.
   */
  it("injects the tactical mind dial stylesheet through the host's own gate", async () => {
    const entry = getBrowserBuiltinRegistryEntry("cognia-anime-effort")
    expect(entry?.manifest.extensions).toEqual(
      expect.arrayContaining([expect.objectContaining({ point: "chat.input.actions" })])
    )

    const injected = await loadPluginStyles({
      pluginId: entry!.manifest.id,
      pluginRoot: entry!.path,
      stylesEntry: entry!.manifest.styles,
      bundledCss: entry!.bundledStyles,
    })
    expect(injected).toBe(true)

    const css = document.querySelector<HTMLStyleElement>(
      'style[data-plugin-styles="cognia-anime-effort"]'
    )?.textContent
    expect(css).toContain(".aef-panel")

    // `@keyframes` is invalid inside `@scope` and only TOP-LEVEL at-rules are
    // hoisted back out. Authored inside the reduced-motion media query it would
    // be dropped, leaving `animation: aef-pulse` pointing at nothing.
    // Compared against the at-rule itself: the hoist header is a comment that
    // also spells "@scope", and matching that would pass either way.
    expect(css!.indexOf("@keyframes aef-pulse")).toBeGreaterThanOrEqual(0)
    expect(css!.indexOf("@keyframes aef-pulse")).toBeLessThan(css!.indexOf("@scope ("))

    // Injection appends to `document.head`, which outlives the test. Left there
    // it would be picked up by anything later in this file that queries the
    // head, and a second injection of the same id would take the "already
    // present" branch instead of the append branch this test exercises.
    removePluginStyles("cognia-anime-effort")
    expect(document.querySelector('style[data-plugin-styles="cognia-anime-effort"]')).toBeNull()
  })

  /**
   * The loader falls back to `{ default: definition }` when an entry omits
   * `moduleExports`, and the extension bridge resolves components by NAME out of
   * that object. A builtin that declares `extensions[]` without publishing its
   * namespace registers nothing and fails only as a runtime diagnostic.
   */
  it("publishes the named export every builtin extension declares", () => {
    for (const entry of getBrowserBuiltinRegistry()) {
      for (const extension of entry.manifest.extensions ?? []) {
        expect({
          plugin: entry.manifest.id,
          export: extension.export,
          resolved: typeof entry.moduleExports?.[extension.export],
        }).toEqual({
          plugin: entry.manifest.id,
          export: extension.export,
          resolved: "function",
        })
      }
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
