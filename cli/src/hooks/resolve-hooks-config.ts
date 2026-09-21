/**
 * The CLI's single hook-config resolver.
 *
 * Why this exists: the desktop injects the user's merged `hooks` block into
 * `SendOptions` host-side (`src-tauri/src/claude/commands.rs`), so the sidecar
 * registers them as SDK-native hooks and every one of the 31 lifecycle events
 * fires with full blocking + context-injection semantics. The CLI's transport
 * maps `claude_send` straight to sidecar stdin (`cli/src/runtime/protocol.ts`),
 * bypassing that injection entirely — and the CLI never injected `hooks`
 * itself. So the CLI had NO SDK-native hooks at all; its only engine was the
 * reduced `hook-runner.ts`, which is wired into the TUI alone and never parses
 * a hook's stdout. The visible symptom: `auto-context-loader` ships enabled by
 * default and silently did nothing on this rail.
 *
 * `resolveCliHooksConfig` is the shared read used by BOTH the injection (so the
 * sidecar runs the real engine for every CLI turn, including subagents and
 * headless runs) and `hook-runner.ts` (which now only covers the CLI-local
 * events the SDK cannot see). One reader means the two can never disagree about
 * which hooks are configured.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { buildBuiltinHookGroups } from "../../../lib/claude/hooks/builtin-hooks"
import { isTrusted } from "../config/trusted-folders"
import { pluginDiscoveryRoots } from "../plugin/discover-plugins"
import { readDisabledPlugins } from "../plugin/plugin-state"
import { loadHooks, type FileReader } from "./load-hooks"
import { resolvePluginCommandHooks, type DirLister } from "./plugin-hooks"
import type { HooksConfig } from "./types"

export interface ResolveCliHooksDeps {
  /** Cognia config home (`~/.cognia`). */
  home: string
  /** OS home, used to locate `~/.claude`. Defaults to `os.homedir()`. */
  osHome?: string
  /**
   * Project directory — enables project-scope plugins under
   * `<cwd>/.cognia/plugins`, but only once the folder is trusted (its
   * manifests are repository-controlled shell commands). Omitted → user- and
   * data-scope plugins only.
   */
  cwd?: string
  /**
   * Folder-trust predicate for the project scope (`trusted-folders.json` by
   * default). Injected for tests.
   */
  isTrustedFolder?: (home: string, cwd: string) => boolean
  /** Overrides for the product-bundled built-in hooks (id → enabled). */
  builtinHookOverrides?: Record<string, boolean>
  /** Directory holding the built-in `*.mjs` scripts. */
  builtinHooksDir?: string
  /** Injected for tests. */
  readFile?: FileReader
  /** Injected for tests. */
  readDir?: DirLister
}

const defaultReadFile: FileReader = (absPath) => {
  try {
    return fs.readFileSync(absPath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

const defaultReadDir: DirLister = (dir) => {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * Read the effective hook config for this CLI process: cognia config, then
 * `~/.claude/settings.json` (minus fleet groups), then the product built-ins
 * merged underneath. Never throws — a broken config yields `{}` so a
 * misconfigured hook block can never stop the agent from running.
 */
export function resolveCliHooksConfig(deps: ResolveCliHooksDeps): HooksConfig {
  try {
    const readFile = deps.readFile ?? defaultReadFile
    const readDir = deps.readDir ?? defaultReadDir
    const osHome = deps.osHome ?? os.homedir()
    const claudeHome = path.join(osHome, ".claude")
    const builtin = buildBuiltinHookGroups({
      baseDir: deps.builtinHooksDir ?? path.join(process.cwd(), "hooks", "builtin"),
      overrides: deps.builtinHookOverrides,
    }) as HooksConfig
    // Scan the same roots plugin discovery uses (`<root>/.cognia/plugins`):
    // project scope first, then the cognia home, then `COGNIA_DATA_DIR` where
    // cognia-server installs remote plugins. The project scope is
    // repository-controlled content — its manifests carry shell commands — so
    // it contributes hooks only once the folder is trusted. The home/data
    // roots are user- or server-managed and always scan.
    const projectRoot = deps.cwd ? path.resolve(deps.cwd) : null
    const isTrustedFolder = deps.isTrustedFolder ?? isTrusted
    const pluginDirs = pluginDiscoveryRoots(process.env, deps.cwd ?? "", deps.home)
      .filter(
        (root) =>
          path.resolve(root) !== projectRoot ||
          (projectRoot !== null && isTrustedFolder(deps.home, deps.cwd as string))
      )
      .map((root) => path.join(root, ".cognia", "plugins"))
    const plugin = resolvePluginCommandHooks({
      pluginDirs,
      disabled: readDisabledPlugins(deps.home),
      readDir,
      readFile,
    })
    return loadHooks({ home: deps.home, claudeHome, readFile, plugin, builtin })
  } catch {
    return {}
  }
}

/** True when the config has at least one group on at least one event. */
export function hasAnyHookGroup(config: HooksConfig | null | undefined): boolean {
  if (!config) return false
  return Object.values(config).some((groups) => Array.isArray(groups) && groups.length > 0)
}
