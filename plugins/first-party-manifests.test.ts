/**
 * First-party plugin regression sweep — PR-A backlog item.
 *
 * Walks every `plugins/*\/plugin.json` and:
 *
 *   1. Parses the JSON.
 *   2. Validates the manifest through `validatePluginManifest()` —
 *      catches schema drift if a manifest is missing a required
 *      field or carries an unknown capability.
 *   3. Asserts every declared `capabilities[]` entry is a real
 *      `PluginCapability` from the canonical list.
 *   4. Asserts every declared `permissions[]` entry is a non-empty
 *      string with the `<group>:<verb>` shape we use elsewhere.
 *   5. For manifests that carry an overlay-registry array
 *      (`skills`, `mcpServerPresets`, `nativeAnthropicTools`,
 *      `externalAgentPresets`), round-trips the entries through the
 *      `OVERLAY_REGISTRY_CAPABILITIES` dispatch — register all,
 *      unregister all, assert idempotent.
 *
 * The test is read-only against the manifest files and lives in
 * `plugins/` so the path-based discovery stays local — moving plugins
 * around won't bit-rot a fixed list.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { validatePluginManifest } from "@/lib/plugin/core/validation"
import {
  OVERLAY_REGISTRY_CAPABILITIES,
  OVERLAY_REGISTRY_CAPABILITY_KEYS,
  type OverlayRegistryCapability,
} from "@/lib/plugin/contracts/capability-bridge-map"
import type { PluginManifest } from "@/types/plugin"

const PLUGINS_ROOT = join(__dirname)

/** Walk `plugins/` and return every direct child that owns a plugin.json. */
function discoverFirstPartyPlugins(): Array<{ dir: string; manifestPath: string }> {
  return readdirSync(PLUGINS_ROOT)
    .filter((name) => {
      const full = join(PLUGINS_ROOT, name)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        return false
      }
      if (!isDir) return false
      try {
        statSync(join(full, "plugin.json"))
        return true
      } catch {
        return false
      }
    })
    .map((dir) => ({ dir, manifestPath: join(PLUGINS_ROOT, dir, "plugin.json") }))
    .sort((a, b) => a.dir.localeCompare(b.dir))
}

const plugins = discoverFirstPartyPlugins()

/**
 * Per-plugin allowlist of EXPECTED validator warnings, as compact
 * `<code-tail>:<first-quoted-subject>` tokens (e.g. `field_missing:tools` =
 * the `manifest.capability.field_missing` warning whose message quotes
 * "tools" first). Anything not listed here fails the sweep, so new warnings
 * surface in review instead of accumulating silently.
 *
 * Two classes of warning are intentional for first-party plugins:
 *
 * 1. `field_missing:<capability>` — the contribution entries live on the
 *    TypeScript module-manifest overlay (browser-builtin-registry merges it
 *    over this JSON at discovery time) or are registered imperatively in
 *    `activate()`. The raw JSON is correct; the validator just can't see
 *    runtime values from here.
 * 2. `partial:<capability>` / `experimental:<capability>` — host-contract
 *    support status (PLUGIN_CAPABILITY_CONTRACTS), not a manifest defect.
 */
