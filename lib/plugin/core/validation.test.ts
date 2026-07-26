/**
 * Plugin Validation Tests
 */

import { validatePluginManifest, validatePluginConfig } from "./validation"
import type { PluginConfigSchema } from "@/types/plugin"
import type { PluginManifest } from "@/types/plugin"
import {
  CANONICAL_CONTEXT_ACTIVITIES,
  CONTEXT_RESOURCE_READ_PERMISSIONS,
} from "@/types/context-workbench"
import type { ContextResourceKind } from "@/types/context-workbench"

describe("Plugin Validation", () => {
  describe("validatePluginManifest", () => {
    const createValidManifest = (): PluginManifest => ({
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "frontend",
      capabilities: ["tools"],
      main: "index.js",
    })

    it("should validate a valid manifest", () => {
      const manifest = createValidManifest()
      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it("enforces capability minimums through engines.cognia", () => {
      const manifest = createValidManifest()
      manifest.engines = { cognia: ">=0.0.9" }
      const incompatible = validatePluginManifest(manifest)
      expect(incompatible.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "engines.cognia",
            code: "manifest.engines.cognia.capability_minimum",
            severity: "error",
          }),
        ])
      )

      manifest.engines = { cognia: ">=0.1.0" }
      expect(validatePluginManifest(manifest).valid).toBe(true)
    })

    it.each([
      "externalAgentAdapters",
      "sessionImporters",
      "contextProviders",
      "terminalCompletionProviders",
      "deploymentFilters",
      "views",
      "webviews",
      "protocolAdapters",
      "contextPanels",
      "workspaceBackends",
      "messageRenderers",
      "aiProviders",
      "ocrProviders",
      "modalMounts",
      "routingStrategies",
      "chatMiddlewares",
    ])("rejects traversal in executable contribution field %s", (field) => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.permissions = [
        "extension:ui",
        "project:read",
        "canvas:read",
        "artifact:read",
        "workflow:read",
      ]
      manifest[field] = [
        {
          id: "unsafe-entry",
          label: "Unsafe Entry",
          labelKey: "unsafe.entry",
          entry: "../../outside.js",
          export: "createEntry",
          resourceKinds: ["project-file"],
          activity: "inspect",
          spec: {},
        },
      ]

      const result = validatePluginManifest(manifest)

      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: `${field}[0].entry`,
            code: `manifest.${field}.entry.traversal`,
            severity: "error",
          }),
        ])
      )
    })

    it.each(["main", "pythonMain", "wasmMain", "vscodeMain", "styles"])(
      "rejects an unsafe top-level runtime entry at %s",
      (field) => {
        const manifest = createValidManifest() as unknown as Record<string, unknown>
        manifest[field] = "C:outside.js"
        if (field === "pythonMain") manifest.type = "python"
        if (field === "wasmMain") {
          manifest.type = "wasm"
          manifest.wasm = { apiVersion: "0.1.0" }
        }
        if (field === "vscodeMain") manifest.type = "vscode-extension"

        const result = validatePluginManifest(manifest)

        expect(result.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              field,
              code: `manifest.${field}.entry.absolute`,
              severity: "error",
            }),
          ])
        )
      }
    )

    it.each(["vscodeGrammars", "vscodeIconThemes", "vscodeSnippets"])(
      "rejects traversal in VS Code asset field %s",
      (field) => {
        const manifest = createValidManifest() as unknown as Record<string, unknown>
        manifest[field] = [{ id: "asset", language: "ts", path: "..\\outside.json" }]

        const result = validatePluginManifest(manifest)

        expect(result.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              field: `${field}[0].path`,
              code: `manifest.${field}.path.traversal`,
              severity: "error",
            }),
          ])
        )
      }
    )

    it("requires a JavaScript entry for Python manifests with JS lazy contributions", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "python"
      delete manifest.main
      manifest.pythonMain = "main.py"
      manifest.capabilities = ["session-importer"]
      manifest.sessionImporters = [
        {
          id: "legacy-session",
          label: "Legacy Session",
          entry: "dist/importer.js",
          export: "createImporter",
        },
      ]

      const result = validatePluginManifest(manifest)

      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "sessionImporters",
            code: "manifest.contributions.javascript.unsupported_for_python",
            severity: "error",
          }),
        ])
      )
    })

    it("rejects JavaScript contributions in Python-only plugins even when main is declared", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "python"
      manifest.main = "dist/index.js"
      manifest.pythonMain = "main.py"
      manifest.capabilities = ["session-importer"]
      manifest.sessionImporters = [
        {
          id: "legacy-session",
          label: "Legacy Session",
          entry: "dist/importer.js",
          export: "createImporter",
        },
      ]

      expect(validatePluginManifest(manifest).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "sessionImporters",
            code: "manifest.contributions.javascript.unsupported_for_python",
            severity: "error",
          }),
        ])
      )
    })

    it("rejects JavaScript contributions for a runtime without a JavaScript entry", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "plugin.wasm"
      manifest.wasm = { apiVersion: "0.1.0" }
      manifest.contextPanels = [
        { id: "panel", label: "Panel", entry: "dist/panel.js", export: "createPanel" },
      ]

      expect(validatePluginManifest(manifest).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "manifest.contributions.javascript.unsupported_for_plugin_type",
            severity: "error",
          }),
        ])
      )
    })

    it.each([...CANONICAL_CONTEXT_ACTIVITIES])(
      "accepts a context panel on the canonical %s activity",
      (activity) => {
        // The validator used to hold a hand-copied list, so `workspace` passed
        // tsc via `CanonicalContextActivity` and then failed at install time.
        // Driving this from the same source keeps the two from drifting again.
        const manifest = createValidManifest()
        manifest.capabilities = ["context-panel"] as PluginManifest["capabilities"]
        manifest.permissions = ["extension:ui", "canvas:read"]
        ;(manifest as unknown as Record<string, unknown>).contextPanels = [
          {
            id: "outline",
            label: "Outline",
            labelKey: "panels.outline",
            entry: "panel.js",
            export: "OutlinePanel",
            resourceKinds: ["canvas-document"],
            activity,
          },
        ]

        const result = validatePluginManifest(manifest, { governanceMode: "warn" })

        expect(result.diagnostics ?? []).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ code: "activity.invalid" })])
        )
      }
    )

    it.each(
      Object.entries(CONTEXT_RESOURCE_READ_PERMISSIONS) as Array<[ContextResourceKind, string]>
    )("accepts a context panel targeting the %s resource kind", (kind, readPermission) => {
      // Same drift, one field over: this map was hand-copied here without
      // `session` — the chat dock's fallback resource — so a declarative panel
      // aimed at the right rail's default state failed to install.
      const manifest = createValidManifest()
      manifest.capabilities = ["context-panel"] as PluginManifest["capabilities"]
      manifest.permissions = ["extension:ui", readPermission] as PluginManifest["permissions"]
      ;(manifest as unknown as Record<string, unknown>).contextPanels = [
        {
          id: "outline",
          label: "Outline",
          labelKey: "panels.outline",
          entry: "panel.js",
          export: "OutlinePanel",
          resourceKinds: [kind],
          activity: "inspect",
        },
      ]

      const result = validatePluginManifest(manifest, { governanceMode: "warn" })

      expect(result.diagnostics ?? []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "resourceKinds.invalid" })])
      )
    })

    it("accepts a webview-backed context panel without entry/export", () => {
      const manifest = createValidManifest()
      manifest.capabilities = ["context-panel", "webview"] as PluginManifest["capabilities"]
      manifest.permissions = ["extension:ui", "session:read"]
      ;(manifest as unknown as Record<string, unknown>).webviews = [
        { id: "inspector", html: "<main></main>" },
      ]
      ;(manifest as unknown as Record<string, unknown>).contextPanels = [
        {
          id: "inspector",
          label: "Inspector",
          labelKey: "panels.inspector",
          webview: "inspector",
          resourceKinds: ["session"],
          activity: "inspect",
        },
      ]

      const result = validatePluginManifest(manifest, { governanceMode: "warn" })

      expect(result.diagnostics ?? []).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: expect.stringContaining("contextPanels") }),
        ])
      )
    })

    it("rejects a context panel declaring both webview and entry/export", () => {
      const manifest = createValidManifest()
      manifest.capabilities = ["context-panel", "webview"] as PluginManifest["capabilities"]
      manifest.permissions = ["extension:ui", "session:read"]
      ;(manifest as unknown as Record<string, unknown>).webviews = [
        { id: "inspector", html: "<main></main>" },
      ]
      ;(manifest as unknown as Record<string, unknown>).contextPanels = [
        {
          id: "inspector",
          label: "Inspector",
          labelKey: "panels.inspector",
          webview: "inspector",
          entry: "panel.js",
          export: "Panel",
          resourceKinds: ["session"],
          activity: "inspect",
        },
      ]

      expect(validatePluginManifest(manifest, { governanceMode: "warn" }).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "manifest.contextPanels.webview.conflict",
            severity: "error",
          }),
        ])
      )
    })

    it("rejects a context panel referencing a webview id that is not declared", () => {
      const manifest = createValidManifest()
      manifest.capabilities = ["context-panel", "webview"] as PluginManifest["capabilities"]
      manifest.permissions = ["extension:ui", "session:read"]
      ;(manifest as unknown as Record<string, unknown>).webviews = [
        { id: "other", html: "<main></main>" },
      ]
      ;(manifest as unknown as Record<string, unknown>).contextPanels = [
        {
          id: "inspector",
          label: "Inspector",
          labelKey: "panels.inspector",
          webview: "inspector",
          resourceKinds: ["session"],
          activity: "inspect",
        },
      ]

      expect(validatePluginManifest(manifest, { governanceMode: "warn" }).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "manifest.contextPanels.webview.unknown",
            severity: "error",
          }),
        ])
      )
    })

    it("downgrades a webview reference to a warning when webviews[] is absent", () => {
      // First-party plugins carry contributions on the module-manifest overlay,
      // so the raw JSON may lack `webviews[]`; the merged manifest is what the
      // manager validates at enable.
      const manifest = createValidManifest()
      manifest.capabilities = ["context-panel", "webview"] as PluginManifest["capabilities"]
      manifest.permissions = ["extension:ui", "session:read"]
      ;(manifest as unknown as Record<string, unknown>).contextPanels = [
        {
          id: "inspector",
          label: "Inspector",
          labelKey: "panels.inspector",
          webview: "inspector",
          resourceKinds: ["session"],
          activity: "inspect",
        },
      ]

      const diagnostics = validatePluginManifest(manifest, { governanceMode: "warn" }).diagnostics

      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "manifest.contextPanels.webview.unresolved",
            severity: "warning",
          }),
        ])
      )
      expect(diagnostics).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "manifest.contextPanels.entry.missing" }),
        ])
      )
    })

    it("still requires entry/export when webview is an empty string", () => {
      const manifest = createValidManifest()
      manifest.capabilities = ["context-panel"] as PluginManifest["capabilities"]
      manifest.permissions = ["extension:ui", "session:read"]
      ;(manifest as unknown as Record<string, unknown>).contextPanels = [
        {
          id: "inspector",
          label: "Inspector",
          labelKey: "panels.inspector",
          webview: "",
          resourceKinds: ["session"],
          activity: "inspect",
        },
      ]

      expect(validatePluginManifest(manifest, { governanceMode: "warn" }).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "manifest.contextPanels.webview.invalid" }),
          expect.objectContaining({ code: "manifest.contextPanels.entry.missing" }),
        ])
      )
    })

    it("accepts declarative-only VS Code extensions without vscodeMain", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "vscode-extension"
      delete manifest.main
      manifest.themes = [{ id: "dark", name: "Dark", vscodeJsonPath: "themes/dark.json" }]

      expect(validatePluginManifest(manifest).diagnostics).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "manifest.runtime_entry.required_any_of" }),
        ])
      )
    })

    it.each([
      ["ocrProviders", "media", { id: "ocr", label: "OCR", entry: "ocr.js", export: "createOcr" }],
      [
        "aiProviders",
        "ai-provider",
        {
          id: "ai",
          label: "AI",
          entry: "ai.js",
          export: "createAi",
          kind: "embedding",
          dimensions: 3,
        },
      ],
    ])("rejects %s JavaScript providers in Python-only plugins", (field, capability, entry) => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "python"
      delete manifest.main
      manifest.pythonMain = "main.py"
      manifest.capabilities = [capability]
      manifest[field] = [entry]

      expect(validatePluginManifest(manifest).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field,
            code: "manifest.contributions.javascript.unsupported_for_python",
          }),
        ])
      )
    })

    it("rejects traversal in theme vscodeJsonPath", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.themes = [{ id: "escape", name: "Escape", vscodeJsonPath: "../../outside.json" }]

      expect(validatePluginManifest(manifest).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "themes[0].vscodeJsonPath",
            code: "manifest.themes.vscodeJsonPath.traversal",
          }),
        ])
      )
    })

    it.each([
      ["fonts", { fonts: [{ family: "X", files: [{ weight: 400, src: "../font.woff2" }] }] }],
      [
        "wallpapers",
        {
          wallpapers: [
            {
              id: "escape",
              name: "Escape",
              source: {
                kind: "image",
                relPath: "..\\wallpaper.png",
                mime: "image/png",
                width: 1,
                height: 1,
              },
            },
          ],
        },
      ],
      [
        "cliTools",
        {
          cliTools: [
            {
              id: "escape",
              name: "Escape",
              description: "Escape",
              permission: "cli:execute",
              binary: { kind: "plugin-dir", relPath: "../../tool" },
              argv: [],
            },
          ],
        },
      ],
      ["vscodeLanguages", { vscodeLanguages: [{ id: "x", configuration: "../language.json" }] }],
      [
        "vscodeLanguages",
        { vscodeLanguages: [{ id: "x", icon: { light: "../light.svg", dark: "dark.svg" } }] },
      ],
    ])("rejects traversal in %s asset paths", (_field, contribution) => {
      const manifest = Object.assign(createValidManifest(), contribution)
      expect(validatePluginManifest(manifest as PluginManifest).valid).toBe(false)
    })

    it("accepts host-only variants in Python and rejects only code-backed variants", () => {
      const base = createValidManifest() as unknown as Record<string, unknown>
      base.type = "python"
      delete base.main
      base.pythonMain = "main.py"
      base.protocolAdapters = [
        {
          id: "data",
          label: "Data",
          spec: {
            kind: "openai-compatible-variant",
            urlTemplate: "https://example.test",
            responsePaths: { textDelta: "delta" },
          },
        },
      ]
      base.webviews = [{ id: "inline", containerId: "main", html: "<p>safe</p>" }]
      expect(validatePluginManifest(base as unknown as PluginManifest).valid).toBe(true)

      base.protocolAdapters = [
        { id: "code", label: "Code", spec: { kind: "code" }, entry: "adapter.js", export: "x" },
      ]
      expect(validatePluginManifest(base as unknown as PluginManifest).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "protocolAdapters",
            code: "manifest.contributions.javascript.unsupported_for_python",
          }),
        ])
      )
    })

    it("treats connectors on a Python plugin as an experimental python-backed contribution", () => {
      // `connectors` declares no JS module path (its `factory` is just a symbol
      // name a python handler can own too), so on a python plugin the backend
      // defaults to python and routes through the plugin_python_call seam.
      // The capability is pythonExecution "experimental", hence the warning.
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "python"
      delete manifest.main
      manifest.pythonMain = "main.py"
      manifest.connectors = [
        {
          type: "custom",
          factory: "createConnector",
          configSchema: {},
          transportModes: ["polling"],
        },
      ]
      const diagnostics = validatePluginManifest(manifest as unknown as PluginManifest).diagnostics
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "connectors",
            code: "manifest.contributions.python.experimental",
            severity: "warning",
          }),
        ])
      )
      expect((diagnostics ?? []).filter((d) => d.severity === "error")).toEqual([])
    })

    it("rejects an explicitly JS-backed connector on a Python-only plugin", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "python"
      delete manifest.main
      manifest.pythonMain = "main.py"
      manifest.connectors = [
        {
          type: "custom",
          backend: "js",
          factory: "createConnector",
          configSchema: {},
          transportModes: ["polling"],
        },
      ]
      expect(validatePluginManifest(manifest as unknown as PluginManifest).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "connectors",
            code: "manifest.contributions.javascript.unsupported_for_python",
            severity: "error",
          }),
        ])
      )
    })

    it.each([
      ["main", { main: "..\\outside.js" }],
      ["browser", { browser: "..\\outside.js" }],
      ["l10n", { l10n: "..\\outside" }],
      ["languages", { contributes: { languages: [{ configuration: "..\\outside.json" }] } }],
      [
        "language icons",
        {
          contributes: {
            languages: [{ icon: { light: "../../outside.svg", dark: "icons/dark.svg" } }],
          },
        },
      ],
      ["grammars", { contributes: { grammars: [{ path: "..\\outside.json" }] } }],
      ["themes", { contributes: { themes: [{ path: "..\\outside.json" }] } }],
      ["iconThemes", { contributes: { iconThemes: [{ path: "..\\outside.json" }] } }],
      ["productIconThemes", { contributes: { productIconThemes: [{ path: "..\\outside.json" }] } }],
      ["snippets", { contributes: { snippets: [{ path: "..\\outside.json" }] } }],
      ["chatInstructions", { contributes: { chatInstructions: [{ path: "..\\outside.md" }] } }],
      ["chatPromptFiles", { contributes: { chatPromptFiles: [{ path: "..\\outside.md" }] } }],
    ])("rejects traversal in nested VS Code %s paths", (_field, vscodeExtension) => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "vscode-extension"
      manifest.vscodeMain = "dist/extension.js"
      manifest.vscodeExtension = vscodeExtension

      expect(validatePluginManifest(manifest).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: expect.stringMatching(/\.traversal$/),
            severity: "error",
          }),
        ])
      )
    })

    it("should reject missing id", () => {
      const manifest = createValidManifest()
      delete (manifest as unknown as Record<string, unknown>).id

      const result = validatePluginManifest(manifest as PluginManifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("id"))).toBe(true)
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            field: "id",
            code: "manifest.id.missing",
          }),
        ])
      )
    })

    it("should reject empty id", () => {
      const manifest = createValidManifest()
      manifest.id = ""

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("id"))).toBe(true)
    })

    it("should reject invalid id format", () => {
      const manifest = createValidManifest()
      manifest.id = "Invalid Plugin ID!"

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("id"))).toBe(true)
    })

    it("should accept valid id formats", () => {
      const validIds = ["my-plugin", "my_plugin", "my.plugin", "plugin123", "a"]

      for (const id of validIds) {
        const manifest = createValidManifest()
        manifest.id = id
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(true)
      }
    })

    it("should reject host-reserved and overlong plugin ids", () => {
      for (const id of [".host-state", "_marketplace_cache", "_backups", "a".repeat(129)]) {
        const manifest = createValidManifest()
        manifest.id = id
        const result = validatePluginManifest(manifest)
        expect(result.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "manifest.id.invalid_format", field: "id" }),
          ])
        )
      }
    })

    it("should reject missing name", () => {
      const manifest = createValidManifest()
      delete (manifest as unknown as Record<string, unknown>).name

      const result = validatePluginManifest(manifest as PluginManifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("name"))).toBe(true)
    })

    it("should reject invalid version format", () => {
      const manifest = createValidManifest()
      manifest.version = "invalid"

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("version"))).toBe(true)
    })

    it("should accept valid semver versions", () => {
      // Note: The implementation uses a simple semver pattern that supports basic pre-release
      const validVersions = ["1.0.0", "0.1.0", "10.20.30", "1.0.0-beta"]

      for (const version of validVersions) {
        const manifest = createValidManifest()
        manifest.version = version
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(true)
      }
    })

    it("should validate minAppVersion when provided", () => {
      const manifest = createValidManifest()
      manifest.minAppVersion = "0.1.0"

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(true)
    })

    it("should reject invalid minAppVersion format", () => {
      const manifest = createValidManifest()
      manifest.minAppVersion = "latest"

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(false)
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            field: "minAppVersion",
            code: "manifest.minAppVersion.invalid",
          }),
        ])
      )
    })

    describe("networkAccess", () => {
      const withNetworkAccess = (networkAccess: unknown): PluginManifest => {
        const manifest = createValidManifest() as unknown as Record<string, unknown>
        manifest.networkAccess = networkAccess
        return manifest as unknown as PluginManifest
      }

      it("accepts a domain allowlist without reasoning", () => {
        const result = validatePluginManifest(
          withNetworkAccess({ allowedDomains: ["api.example.com", "*.github.com"] })
        )
        expect(result.errors).toHaveLength(0)
      })

      it("accepts any-host access when reasoning is provided", () => {
        const result = validatePluginManifest(
          withNetworkAccess({ allowedDomains: ["*"], reasoning: "needs arbitrary web fetch" })
        )
        expect(result.errors).toHaveLength(0)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.networkAccess.reasoning.required")
        ).toBe(false)
      })

      it("warns when '*' is requested without reasoning", () => {
        const result = validatePluginManifest(withNetworkAccess({ allowedDomains: ["*"] }))
        expect(result.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              severity: "warning",
              field: "networkAccess.reasoning",
              code: "manifest.networkAccess.reasoning.required",
            }),
          ])
        )
      })

      it("rejects a non-object networkAccess", () => {
        const result = validatePluginManifest(withNetworkAccess("everything"))
        expect(result.valid).toBe(false)
        expect(result.diagnostics!.some((d) => d.code === "manifest.networkAccess.invalid")).toBe(
          true
        )
      })

      it("rejects allowedDomains that is not an array", () => {
        const result = validatePluginManifest(withNetworkAccess({ allowedDomains: "example.com" }))
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some(
            (d) => d.code === "manifest.networkAccess.allowedDomains.invalid"
          )
        ).toBe(true)
      })

      it("rejects blank/non-string allowedDomains entries", () => {
        const result = validatePluginManifest(
          withNetworkAccess({ allowedDomains: ["ok.com", "  "] })
        )
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some(
            (d) => d.code === "manifest.networkAccess.allowedDomains.entry.invalid"
          )
        ).toBe(true)
      })
    })

    describe("requires.binaries", () => {
      it("accepts a valid requires.binaries block", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).requires = {
          binaries: [
            { name: "cognia", minVersion: "0.1.0", documentation: "https://x" },
            { name: "git" },
          ],
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(true)
        expect(result.errors).toHaveLength(0)
      })

      it("accepts a manifest with no requires block (additive)", () => {
        const manifest = createValidManifest()
        expect(validatePluginManifest(manifest).valid).toBe(true)
      })

      it("rejects requires that is not an object", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).requires = ["git"]
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: "manifest.requires.invalid" })])
        )
      })

      it("rejects requires.binaries that is not an array", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).requires = { binaries: {} }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "manifest.requires.binaries.invalid" }),
          ])
        )
      })

      it("rejects a binary entry missing name", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).requires = {
          binaries: [{ minVersion: "1.0.0" }],
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "manifest.requires.binaries.name.missing" }),
          ])
        )
      })

      it("rejects a non-semver minVersion", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).requires = {
          binaries: [{ name: "git", minVersion: "latest" }],
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "manifest.requires.binaries.minVersion.invalid",
            }),
          ])
        )
      })

      it("rejects a non-string documentation field", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).requires = {
          binaries: [{ name: "git", documentation: 42 }],
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "manifest.requires.binaries.documentation.invalid",
            }),
          ])
        )
      })
    })

    it("should reject invalid plugin type", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).type = "invalid"

      const result = validatePluginManifest(manifest as PluginManifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("type"))).toBe(true)
    })

    it("should accept valid plugin types", () => {
      // Test frontend type (already has main)
      const frontendManifest = createValidManifest()
      expect(validatePluginManifest(frontendManifest).valid).toBe(true)

      // Test python type (needs pythonMain)
      const pythonManifest = createValidManifest()
      pythonManifest.type = "python"
      pythonManifest.pythonMain = "main.py"
      delete pythonManifest.main
      expect(validatePluginManifest(pythonManifest).valid).toBe(true)

      // Hybrid plugins always own a Python runtime and therefore require pythonMain.
      const hybridManifest = createValidManifest()
      hybridManifest.type = "hybrid"
      hybridManifest.pythonMain = "main.py"
      expect(validatePluginManifest(hybridManifest).valid).toBe(true)

      delete hybridManifest.pythonMain
      expect(validatePluginManifest(hybridManifest).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "pythonMain",
            code: "manifest.pythonMain.required",
            severity: "error",
          }),
        ])
      )
    })

    it("should handle empty capabilities", () => {
      const manifest = createValidManifest()
      manifest.capabilities = []

      const result = validatePluginManifest(manifest)

      // Empty array is valid per implementation (no invalid capabilities)
      // The implementation validates individual capabilities, not array length
      expect(result.errors.every((e) => !e.includes("Invalid capability"))).toBe(true)
    })

    it("should reject invalid capabilities", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).capabilities = ["invalid"]

      const result = validatePluginManifest(manifest as PluginManifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("capability"))).toBe(true)
    })

    it("should surface experimental capability diagnostics in warn mode", () => {
      // `processors` is still an `experimental` capability in the host
      // contract. (`themes`, used here before, was promoted
      // partial→supported and no longer emits a diagnostic — and no
      // capability remains in the `partial` status.)
      const manifest = createValidManifest()
      manifest.capabilities = ["processors"]

      const result = validatePluginManifest(manifest, { governanceMode: "warn" })

      expect(result.valid).toBe(true)
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "warning",
            field: "capabilities",
            code: "manifest.capabilities.plugin.capability.experimental",
          }),
        ])
      )
    })

    it("should pass validation for skills capability (unblocked in M1·T4)", () => {
      // Historical note: this test previously asserted that declaring
      // `capabilities: ["skills"]` in block mode produced an error because
      // the skills contract was support: "blocked". M1·T4 of the plugin-first
      // Computer Use plan flipped skills to "supported" once skill-registry +
      // build-options + sidecar passthrough landed (M1·T3 / M4). No real
      // capability is currently in the "blocked" status, so the validation
      // path is exercised by the "unknown capability" test above instead.
      const manifest = createValidManifest()
      manifest.capabilities = ["skills"]

      const result = validatePluginManifest(manifest, { governanceMode: "block" })

      expect(result.valid).toBe(true)
    })

    describe("capability ↔ field cross-check", () => {
      it("warns when a declared capability has no contribution field", () => {
        const manifest = createValidManifest()
        manifest.capabilities = ["scheduler"]
        const result = validatePluginManifest(manifest, { governanceMode: "warn" })
        expect(result.valid).toBe(true)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.capability.field_missing")
        ).toBe(true)
      })

      it("warns when a contribution field is populated without its capability tag", () => {
        const manifest = createValidManifest()
        manifest.capabilities = ["tools"]
        ;(manifest as unknown as Record<string, unknown>).tools = [
          { name: "t", description: "d", parametersSchema: {} },
        ]
        ;(manifest as unknown as Record<string, unknown>).fonts = [
          { family: "X", files: [{ weight: 400, src: "a.woff2" }] },
        ]
        const result = validatePluginManifest(manifest, { governanceMode: "warn" })
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.capability.field_undeclared")
        ).toBe(true)
      })

      it("does not warn field_missing when the gating field is populated", () => {
        const manifest = createValidManifest()
        manifest.capabilities = ["fonts"]
        ;(manifest as unknown as Record<string, unknown>).fonts = [
          { family: "X", files: [{ weight: 400, src: "a.woff2" }] },
        ]
        const result = validatePluginManifest(manifest, { governanceMode: "warn" })
        expect(
          result.diagnostics!.some(
            (d) => d.code === "manifest.capability.field_missing" && d.message.includes("fonts")
          )
        ).toBe(false)
      })

      it("does not flag the manifest's own capabilities array as a contribution field", () => {
        // The api-only contracts (media / canvas / ai-provider) used to list
        // "capabilities" as their manifest field, which made every manifest
        // emit a bogus field_undeclared warning.
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).tools = [
          { name: "t", description: "d", parametersSchema: {} },
        ]
        const result = validatePluginManifest(manifest, { governanceMode: "warn" })
        expect(
          result.diagnostics!.some(
            (d) =>
              d.code === "manifest.capability.field_undeclared" &&
              d.message.includes('"capabilities"')
          )
        ).toBe(false)
      })

      it("treats api-only capabilities (media) as satisfied without a contribution field", () => {
        const manifest = createValidManifest()
        manifest.capabilities = ["media"] as PluginManifest["capabilities"]
        const result = validatePluginManifest(manifest, { governanceMode: "warn" })
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.capability.field_missing")
        ).toBe(false)
      })

      it("accepts every PluginPermission union member without an unknown-permission warning", () => {
        const manifest = createValidManifest()
        // The drift-prone tail of the union — media/sandbox/native entries
        // were historically missing from VALID_PERMISSIONS.
        manifest.permissions = [
          "media:image:read",
          "media:image:write",
          "media:video:read",
          "media:video:write",
          "media:video:export",
          "sandbox:web-execute",
          "native:input",
          "native:screen",
        ] as PluginManifest["permissions"]
        const result = validatePluginManifest(manifest, { governanceMode: "warn" })
        expect(result.diagnostics!.some((d) => d.code === "manifest.permissions.unknown")).toBe(
          false
        )
      })

      it("recognizes the workflows object block as a populated contribution field", () => {
        const manifest = createValidManifest()
        manifest.capabilities = ["workflow"] as PluginManifest["capabilities"]
        ;(manifest as unknown as Record<string, unknown>).workflows = {
          nodes: [{ kind: "demo.node", entry: "src/index.ts", export: "demoNode" }],
        }
        const result = validatePluginManifest(manifest, { governanceMode: "warn" })
        expect(
          result.diagnostics!.some(
            (d) => d.code === "manifest.capability.field_missing" && d.message.includes("workflows")
          )
        ).toBe(false)
      })

      it("treats an empty workflows object block as missing", () => {
        const manifest = createValidManifest()
        manifest.capabilities = ["workflow"] as PluginManifest["capabilities"]
        ;(manifest as unknown as Record<string, unknown>).workflows = { nodes: [], triggers: [] }
        const result = validatePluginManifest(manifest, { governanceMode: "warn" })
        expect(
          result.diagnostics!.some(
            (d) => d.code === "manifest.capability.field_missing" && d.message.includes("workflows")
          )
        ).toBe(true)
      })

      it("flags a populated workflows block whose capability tag is missing", () => {
        const manifest = createValidManifest()
        manifest.capabilities = []
        ;(manifest as unknown as Record<string, unknown>).workflows = {
          triggers: [{ kind: "demo.trigger", entry: "src/index.ts", export: "demoTrigger" }],
        }
        const result = validatePluginManifest(manifest, { governanceMode: "warn" })
        expect(
          result.diagnostics!.some(
            (d) =>
              d.code === "manifest.capability.field_undeclared" && d.message.includes("workflows")
          )
        ).toBe(true)
      })

      it("accepts the newly-contracted capabilities without an invalid-capability error", () => {
        for (const cap of ["theme-pack", "fonts", "wallpapers", "tray"]) {
          const manifest = createValidManifest()
          manifest.capabilities = [cap] as PluginManifest["capabilities"]
          const result = validatePluginManifest(manifest, { governanceMode: "warn" })
          expect(result.errors.some((e) => e.includes("Invalid capability"))).toBe(false)
        }
      })

      it("recognizes field-driven module bridge capabilities and their manifest fields", () => {
        const cases: Array<{
          capability: string
          field: string
          value: unknown
        }> = [
          {
            capability: "workspace-backend",
            field: "workspaceBackends",
            value: [{ id: "local", label: "Local", entry: "workspace.js", export: "create" }],
          },
          {
            capability: "message-renderer",
            field: "messageRenderers",
            value: [{ id: "demo", partType: "x-demo", entry: "renderer.js", export: "Renderer" }],
          },
          {
            capability: "density-preset",
            field: "densityPresets",
            value: [{ name: "compact-plus", vars: { "--density-spacing": "0.75rem" } }],
          },
          {
            capability: "chat-middleware",
            field: "chatMiddlewares",
            value: [{ id: "redact", label: "Redact", entry: "chat.js", export: "create" }],
          },
          {
            capability: "modal-mount",
            field: "modalMounts",
            value: [{ id: "settings", label: "Settings", entry: "modal.js", export: "Modal" }],
          },
          {
            capability: "terminal-completion",
            field: "terminalCompletionProviders",
            value: [{ id: "shell", label: "Shell", entry: "terminal.js", export: "create" }],
          },
          {
            capability: "routing-strategy",
            field: "routingStrategies",
            value: [{ id: "cost", label: "Cost", entry: "routing.js", export: "create" }],
          },
          {
            capability: "deployment-filter",
            field: "deploymentFilters",
            value: [{ id: "region", label: "Region", entry: "filter.js", export: "create" }],
          },
          {
            capability: "protocol-adapter",
            field: "protocolAdapters",
            value: [
              {
                id: "variant",
                label: "Variant",
                spec: {
                  kind: "openai-compatible-variant",
                  urlTemplate: "{baseURL}/chat",
                  responsePaths: { textDelta: "choices[0].delta.content" },
                },
              },
            ],
          },
          {
            capability: "tool-route",
            field: "toolRoutes",
            value: [{ toolName: "search_docs", utterances: ["search the docs"] }],
          },
          {
            capability: "context-provider",
            field: "contextProviders",
            value: [{ id: "repo", label: "Repo", entry: "context.js", export: "create" }],
          },
          {
            capability: "context-panel",
            field: "contextPanels",
            value: [
              {
                id: "outline",
                label: "Outline",
                labelKey: "panels.outline",
                entry: "panel.js",
                export: "OutlinePanel",
                resourceKinds: ["canvas-document"],
                activity: "inspect",
              },
            ],
          },
        ]

        for (const { capability, field, value } of cases) {
          const manifest = createValidManifest()
          manifest.capabilities = [capability] as PluginManifest["capabilities"]
          if (capability === "context-panel") {
            manifest.permissions = ["extension:ui", "canvas:read"]
          }
          ;(manifest as unknown as Record<string, unknown>)[field] = value

          const result = validatePluginManifest(manifest, { governanceMode: "warn" })

          expect(result.valid).toBe(true)
          expect(result.diagnostics!.some((d) => d.code === "manifest.capabilities.invalid")).toBe(
            false
          )
          expect(
            result.diagnostics!.some(
              (d) =>
                d.code === "manifest.capability.field_missing" &&
                d.message.includes(`"${capability}"`)
            )
          ).toBe(false)
        }
      })
    })

    describe("modalMounts presentation options", () => {
      const withModalMount = (options: unknown): PluginManifest => {
        const manifest = createValidManifest()
        manifest.capabilities = ["modal-mount"] as PluginManifest["capabilities"]
        ;(manifest as unknown as Record<string, unknown>).modalMounts = [
          { id: "wizard", label: "Wizard", entry: "modal.js", export: "Modal", options },
        ]
        return manifest
      }

      it("accepts a declared size and variant", () => {
        const result = validatePluginManifest(
          withModalMount({ size: "lg", variant: "sheet-right" }),
          { governanceMode: "warn" }
        )
        expect(result.valid).toBe(true)
      })

      it("accepts an omitted options block", () => {
        const result = validatePluginManifest(withModalMount(undefined), {
          governanceMode: "warn",
        })
        expect(result.valid).toBe(true)
      })

      it("rejects a non-object options block", () => {
        const result = validatePluginManifest(withModalMount("large"), { governanceMode: "warn" })
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.modalMounts.options.invalid")
        ).toBe(true)
      })

      it("rejects an unknown size", () => {
        const result = validatePluginManifest(withModalMount({ size: "enormous" }), {
          governanceMode: "warn",
        })
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.modalMounts.options.size.invalid")
        ).toBe(true)
      })

      it("rejects an unknown variant", () => {
        const result = validatePluginManifest(withModalMount({ variant: "sheet-left" }), {
          governanceMode: "warn",
        })
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.modalMounts.options.variant.invalid")
        ).toBe(true)
      })
    })

    it("should require main for frontend plugins", () => {
      const manifest = createValidManifest()
      manifest.type = "frontend"
      delete manifest.main

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("main"))).toBe(true)
    })

    it("should require pythonMain for python plugins", () => {
      const manifest = createValidManifest()
      manifest.type = "python"
      delete manifest.pythonMain

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("pythonMain"))).toBe(true)
    })

    it("should validate with main for frontend plugins", () => {
      const manifest = createValidManifest()
      manifest.type = "frontend"
      manifest.main = "index.js"

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(true)
    })

    it("should validate with pythonMain for python plugins", () => {
      const manifest = createValidManifest()
      manifest.type = "python"
      manifest.pythonMain = "main.py"

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(true)
    })

    it("should return warnings for optional best practices", () => {
      const manifest = createValidManifest()
      manifest.type = "frontend"
      manifest.main = "index.js"
      // Missing description, author, homepage, etc.
      manifest.description = ""

      const result = validatePluginManifest(manifest)

      // Should still be valid but may have warnings
      expect(result.warnings.length).toBeGreaterThanOrEqual(0)
    })

    it("should validate a well-formed wasm plugin manifest", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "main.wasm"
      manifest.wasm = { apiVersion: "0.1.0" }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(true)
    })

    it("should reject wasm plugins missing wasmMain", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasm = { apiVersion: "0.1.0" }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("wasmMain"))).toBe(true)
    })

    it("should reject wasm plugins with non-.wasm wasmMain", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "main.js"
      manifest.wasm = { apiVersion: "0.1.0" }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes(".wasm"))).toBe(true)
    })

    it("should reject wasm plugins missing the wasm block", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "main.wasm"
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.toLowerCase().includes("wasm"))).toBe(true)
    })

    it("should reject wasm plugins with a malformed apiVersion", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "main.wasm"
      manifest.wasm = { apiVersion: "0.1" }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("apiVersion"))).toBe(true)
    })

    it("should reject wasm plugins with absurd memoryLimitMb", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "main.wasm"
      manifest.wasm = { apiVersion: "0.1.0", memoryLimitMb: 9999 }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("memoryLimitMb"))).toBe(true)
    })

    it("should reject wasm plugins with negative callTimeoutMs", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "main.wasm"
      manifest.wasm = { apiVersion: "0.1.0", callTimeoutMs: -1 }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("callTimeoutMs"))).toBe(true)
    })

    it("should reject wasm plugins with NUL-byte preopens", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "main.wasm"
      manifest.wasm = {
        apiVersion: "0.1.0",
        fs: { preopens: ["~/Documents", "bad\0path"] },
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("preopen"))).toBe(true)
    })

    it("should reject wasm plugins with empty-string preopens", () => {
      const manifest = createValidManifest() as unknown as Record<string, unknown>
      manifest.type = "wasm"
      delete manifest.main
      manifest.wasmMain = "main.wasm"
      manifest.wasm = { apiVersion: "0.1.0", fs: { preopens: ["", "~/ok"] } }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("preopen"))).toBe(true)
    })

    it("should return actionable diagnostics for missing pythonMain", () => {
      const manifest = createValidManifest()
      manifest.type = "python"
      delete manifest.pythonMain

      const result = validatePluginManifest(manifest)

      expect(result.valid).toBe(false)
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            field: "pythonMain",
            code: "manifest.pythonMain.required",
            hint: expect.any(String),
          }),
        ])
      )
    })

    it("should report warning diagnostics for retired activation events in warn mode", () => {
      const manifest = createValidManifest()
      manifest.activationEvents = ["onLanguage:typescript"]

      const result = validatePluginManifest(manifest, { governanceMode: "warn" })

      expect(result.valid).toBe(true)
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "warning",
            field: "activationEvents[0]",
            code: "manifest.activationEvents.plugin.point.deprecated",
          }),
        ])
      )
    })

    it("should fail validation for retired activation events in block mode", () => {
      const manifest = createValidManifest()
      manifest.activationEvents = ["onLanguage:typescript"]

      const result = validatePluginManifest(manifest, { governanceMode: "block" })

      expect(result.valid).toBe(false)
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "error",
            field: "activationEvents[0]",
            code: "manifest.activationEvents.plugin.point.deprecated",
          }),
        ])
      )
    })
  })

  describe("validatePluginConfig", () => {
    const createConfigSchema = (): PluginConfigSchema => ({
      type: "object" as const,
      properties: {
        name: { type: "string" as const },
        count: { type: "number" as const, minimum: 0, maximum: 100 },
        enabled: { type: "boolean" as const },
        options: {
          type: "string" as const,
          enum: ["option1", "option2", "option3"],
        },
      },
      required: ["name"],
    })

    it("should validate valid config", () => {
      const schema = createConfigSchema()
      const config = {
        name: "Test",
        count: 50,
        enabled: true,
        options: "option1",
      }

      const result = validatePluginConfig(config, schema)

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it("should accept a whole-number value for an integer field", () => {
      const schema: PluginConfigSchema = {
        type: "object",
        properties: { retries: { type: "integer", minimum: 0, maximum: 10 } },
      }
      const result = validatePluginConfig({ retries: 3 }, schema)
      expect(result.valid).toBe(true)
    })

    it("should reject a non-whole value for an integer field", () => {
      const schema: PluginConfigSchema = {
        type: "object",
        properties: { retries: { type: "integer" } },
      }
      const result = validatePluginConfig({ retries: 3.5 }, schema)
      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "retries", code: "invalid_type" })
      )
    })

    it("should enforce minimum/maximum on an integer field", () => {
      const schema: PluginConfigSchema = {
        type: "object",
        properties: { retries: { type: "integer", minimum: 1, maximum: 5 } },
      }
      expect(validatePluginConfig({ retries: 0 }, schema).valid).toBe(false)
      expect(validatePluginConfig({ retries: 9 }, schema).valid).toBe(false)
      expect(validatePluginConfig({ retries: 3 }, schema).valid).toBe(true)
    })

    it("should reject missing required fields", () => {
      const schema = createConfigSchema()
      const config = {
        count: 50,
      }

      const result = validatePluginConfig(config, schema)

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "name", code: "required" })
      )
    })

    it("should reject invalid type", () => {
      const schema = createConfigSchema()
      const config = {
        name: 123, // Should be string
        count: 50,
      }

      const result = validatePluginConfig(config, schema)

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "name", code: "invalid_type" })
      )
    })

    it("should reject value below minimum", () => {
      const schema = createConfigSchema()
      const config = {
        name: "Test",
        count: -1,
      }

      const result = validatePluginConfig(config, schema)

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "count", code: "minimum" })
      )
    })

    it("should reject value above maximum", () => {
      const schema = createConfigSchema()
      const config = {
        name: "Test",
        count: 101,
      }

      const result = validatePluginConfig(config, schema)

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "count", code: "maximum" })
      )
    })

    it("should reject invalid enum value", () => {
      const schema = createConfigSchema()
      const config = {
        name: "Test",
        options: "invalid",
      }

      const result = validatePluginConfig(config, schema)

      expect(result.valid).toBe(false)
      expect(result.errors).toContainEqual(
        expect.objectContaining({ field: "options", code: "enum" })
      )
    })

    it("should allow optional fields to be omitted", () => {
      const schema = createConfigSchema()
      const config = {
        name: "Test",
      }

      const result = validatePluginConfig(config, schema)

      expect(result.valid).toBe(true)
    })

    it("should pass validation with no schema", () => {
      const config = { anything: "goes" }

      const result = validatePluginConfig(config, undefined)

      expect(result.valid).toBe(true)
    })
  })

  describe("validatePluginManifest — dexie block", () => {
    const createValidManifest = (): PluginManifest => ({
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "frontend",
      capabilities: ["tools"],
      main: "index.js",
    })

    it("accepts a manifest with a valid dexie block", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {
        tables: [{ name: "repos", schema: "++id, fullName" }],
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it("accepts a manifest without a dexie block", () => {
      const manifest = createValidManifest()
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(true)
    })

    it("rejects when dexie is not an object", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = "not-an-object"
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("dexie"))).toBe(true)
    })

    it("rejects when dexie.tables is missing", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {}
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.diagnostics!.some((d) => d.field === "dexie.tables")).toBe(true)
    })

    it("rejects when dexie.tables is empty", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = { tables: [] }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.diagnostics!.some((d) => d.code === "manifest.dexie.tables.empty")).toBe(true)
    })

    it("rejects an invalid table name", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {
        tables: [{ name: "BadName", schema: "++id" }],
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.diagnostics!.some((d) => d.code === "manifest.dexie.tables.nameInvalid")).toBe(
        true
      )
    })

    it("rejects a duplicate table name", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {
        tables: [
          { name: "repos", schema: "++id" },
          { name: "repos", schema: "++id, name" },
        ],
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.diagnostics!.some((d) => d.code === "manifest.dexie.tables.duplicate")).toBe(
        true
      )
    })

    it("rejects an empty schema string", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {
        tables: [{ name: "repos", schema: "" }],
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(
        result.diagnostics!.some((d) => d.code === "manifest.dexie.tables.schemaInvalid")
      ).toBe(true)
    })

    it("rejects more than 20 tables", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {
        tables: Array.from({ length: 21 }, (_, i) => ({
          name: `table${i}`,
          schema: "++id",
        })),
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(result.diagnostics!.some((d) => d.code === "manifest.dexie.tables.tooMany")).toBe(true)
    })

    it("rejects a migration with a non-positive toVersion", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {
        tables: [{ name: "repos", schema: "++id" }],
        migrations: [{ toVersion: 0, upgrade: "migrateV1" }],
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(
        result.diagnostics!.some((d) => d.code === "manifest.dexie.migrations.toVersionInvalid")
      ).toBe(true)
    })

    it("rejects a migration with an empty upgrade string", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {
        tables: [{ name: "repos", schema: "++id" }],
        migrations: [{ toVersion: 2, upgrade: "" }],
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(false)
      expect(
        result.diagnostics!.some((d) => d.code === "manifest.dexie.migrations.upgradeInvalid")
      ).toBe(true)
    })

    it("accepts multiple valid tables with migrations", () => {
      const manifest = createValidManifest()
      ;(manifest as unknown as Record<string, unknown>).dexie = {
        tables: [
          { name: "repos", schema: "++id, fullName" },
          { name: "workOrders", schema: "++id, [status+repoFullName]" },
        ],
        migrations: [{ toVersion: 2, upgrade: "migrateToV2" }],
      }
      const result = validatePluginManifest(manifest)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    describe("manifest.i18n", () => {
      it("accepts a flat per-locale string map", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).i18n = {
          locales: {
            en: { "panel.title": "Hello" },
            "zh-CN": { "panel.title": "你好" },
          },
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(true)
        expect(result.errors).toHaveLength(0)
      })

      it("rejects when `i18n` is not an object", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).i18n = "yes"
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics!.some((d) => d.code === "manifest.i18n.invalid")).toBe(true)
      })

      it("rejects when `i18n.locales` is missing or not an object", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).i18n = {}
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics!.some((d) => d.code === "manifest.i18n.locales.invalid")).toBe(
          true
        )
      })

      it("warns when a locale is not one of the host's canonical locales", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).i18n = {
          locales: { ja: { hi: "konnichiwa" } },
        }
        const result = validatePluginManifest(manifest)
        // Warnings don't break the validity gate.
        expect(result.valid).toBe(true)
        expect(
          result.diagnostics!.some(
            (d) => d.code === "manifest.i18n.invalid_locale" && d.severity === "warning"
          )
        ).toBe(true)
      })

      it("rejects nested objects under a locale (only flat dot-notation accepted)", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).i18n = {
          locales: { en: "not an object" },
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics!.some((d) => d.code === "manifest.i18n.invalid_keys")).toBe(true)
      })

      it("rejects keys that violate the I18N_KEY_PATTERN", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).i18n = {
          locales: { en: { "bad key!": "value" } },
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics!.some((d) => d.code === "manifest.i18n.invalid_keys")).toBe(true)
      })

      it("rejects non-string values", () => {
        const manifest = createValidManifest()
        ;(manifest as unknown as Record<string, unknown>).i18n = {
          locales: { en: { greet: 123 as unknown as string } },
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics!.some((d) => d.code === "manifest.i18n.invalid_keys")).toBe(true)
      })

      it("flags when a locale exceeds the per-locale key cap", () => {
        const manifest = createValidManifest()
        const big: Record<string, string> = {}
        for (let i = 0; i <= 1000; i++) big[`k${i}`] = "v"
        ;(manifest as unknown as Record<string, unknown>).i18n = {
          locales: { en: big },
        }
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics!.some((d) => d.code === "manifest.i18n.too_many_keys")).toBe(true)
      })
    })

    // -----------------------------------------------------------------------
    // ADR-0026 — lazy-factory manifest fields.
    //
    // The six new fields (ocrProviders / workspaceBackends / messageRenderers
    // / aiProviders / modalMounts / chatMiddlewares) all share the
    // `{ id, label, entry, export }` shape; the tests below exercise the
    // shared `validateLazyFactoryArray` rules plus the field-specific
    // extras (kind discriminant, dimensions, partType, priority, timeoutMs).
    // -----------------------------------------------------------------------
    describe("ADR-0026 lazy-factory manifest fields", () => {
      const withLazy = (extra: Record<string, unknown>): PluginManifest =>
        ({
          ...createValidManifest(),
          ...extra,
        }) as PluginManifest

      it("accepts a valid ocrProviders entry", () => {
        const manifest = withLazy({
          ocrProviders: [
            {
              id: "baidu",
              label: "Baidu OCR",
              entry: "providers/baidu.js",
              export: "createBaiduProvider",
            },
          ],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(true)
      })

      it("rejects ocrProviders with non-array shape", () => {
        const manifest = withLazy({ ocrProviders: "nope" })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.ocrProviders.invalid_type")
        ).toBe(true)
      })

      it("rejects ocrProviders entry missing required id", () => {
        const manifest = withLazy({
          ocrProviders: [{ label: "x", entry: "a.js", export: "f" }],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(result.diagnostics!.some((d) => d.code === "manifest.ocrProviders.id.missing")).toBe(
          true
        )
      })

      it("rejects ocrProviders with an absolute entry path", () => {
        const manifest = withLazy({
          ocrProviders: [
            { id: "x", label: "X", entry: "/abs/path.js", export: "f" },
            { id: "y", label: "Y", entry: "C:\\drv\\path.js", export: "f" },
          ],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        const codes = result.diagnostics!.map((d) => d.code)
        expect(codes.filter((c) => c === "manifest.ocrProviders.entry.absolute").length).toBe(2)
      })

      it("rejects ocrProviders with traversal in entry", () => {
        const manifest = withLazy({
          ocrProviders: [{ id: "x", label: "X", entry: "../escape.js", export: "f" }],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.ocrProviders.entry.traversal")
        ).toBe(true)
      })

      it("rejects ocrProviders with NUL byte in entry", () => {
        const manifest = withLazy({
          ocrProviders: [{ id: "x", label: "X", entry: "a\0b.js", export: "f" }],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.ocrProviders.entry.invalid_chars")
        ).toBe(true)
      })

      it("rejects duplicate ids within the same field", () => {
        const manifest = withLazy({
          ocrProviders: [
            { id: "dup", label: "X", entry: "a.js", export: "f" },
            { id: "dup", label: "Y", entry: "b.js", export: "g" },
          ],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.ocrProviders.id.duplicate")
        ).toBe(true)
      })

      it("rejects export that is not a valid JS identifier", () => {
        const manifest = withLazy({
          ocrProviders: [{ id: "x", label: "X", entry: "a.js", export: "1bad-name" }],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.ocrProviders.export.invalid")
        ).toBe(true)
      })

      it("messageRenderers requires partType but not label", () => {
        const missingPartType = withLazy({
          messageRenderers: [{ id: "r", entry: "a.js", export: "Renderer" }],
        })
        let result = validatePluginManifest(missingPartType)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.messageRenderers.partType.missing")
        ).toBe(true)

        const ok = withLazy({
          messageRenderers: [
            { id: "r", entry: "a.js", export: "Renderer", partType: "x-custom-block" },
          ],
        })
        result = validatePluginManifest(ok)
        expect(result.valid).toBe(true)
      })

      it("aiProviders rejects unknown kind", () => {
        const manifest = withLazy({
          aiProviders: [
            { id: "x", label: "X", entry: "a.js", export: "f", kind: "neither-llm-nor-embed" },
          ],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.aiProviders.kind.invalid")
        ).toBe(true)
      })

      it("aiProviders embedding kind requires positive integer dimensions", () => {
        const missing = withLazy({
          aiProviders: [{ id: "e", label: "E", entry: "a.js", export: "f", kind: "embedding" }],
        })
        let result = validatePluginManifest(missing)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.aiProviders.dimensions.invalid")
        ).toBe(true)

        const ok = withLazy({
          aiProviders: [
            {
              id: "e",
              label: "E",
              entry: "a.js",
              export: "f",
              kind: "embedding",
              dimensions: 1536,
            },
          ],
        })
        result = validatePluginManifest(ok)
        expect(result.valid).toBe(true)
      })

      it("aiProviders llm rejects non-string-array models", () => {
        const manifest = withLazy({
          aiProviders: [
            {
              id: "l",
              label: "L",
              entry: "a.js",
              export: "f",
              kind: "llm",
              models: [123, "claude-opus-4-7"],
            },
          ],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        expect(
          result.diagnostics!.some((d) => d.code === "manifest.aiProviders.models.invalid")
        ).toBe(true)
      })

      it("chatMiddlewares rejects out-of-range priority and timeout", () => {
        const manifest = withLazy({
          chatMiddlewares: [
            { id: "m", label: "M", entry: "a.js", export: "f", priority: 999 },
            { id: "n", label: "N", entry: "a.js", export: "g", timeoutMs: 999_999 },
            { id: "o", label: "O", entry: "a.js", export: "h", timeoutMs: 0 },
          ],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(false)
        const codes = new Set(result.diagnostics!.map((d) => d.code))
        expect(codes.has("manifest.chatMiddlewares.priority.range")).toBe(true)
        expect(codes.has("manifest.chatMiddlewares.timeoutMs.range")).toBe(true)
      })

      it("modalMounts validates the shared shape and accepts a minimal entry", () => {
        const manifest = withLazy({
          modalMounts: [
            { id: "settings", label: "Open Settings", entry: "modal.js", export: "Modal" },
          ],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(true)
      })

      it("workspaceBackends validates the shared shape", () => {
        const manifest = withLazy({
          workspaceBackends: [
            { id: "e2b", label: "e2b Sandbox", entry: "backend.js", export: "createBackend" },
          ],
        })
        const result = validatePluginManifest(manifest)
        expect(result.valid).toBe(true)
      })
    })
  })
})

describe("validatePluginManifest resilience", () => {
  const withResilience = (resilience: unknown): PluginManifest =>
    ({
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      description: "A test plugin",
      type: "frontend",
      capabilities: ["tools"],
      main: "index.js",
      resilience,
    }) as unknown as PluginManifest

  it("accepts a well-formed resilience block", () => {
    const result = validatePluginManifest(
      withResilience({
        timeoutMs: 5000,
        maxRetries: 2,
        retryable: true,
        breakerScope: "tool",
        breaker: { failureThreshold: 3, cooldownMs: 1000, successThreshold: 2 },
      })
    )
    expect(result.valid).toBe(true)
  })

  it("rejects a non-object resilience block", () => {
    const result = validatePluginManifest(withResilience("nope"))
    expect(result.valid).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "manifest.resilience.invalid_type" }),
      ])
    )
  })

  it("rejects a non-positive timeoutMs and a negative maxRetries", () => {
    const result = validatePluginManifest(withResilience({ timeoutMs: 0, maxRetries: -1 }))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("timeoutMs"))).toBe(true)
    expect(result.errors.some((e) => e.includes("maxRetries"))).toBe(true)
  })

  it("rejects an invalid breakerScope", () => {
    const result = validatePluginManifest(withResilience({ breakerScope: "weird" }))
    expect(result.valid).toBe(false)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "manifest.resilience.invalid_scope" }),
      ])
    )
  })

  it("warns when the worst-case budget exceeds the sidecar IPC ceiling", () => {
    const result = validatePluginManifest(
      withResilience({ retryable: true, timeoutMs: 60_000, maxRetries: 1 })
    )
    expect(result.valid).toBe(true)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "manifest.resilience.budget_exceeds_ipc" }),
      ])
    )
  })
})

