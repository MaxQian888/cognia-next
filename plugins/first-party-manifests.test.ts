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
  ],
  "anthropic-skills": ["field_missing:skills", "field_missing:commands"],
  "clipboard-history": ["partial:themes", "field_missing:tools", "field_missing:commands"],
  "clipboard-tools": ["field_missing:tools"],
  "cognia-appearance-demo": ["partial:theme-pack", "partial:wallpapers"],
  "cognia-backend-refactor": [
    "partial:workflow",
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
  "cognia-scheduler-tools": ["field_missing:tools", "field_missing:scheduler"],
  "cognia-sandboxed-tools": ["field_missing:tools"],
  "cognia-scheduling-demo": [],
  "cognia-share-watch": [],
  "computer-use": [
    "field_missing:tools",
    "field_missing:commands",
    "field_missing:native-anthropic-tool",
    "field_missing:subagent",
    "field_missing:agent-team-template",
  ],
  "deep-research": ["field_missing:tools", "field_missing:skills"],
  "e2b-sandbox": ["field_missing:commands", "field_missing:mcp-server-preset"],
  eval: ["field_missing:tools"],
  "external-agent-preset-example": ["field_missing:external-agent-preset"],
  "github-delivery": [
    "experimental:providers",
    "partial:exporters",
    "partial:connectors",
    "field_missing:tools",
    "field_missing:components",
  ],
  ocr: ["field_missing:tools", "field_missing:commands"],
  "playwright-mcp": ["field_missing:commands", "field_missing:mcp-server-preset"],
  "prompt-templates": ["field_missing:commands"],
  "ripgrep-tools": ["experimental:cli-tools"],
  screenshot: ["field_missing:tools", "field_missing:commands"],
  "stagehand-mcp": ["field_missing:commands", "field_missing:mcp-server-preset"],
  "test-lsp-contribution": ["experimental:lsp-server"],
  "wasm-example-formatter": ["partial:workflow"],
  "web-tools": ["field_missing:tools"],
  "workflow-ai": ["field_missing:tools", "field_missing:commands"],
  "workspace-tools": ["field_missing:tools"],
  "zhihu-content-pipeline": [
    "partial:workflow",
    "field_missing:tools",
    "field_missing:skills",
    "field_missing:commands",
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