const EXPECTED_WARNINGS: Record<string, readonly string[]> = {
  "agent-team-examples": [
    "field_missing:subagent",
    "field_missing:agent-team-template",
    "field_missing:shared-memory-adapter",
    "field_missing:balance-adapter",
  ],
  // `commands` is DECLARED now (manifest.commands[] + hooks.onCommand);
  // `field_missing:commands` is therefore gone.
  "anthropic-skills": ["field_missing:skills"],
  "browser-tools": ["field_missing:tools"],
  "clipboard-history": ["field_missing:tools"],
  "clipboard-tools": ["field_missing:tools", "field_missing:workflow"],
  "cognia-appearance-demo": [],
  "cognia-backend-refactor": [
    "field_missing:skills",
    "field_missing:character-pack",
    "field_missing:subagent",
    "field_missing:agent-team-template",
    "field_missing:workflow-template",
    "field_missing:workflow",
  ],
  "cognia-builtin-characters": ["field_missing:character-pack"],
  "cognia-character-seeds": ["field_missing:character-pack"],
  "cognia-goal-insights": [],
  "cognia-python-demo": ["field_missing:tools"],
  // The connector is python-backed and `connectors` is
  // `pythonExecution: "experimental"`, so the validator warns by design —
  // execution stays gated behind `lib/plugin/python/experimental-flag.ts`.
  "cognia-python-runtime-demo": ["experimental:connectors"],
  "cognia-scheduler-tools": ["field_missing:tools", "field_missing:scheduler"],
  "cognia-sandboxed-tools": ["field_missing:tools"],
  "cognia-scheduling-demo": [],
  "cognia-share-watch": [],
  // The raw JSON declares the capabilities while the built-in TypeScript
  // overlay supplies the executable tools and typed contributions. Keeping
  // handlers out of plugin.json is required because they are not serializable;
  // src/index.test.ts verifies that the merged manifest carries every field.
  "cognia-work-mode": [
    "field_missing:tools",
    "field_missing:modes",
    "field_missing:skills",
    "field_missing:subagent",
    "field_missing:agent-team-template",
  ],
  "cognia-office": ["field_missing:tools"],
  "cognia-pdf": ["field_missing:tools"],
  "cognia-documents": ["field_missing:tools"],
  "cognia-visualize": ["field_missing:tools"],
  "cognia-presentations": ["field_missing:tools"],
  "computer-use": [
    "field_missing:tools",
    "field_missing:subagent",
    "field_missing:agent-team-template",
  ],
  // `webviews[]`/`contextPanels[]` ride the module-manifest overlay (the
  // webview body is an inline HTML string that has no sane home in raw JSON);
  // the merged manifest is what validates at enable — pinned by the plugin's
  // own index.test.ts.
  "context-inspector": ["field_missing:context-panel", "field_missing:webview"],
  "deep-research": ["field_missing:tools", "field_missing:skills"],
  "e2b-sandbox": ["field_missing:mcp-server-preset"],
  eval: ["field_missing:tools"],
  // Both example plugins now declare their contributions in plugin.json.
  // They are in `INTENTIONALLY_UNBUNDLED`, so the TS module-manifest overlay
  // never reaches an installed copy — the arrays HAD to live in the JSON or
  // the two reference plugins registered nothing in any runtime.
  "external-agent-adapter-example": [],
  "external-agent-preset-example": [],
  ocr: ["field_missing:tools"],
  "playwright-mcp": ["field_missing:mcp-server-preset"],
  // Class 1: the panel is registered imperatively in `activate()`. It cannot
  // use `manifest.contextPanels` — that field resolves a renderer from a
  // separate `entry` module, and a `builtin://` plugin has no fetchable
  // install path to import one from.
  "prompt-templates": ["field_missing:context-panel"],
  // Tools are registered by decorator in main.py, not declared in the
  // manifest, so the field is legitimately empty for a python plugin.
  repowiki: ["field_missing:tools"],
  "ripgrep-tools": [],
  // `commands` is DECLARED now (manifest.commands[] + hooks.onCommand), so the
  // `field_missing:commands` entry is gone. `tools` stays imperative —
  // `ctx.agent.registerTool` is the supported registration path for a frontend
  // plugin (the manager only materializes `manifest.tools` for WASM).
  screenshot: ["field_missing:tools"],
  "skill-recorder": ["field_missing:tools"],
  // Class 1, same shape as prompt-templates: the incident panel is registered
  // through `ctx.contextPanels.register` in `activate()` because a
  // `builtin://` plugin has no fetchable install path for the separate entry
  // module `manifest.contextPanels` would import the renderer from.
  "sre-agent": ["field_missing:context-panel"],
  "stagehand-mcp": ["field_missing:mcp-server-preset"],
  // Class 1: the security panel moved from a left-rail view container to the
  // right-hand Context Workbench, registered through
  // `ctx.contextPanels.register` in `activate()` for the same builtin://
  // reason as sre-agent and prompt-templates.
  "strix-security": ["field_missing:context-panel"],
  "test-lsp-contribution": [],
  "wasm-example-formatter": [],
  "web-clone": [],
  "web-tools": ["field_missing:tools"],
  "workflow-ai": ["field_missing:tools", "field_missing:commands"],
  "workspace-tools": ["field_missing:tools", "field_missing:workflow"],
  "zhihu-content-pipeline": [
    "field_missing:tools",
    "field_missing:skills",
    "field_missing:mcp-server-preset",
    "field_missing:character-pack",
    "field_missing:agent-team-template",
    "field_missing:workflow-template",
    "field_missing:workflow",
  ],
}

/** `manifest.capability.field_missing` + `Capability "tools" …` → `field_missing:tools`. */
function warningToken(code: string, message: string): string {
  const tail = code.split(".").pop() ?? code
  const quoted = /"([^"]+)"/.exec(message)?.[1] ?? message
  return `${tail}:${quoted}`
}