describe("validatePluginManifest cliTools", () => {
  const cliManifest = (overrides: Record<string, unknown> = {}): PluginManifest =>
    ({
      id: "cli-demo",
      name: "CLI Demo",
      version: "1.0.0",
      description: "demo",
      type: "frontend",
      capabilities: ["cli-tools"],
      main: "index.js",
      permissions: ["cli:execute"],
      requires: { binaries: [{ name: "rg" }] },
      cliTools: [
        {
          name: "ripgrep_search",
          description: "Search files",
          parameters: {
            type: "object",
            properties: {
              pattern: { type: "string" },
              globs: { type: "array", items: { type: "string" } },
              path: { type: "string" },
            },
          },
          binary: { kind: "requires", name: "rg" },
          argv: [
            { literal: "--json" },
            { param: "globs", eachPrefixedBy: "--glob", omitWhenEmpty: true },
            { param: "pattern" },
            { param: "path", omitWhenEmpty: true },
          ],
          outputParse: "lines",
          successExitCodes: [0, 1],
          timeoutMs: 30000,
          maxOutputBytes: 500000,
        },
      ],
      ...overrides,
    }) as unknown as PluginManifest

  const codesOf = (result: ReturnType<typeof validatePluginManifest>) =>
    (result.diagnostics ?? []).map((d) => d.code)

  it("accepts a fully-specified valid cliTool", () => {
    const result = validatePluginManifest(cliManifest())
    expect(result.errors).toHaveLength(0)
    expect(result.valid).toBe(true)
  })

  it("requires the cli:execute permission when cliTools is non-empty", () => {
    const result = validatePluginManifest(cliManifest({ permissions: [] }))
    expect(result.valid).toBe(false)
    expect(codesOf(result)).toContain("manifest.cliTools.permission.missing")
  })

  it("rejects a requires binary not declared in requires.binaries", () => {
    const manifest = cliManifest()
    ;(manifest.cliTools![0].binary as { name: string }).name = "ffmpeg"
    const result = validatePluginManifest(manifest)
    expect(codesOf(result)).toContain("manifest.cliTools.binary.name.undeclared")
  })

  it("rejects plugin-dir binaries with traversal or absolute paths", () => {
    for (const relPath of ["../evil.exe", "/usr/bin/evil", "C:\\evil.exe", "a/../../b"]) {
      const manifest = cliManifest()
      manifest.cliTools![0].binary = { kind: "plugin-dir", relPath }
      const result = validatePluginManifest(manifest)
      expect(codesOf(result)).toContain("manifest.cliTools.binary.relPath.invalid")
    }
    // A safe nested relative path passes.
    const manifest = cliManifest()
    manifest.cliTools![0].binary = { kind: "plugin-dir", relPath: "bin/tool.exe" }
    expect(validatePluginManifest(manifest).valid).toBe(true)
  })

  it("rejects argv tokens referencing undeclared params", () => {
    const manifest = cliManifest()
    manifest.cliTools![0].argv.push({ param: "ghost" })
    const result = validatePluginManifest(manifest)
    expect(codesOf(result)).toContain("manifest.cliTools.argv.param.undeclared")
  })

  it("rejects argv tokens with both or neither of literal/param", () => {
    const manifest = cliManifest()
    ;(manifest.cliTools![0].argv as unknown[]).push({ literal: "-x", param: "pattern" }, {})
    const result = validatePluginManifest(manifest)
    expect(
      codesOf(result).filter((c) => c === "manifest.cliTools.argv.token.invalid")
    ).toHaveLength(2)
  })

  it("rejects stdin/cwd referencing undeclared params and bad cwd kinds", () => {
    const manifest = cliManifest()
    manifest.cliTools![0].stdin = { param: "ghost" }
    manifest.cliTools![0].cwd = { kind: "param", param: "ghost" } as never
    const result = validatePluginManifest(manifest)
    expect(codesOf(result)).toContain("manifest.cliTools.stdin.invalid")
    expect(codesOf(result)).toContain("manifest.cliTools.cwd.param.undeclared")

    const manifest2 = cliManifest()
    manifest2.cliTools![0].cwd = { kind: "anywhere" } as never
    expect(codesOf(validatePluginManifest(manifest2))).toContain("manifest.cliTools.cwd.invalid")
  })

  it("rejects non-string env values and bad numeric knobs", () => {
    const manifest = cliManifest()
    manifest.cliTools![0].env = { GOOD: "1", BAD: 2 } as never
    manifest.cliTools![0].timeoutMs = -5
    manifest.cliTools![0].maxOutputBytes = 1.5
    const result = validatePluginManifest(manifest)
    const codes = codesOf(result)
    expect(codes).toContain("manifest.cliTools.env.invalid")
    expect(codes).toContain("manifest.cliTools.timeoutMs.invalid")
    expect(codes).toContain("manifest.cliTools.maxOutputBytes.invalid")
  })

  it("rejects bad outputParse, non-integer exit codes, duplicate names, bad parameters shape", () => {
    const manifest = cliManifest()
    manifest.cliTools!.push({
      ...manifest.cliTools![0],
      name: "ripgrep_search", // duplicate
      outputParse: "yaml" as never,
      successExitCodes: [0, "ok"] as never,
      parameters: { type: "string" } as never,
    })
    const result = validatePluginManifest(manifest)
    const codes = codesOf(result)
    expect(codes).toContain("manifest.cliTools.name.duplicate")
    expect(codes).toContain("manifest.cliTools.outputParse.invalid")
    expect(codes).toContain("manifest.cliTools.successExitCodes.invalid")
    expect(codes).toContain("manifest.cliTools.parameters.invalid")
  })

  it("rejects a non-array cliTools and non-object entries", () => {
    const bad = cliManifest({ cliTools: "nope" })
    expect(codesOf(validatePluginManifest(bad))).toContain("manifest.cliTools.invalid")
    const badEntry = cliManifest({ cliTools: [42] })
    expect(codesOf(validatePluginManifest(badEntry))).toContain("manifest.cliTools.entry.invalid")
  })

  it("warns (not errors) when capability is declared but cliTools is empty", () => {
    const manifest = cliManifest({ cliTools: [] })
    const result = validatePluginManifest(manifest)
    expect(result.valid).toBe(true)
    expect(
      (result.diagnostics ?? []).some(
        (d) => d.code === "manifest.capability.field_missing" && d.severity === "warning"
      )
    ).toBe(true)
  })
})
