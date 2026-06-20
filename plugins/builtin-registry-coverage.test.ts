/**
 * @jest-environment jsdom
 */

/**
 * Builtin-registry curation guard.
 *
 * The browser builtin registry (`lib/plugin/core/browser-builtin-registry.ts`)
 * is a hand-maintained static list — a frontend plugin that is compiled into
 * the tree but never added there is silently dormant in every shell (the
 * recurring "built but not wired" defect). The `first-party-manifests` sweep
 * validates manifests but does NOT verify discovery, so the gap slipped
 * through historically (deep-research, the default character pack, …).
 *
 * This test closes the loop: every `type: "frontend"` plugin under `plugins/`
 * must be EITHER registered as a browser builtin OR explicitly listed in
 * `INTENTIONALLY_UNBUNDLED` with a documented reason. A new frontend plugin
 * that is neither fails the sweep, forcing the curation decision into review.
 *
 * Non-frontend plugins (python / wasm / vscode-extension) load through the
 * Tauri host, not the browser bundle, so they're out of scope here.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { getBrowserBuiltinRegistry } from "@/lib/plugin/core/browser-builtin-registry"
import type { PluginManifest } from "@/types/plugin"

const PLUGINS_ROOT = join(__dirname)

/**
 * Frontend plugins deliberately kept OUT of the default browser builtin
 * registry. Each entry needs a one-line reason so the exclusion is a
 * reviewed decision, not an accident. Keyed by `plugin.json` id.
 */
const INTENTIONALLY_UNBUNDLED: Readonly<Record<string, string>> = Object.freeze({
  "cognia-test-lsp-contribution":
    "Phase-B LSP test fixture — loaded only by the verification suite.",
  "cognia-external-agent-preset-example":
    "Author reference plugin — copy-paste template, not a default.",
  "cognia-external-agent-adapter-example":
    "Author reference plugin — copy-paste template for contributing a new external-agent protocol, not a default.",
  "cognia-character-seeds": "Copy-paste character-pack template for plugin authors (ADR-0030).",
})

/** Walk `plugins/` and return every direct child that owns a plugin.json. */
function discoverFirstPartyPlugins(): Array<{ dir: string; id: string; type: string }> {
  return readdirSync(PLUGINS_ROOT)
    .filter((name) => {
      const full = join(PLUGINS_ROOT, name)
      try {
        return statSync(full).isDirectory() && statSync(join(full, "plugin.json")).isFile()
      } catch {
        return false
      }
    })
    .map((dir) => {
      const manifest = JSON.parse(
        readFileSync(join(PLUGINS_ROOT, dir, "plugin.json"), "utf-8")
      ) as PluginManifest
      return { dir, id: manifest.id, type: manifest.type }
    })
    .sort((a, b) => a.dir.localeCompare(b.dir))
}

describe("builtin-registry curation guard", () => {
  const all = discoverFirstPartyPlugins()
  const frontend = all.filter((p) => p.type === "frontend")
  const registeredIds = new Set(getBrowserBuiltinRegistry().map((e) => e.manifest.id))

  it("discovers frontend plugins (sanity check)", () => {
    expect(frontend.length).toBeGreaterThan(0)
  })

  it.each(frontend)(
    "$dir is either registered as a builtin or intentionally unbundled",
    ({ id }) => {
      const registered = registeredIds.has(id)
      const excluded = id in INTENTIONALLY_UNBUNDLED
      if (!registered && !excluded) {
        throw new Error(
          `Frontend plugin "${id}" is neither in the browser builtin registry ` +
            `(lib/plugin/core/browser-builtin-registry.ts) nor in INTENTIONALLY_UNBUNDLED. ` +
            `It will be dormant in every shell. Register it, or add it to the exclusion ` +
            `list with a reason.`
        )
      }
      // A plugin can't be both registered AND listed as unbundled — that's a
      // stale exclusion entry.
      expect(registered && excluded).toBe(false)
    }
  )

  it("has no stale INTENTIONALLY_UNBUNDLED entries", () => {
    const frontendIds = new Set(frontend.map((p) => p.id))
    for (const id of Object.keys(INTENTIONALLY_UNBUNDLED)) {
      expect(frontendIds.has(id)).toBe(true)
    }
  })
})
