/**
 * Plugin-contributed command hooks (`manifest.commandHooks`, `command-hooks`
 * capability) for the CLI rail. Mirrors `src-tauri/src/hooks/plugin.rs`: each
 * enabled plugin's block merges UNDER the user's own groups and above
 * built-ins — the same settings.json `Event → HookGroup[]` shape the runner
 * already executes, so plugin handlers get identical blocking / context /
 * async semantics without a second runtime.
 *
 * Trust tier: handlers run in the hook runtime, not inside a plugin sandbox —
 * identical to user-configured hooks. Collection is therefore gated on the
 * manifest declaring the `command-hooks` capability; the field alone is inert.
 * Which roots are safe to scan is the caller's decision — a repository-owned
 * `<cwd>/.cognia/plugins` root must only be passed in once the folder is
 * trusted (see `resolve-hooks-config.ts`).
 */
import path from "node:path"

import { PLUGIN_ROOT_TOKENS, replacePluginRootTokens } from "@/lib/plugin/utils/plugin-root-tokens"

import type { FileReader } from "./load-hooks"
import { HooksConfigSchema, type HookGroup, type HooksConfig } from "./types"

/** Lists directory entry names; missing/unreadable dirs yield `[]`. */
export type DirLister = (dir: string) => string[]

export interface ResolvePluginHooksDeps {
  /**
   * Plugin install roots, scanned as `<dir>/<plugin-id>/{manifest,plugin}.json` —
   * i.e. `<root>/.cognia/plugins` directories already expanded by the caller.
   */
  pluginDirs: readonly string[]
  /** Ids the user disabled in `plugin-state.json`. */
  disabled?: ReadonlySet<string>
  readDir: DirLister
  readFile: FileReader
}

/**
 * Manifest filenames an installed plugin may carry, probed in this order. The
 * plugin runtime installs write `manifest.json`
 * (`crates/cognia-plugin-runtime/src/lifecycle.rs`); `plugin.json` is the
 * CLI/source-layout alias `discover-plugins.ts` scans for.
 */
const MANIFEST_FILES = ["manifest.json", "plugin.json"] as const

interface ManifestHookContribution {
  id: string
  dir: string
  hooks: HooksConfig
}

/** Quote one path for the `sh -c` / `cmd /C` shells command hooks run under. */
function quoteShellPath(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`
}

/**
 * Bind `${*_PLUGIN_ROOT}` spellings inside one command string to a shell-quoted
 * install dir. The raw `replacePluginRootTokens` splice would split on the
 * spaces install roots routinely contain (`~/Library/Application Support/…`).
 * A token already wrapped in a quote pair (`"${ROOT}/x"`) loses that pair
 * first, so the substituted root isn't double-quoted.
 */
function bindCommandRoot(command: string, pluginDir: string): string {
  const quoted = quoteShellPath(pluginDir)
  let out = command
  for (const token of PLUGIN_ROOT_TOKENS) {
    for (const q of ['"', "'"]) {
      const open = `${q}${token}`
      let idx = out.indexOf(open)
      while (idx !== -1) {
        const closeIdx = out.indexOf(q, idx + open.length)
        const span = closeIdx === -1 ? null : out.slice(idx + open.length, closeIdx)
        // Only an unbroken path span between the quotes counts as an enclosing
        // pair — a quote spanning whitespace belongs to the command itself.
        if (span == null || /[\s"']/.test(span)) break
        out = out.slice(0, closeIdx) + out.slice(closeIdx + 1)
        out = out.slice(0, idx) + out.slice(idx + 1)
        idx = out.indexOf(open)
      }
    }
    out = out.replaceAll(token, quoted)
  }
  return out
}

/**
 * Parse one installed plugin's manifest and extract a validated
 * `commandHooks` block. Returns `null` for anything malformed or not gated —
 * a broken plugin manifest must never take the hook pipeline down with it.
 */
function readPluginHooks(dir: string, readFile: FileReader): ManifestHookContribution | null {
  let text: string | null = null
  for (const name of MANIFEST_FILES) {
    text = readFile(path.join(dir, name))
    if (text != null) break
  }
  if (text == null) return null
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof manifest.id !== "string" || !manifest.id) return null
  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : []
  if (!capabilities.includes("command-hooks")) return null
  const parsed = HooksConfigSchema.safeParse(manifest.commandHooks)
  if (!parsed.success) return null
  return { id: manifest.id, dir, hooks: parsed.data }
}

/**
 * Merge every enabled plugin's `commandHooks` block into one config. Entries
 * are applied in sorted directory order, and earlier `pluginDirs` roots land
 * their groups first — so the merged order is deterministic across processes.
 * A plugin id wins on first sight across roots (the same first-id-wins
 * contract `discover-plugins.ts` uses), so a project-scope copy of an
 * installed plugin cannot stack a second set of hooks under the same id.
 * Plugin-root tokens bind to each plugin's own install dir, shell-quoted in
 * `command` strings and raw elsewhere.
 */
export function resolvePluginCommandHooks(deps: ResolvePluginHooksDeps): HooksConfig {
  const merged: Record<string, HookGroup[]> = {}
  const seen = new Set<string>()
  for (const pluginsDir of deps.pluginDirs) {
    const contributions: ManifestHookContribution[] = []
    for (const entry of deps.readDir(pluginsDir).sort()) {
      const dir = path.join(pluginsDir, entry)
      const contribution = readPluginHooks(dir, deps.readFile)
      if (!contribution) continue
      if (deps.disabled?.has(contribution.id)) continue
      if (seen.has(contribution.id)) continue
      seen.add(contribution.id)
      contributions.push(contribution)
    }
    for (const contribution of contributions) {
      for (const [event, groups] of Object.entries(contribution.hooks)) {
        if (!Array.isArray(groups)) continue
        const target = (merged[event] ??= [])
        for (const group of groups) {
          // Command strings bind the install dir shell-quoted; every other
          // string field (matchers, webhook urls) keeps the raw expansion.
          const rebound = {
            ...group,
            hooks: group.hooks.map((handler) =>
              handler.type === "command" && typeof handler.command === "string"
                ? { ...handler, command: bindCommandRoot(handler.command, contribution.dir) }
                : handler
            ),
          }
          target.push(replacePluginRootTokens(rebound, contribution.dir))
        }
      }
    }
  }
  return merged as HooksConfig
}
