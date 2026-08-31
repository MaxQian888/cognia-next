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
 * Tauri host, not the browser bundle, so the registry above says nothing about
 * them. They get the mirror-image guard at the bottom of this file: the host
 * only ever finds a plugin that has a directory under
 * `<appDataDir>/cognia/plugins`, so one that is neither staged into the
 * installer nor marked dev-only exists for someone who cloned the repo and
 * for nobody who installed the app. That is exactly how RepoWiki (ADR-0146)
 * shipped as a whole subsystem that no release contained.
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
    "Phase-B LSP fixture — exercised by its own co-located suite (which drives the bundled echo-lsp server over real stdio framing), not shipped to end users.",
  "cognia-pro-ide-fixture":
    "ADR-0088 managed Pro IDE fixture — proves the proxy/broker chain end to end on the desktop; blocked in browser and mobile shells because that chain needs the embedded code-server, so bundling it into the browser registry would ship a plugin that can never activate.",
  "cognia-external-agent-preset-example":
    "Author reference plugin — copy-paste template, not a default.",
  "cognia-external-agent-adapter-example":
    "Author reference plugin — copy-paste template for contributing a new external-agent protocol, not a default.",
  "cognia-character-seeds": "Copy-paste character-pack template for plugin authors (ADR-0030).",
  "cognia-impeccable":
    "Installable desktop skill bundle — discovered from the on-disk plugin directory and deliberately blocked in browser/mobile shells.",
  // Present in `browserBuiltins` but filtered out of the effective registry by
  // `isBrowserBuiltinAvailable` unless NEXT_PUBLIC_E2E=1 — so it is out of the
  // DEFAULT registry, which is what this list curates. Do not "wire it up".
  "ui-surface-reference":
    "E2E-only fixture exercising every plugin UI surface — gated behind NEXT_PUBLIC_E2E by `isBrowserBuiltinAvailable` so it never reaches a user shell; drives tests/e2e/plugin-ui-surfaces.spec.ts. ADR-0126 cites it as the E2E-only-fixture precedent; the gating itself is pinned by lib/plugin/core/browser-builtin-registry.test.ts.",
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

describe("on-disk plugin distribution guard", () => {
  const distribution = JSON.parse(
    readFileSync(join(PLUGINS_ROOT, "distribution.json"), "utf-8")
  ) as {
    bundled: Record<string, { id: string; reason: string; include: string[] }>
    devOnly: Record<string, string>
  }
  const all = discoverFirstPartyPlugins()
  const onDisk = all.filter((p) => p.type !== "frontend")

  it("finds the non-frontend plugins it is meant to curate", () => {
    expect(onDisk.length).toBeGreaterThan(0)
  })

  it.each(onDisk)("$dir is classified as bundled or dev-only", ({ dir, id }) => {
    const bundled = dir in distribution.bundled
    const devOnly = dir in distribution.devOnly
    if (!bundled && !devOnly) {
      throw new Error(
        `Plugin "${dir}" (${id}) loads from disk but plugins/distribution.json does not classify it. ` +
          `Nothing stages it into src-tauri/resources/plugins, and the Tauri host only scans ` +
          `<appDataDir>/cognia/plugins, so an installed build will not have it at all. ` +
          `Add it under "bundled" with the files to ship, or under "devOnly" with a reason.`
      )
    }
    expect(bundled && devOnly).toBe(false)
    if (bundled) expect(distribution.bundled[dir].id).toBe(id)
  })

  it("has no stale distribution entries", () => {
    const dirs = new Set(onDisk.map((p) => p.dir))
    for (const dir of [
      ...Object.keys(distribution.bundled),
      ...Object.keys(distribution.devOnly),
    ]) {
      expect(dirs.has(dir)).toBe(true)
    }
  })

  it("gives every bundled plugin a reason and a manifest to ship", () => {
    for (const [dir, entry] of Object.entries(distribution.bundled)) {
      expect(entry.reason.length).toBeGreaterThan(20)
      // Without plugin.json the host cannot discover the directory it just
      // received, so the copy would be silently inert.
      expect(entry.include).toContain("plugin.json")
      expect(`${dir}/plugin.json`).toBeTruthy()
    }
  })

  it("gives every dev-only plugin a reason", () => {
    for (const reason of Object.values(distribution.devOnly)) {
      expect(reason.length).toBeGreaterThan(20)
    }
  })

  it("ships the staged tree in the installer", () => {
    // The staging step is pointless if `bundle.resources` does not carry the
    // result, and that omission is invisible until someone installs a release.
    const tauriConf = JSON.parse(
      readFileSync(join(PLUGINS_ROOT, "..", "src-tauri", "tauri.conf.json"), "utf-8")
    ) as { bundle: { resources: string[] } }
    expect(tauriConf.bundle.resources).toContain("resources/plugins/**/*")
  })
})