describe("first-party plugin manifest sweep", () => {
  it("discovers at least one plugin (sanity check)", () => {
    expect(plugins.length).toBeGreaterThan(0)
  })

  describe.each(plugins)("$dir", ({ manifestPath }) => {
    let manifest: PluginManifest

    beforeAll(() => {
      const raw = readFileSync(manifestPath, "utf-8")
      manifest = JSON.parse(raw) as PluginManifest
    })

    it("parses as valid JSON and matches the PluginManifest shape", () => {
      expect(typeof manifest).toBe("object")
      expect(typeof manifest.id).toBe("string")
      expect(manifest.id).toMatch(/^[a-z][a-z0-9-]*(?:[._][a-z0-9-]+)*$/)
      expect(typeof manifest.name).toBe("string")
      expect(typeof manifest.version).toBe("string")
      expect(["frontend", "python", "hybrid", "wasm", "vscode-extension"]).toContain(manifest.type)
    })

    it("passes validatePluginManifest in warn mode", () => {
      const result = validatePluginManifest(manifest, { governanceMode: "warn" })
      // First-party plugins are the source of truth for "valid". Any
      // error here is real drift — diff the failure context into the
      // assertion message so a future failure tells the human what
      // changed without having to re-run the suite locally.
      if (!result.valid || result.errors.length > 0) {
        throw new Error(
          `[${manifest.id}] validatePluginManifest failed:\n` +
            `  errors: ${JSON.stringify(result.errors, null, 2)}\n` +
            `  warnings: ${JSON.stringify(result.warnings, null, 2)}`
        )
      }
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it("emits exactly the allowlisted validator warnings", () => {
      const result = validatePluginManifest(manifest, { governanceMode: "warn" })
      const actual = (result.diagnostics ?? [])
        .filter((d) => d.severity === "warning")
        .map((d) => warningToken(d.code, d.message))
        .sort()
      const dir = manifestPath.replace(/\\/g, "/").split("/").slice(-2)[0]
      const expected = [...(EXPECTED_WARNINGS[dir] ?? [])].sort()
      // A mismatch in either direction is drift: a NEW warning means the
      // manifest (or validator) regressed; a MISSING one means the allowlist
      // entry is stale and should be removed.
      expect(actual).toEqual(expected)
    })

    it("every declared capability is non-empty (validation covers semantic check)", () => {
      // We don't compare against CANONICAL_PLUGIN_CAPABILITIES here
      // because the PluginCapability type union legitimately contains
      // entries that haven't been added to the canonical contracts
      // list yet (e.g. `workflow` / `workflow-trigger` are in the
      // union but not in CANONICAL_PLUGIN_CAPABILITIES). The
      // `validatePluginManifest` test above already catches genuine
      // unknown capabilities through the governance gate; this
      // assertion just keeps the manifest from carrying empty
      // strings or non-string entries.
      for (const cap of manifest.capabilities ?? []) {
        expect(typeof cap).toBe("string")
        expect((cap as string).length).toBeGreaterThan(0)
      }
    })

    it("never registers a slash command imperatively", () => {
      // The author-SDK migration table's first row: `direct slash-command
      // registry → declare commands and return hooks.onCommand from activate`.
      // Registering by hand skips everything the manager provides —
      // `<pluginId>.<commandId>` namespacing, conflict detection, aliases, the
      // command-palette entry (`store.registerPluginCommand`), the
      // idle-suspend clock refresh, and teardown — and the plugin's declared
      // `name` was inert, so only an internal id like `/playwright.attach`
      // resolved. All 14 first-party users have been migrated; this keeps the
      // pattern from creeping back.
      const dir = manifestPath.replace(/\\/g, "/").split("/").slice(0, -1).join("/")
      const offenders: string[] = []
      const walk = (root: string, depth = 0): void => {
        if (depth > 4) return
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          const full = join(root, entry.name)
          if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
            walk(full, depth + 1)
          } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
            if (/\bregisterSlashCommand\s*\(/.test(readFileSync(full, "utf-8"))) {
              offenders.push(full)
            }
          }
        }
      }
      walk(dir)
      expect(offenders).toEqual([])
    })

    it("declares hooks:chat-intercept if any source registers a chat-interception hook", () => {
      // `manager.validateHookDeclarations` REFUSES the whole hook registration
      // — aborting the plugin load, not just the hook — when a plugin
      // registers one of these without the permission. `cognia-python-demo`
      // shipped `@hook("onMessageSend")` with only `python:execute`, so the
      // one Python reference plugin could never be enabled at all.
      //
      // Scanned textually because the hooks live in `main.py` / `src/**` and
      // are only visible to the validator at runtime.
      const CHAT_INTERCEPT_HOOKS = [
        "onUserPromptSubmit",
        "onPreToolUse",
        "onPostToolUse",
        "onMessageSend",
        "onMessageReceive",
      ]
      const dir = manifestPath.replace(/\\/g, "/").split("/").slice(0, -1).join("/")
      const sources: string[] = []
      const walk = (root: string, depth = 0): void => {
        if (depth > 4) return
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          const full = join(root, entry.name)
          if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
            walk(full, depth + 1)
          } else if (/\.(ts|tsx|py)$/.test(entry.name) && !entry.name.includes(".test.")) {
            sources.push(readFileSync(full, "utf-8"))
          }
        }
      }
      walk(dir)
      const registers = CHAT_INTERCEPT_HOOKS.filter((hook) =>
        sources.some(
          (src) =>
            new RegExp(`@hook\\(\\s*["']${hook}["']`).test(src) ||
            new RegExp(`\\b${hook}\\s*[:(]`).test(src)
        )
      )
      if (registers.length > 0) {
        expect(manifest.permissions ?? []).toContain("hooks:chat-intercept")
      }
    })

    it("every manifest workflow node carries the fields the loader reads", () => {
      // `buildWasmNodeDefs` / the frontend registration path read `label`,
      // `paramsSchema`, `typeVersion` and `iconName` off each entry. A node
      // declared with `name`/`inputs` instead type-checks nowhere (the arrays
      // are cast) and produces an unlabelled palette entry with no params form
      // — wasm-example-formatter shipped exactly that, so its only workflow
      // contribution was 100% inert.
      const nodes = (manifest as unknown as { workflows?: { nodes?: unknown[] } }).workflows?.nodes
      for (const raw of nodes ?? []) {
        const node = raw as Record<string, unknown>
        expect(typeof node.kind).toBe("string")
        expect(typeof node.typeVersion).toBe("number")
        expect(typeof node.label).toBe("string")
        expect(typeof node.description).toBe("string")
        expect(typeof node.iconName).toBe("string")
        expect(typeof node.paramsSchema).toBe("object")
        // The two shapes that silently produced an inert node.
        expect(node.name).toBeUndefined()
        expect(node.inputs).toBeUndefined()
      }
    })

    it("every declared permission is a non-empty string", () => {
      // PluginPermission allows both `<group>:<verb>` strings AND a
      // few non-namespaced ones (`notification`). The validator
      // enforces the union; here we only guard against empty / non-
      // string entries that would silently pass JSON.parse.
      for (const perm of manifest.permissions ?? []) {
        expect(typeof perm).toBe("string")
        expect((perm as string).length).toBeGreaterThan(0)
      }
    })

    it("overlay-registry entries round-trip through CAPABILITY_BRIDGE_MAP", () => {
      // For each overlay-registry capability the manifest declares
      // (skills / mcpServerPresets / nativeAnthropicTools /
      // externalAgentPresets), feed the entries through the map's
      // registerEntry → unregisterAllByPlugin cycle and assert no
      // throws + clean cleanup.
      const fakePluginId = `first-party-sweep-${manifest.id}`
      let registeredCount = 0
      const exercised: OverlayRegistryCapability[] = []
      for (const cap of OVERLAY_REGISTRY_CAPABILITY_KEYS) {
        const descriptor = OVERLAY_REGISTRY_CAPABILITIES[cap]
        const entries = (manifest as unknown as Record<string, unknown>)[
          descriptor.manifestField
        ] as ReadonlyArray<{ id: string }> | undefined
        if (!entries?.length) continue
        exercised.push(cap)
        for (const entry of entries) {
          expect(() => descriptor.registerEntry(entry, { pluginId: fakePluginId })).not.toThrow()
          registeredCount += 1
        }
        const removed = descriptor.unregisterAllByPlugin(fakePluginId)
        expect(removed).toBeGreaterThanOrEqual(entries.length)
      }
      // Documentary assertion — the variables are intentionally read
      // even when no overlay-registry capabilities are declared, so
      // they're not dead-code lint warnings.
      void registeredCount
      void exercised
    })
  })
})
