/**
 * OpenCode memory/instruction discovery.
 *
 * Verified locations (docs: opencode.ai/docs/rules):
 *   - global    <opencodeConfigDir>/AGENTS.md                      (editable)
 *   - project   root→cwd per dir: AGENTS.md                        (editable)
 *
 * `<opencodeConfigDir>` is `$XDG_CONFIG_HOME/opencode`, `%APPDATA%\opencode`,
 * or `~/.config/opencode` — resolved once in `lib/agent-roots/` and passed in
 * as {@link DiscoverCtx.vendorRoots}.
 *
 * Two things this provider deliberately does NOT do:
 *   - It does not re-surface `CLAUDE.md`. OpenCode reads it for compatibility,
 *     but the claude-code provider already owns that file; emitting it twice
 *     would just be a duplicate row (the aggregate de-dupes by path anyway).
 *   - It does not expand `opencode.json`'s `instructions` array. Those are
 *     arbitrary globs relative to the config, and they belong to the settings
 *     importer (`lib/settings-import/`), not to a file enumerator.
 *
 * Pure + fs-injected (see {@link DiscoverCtx}); no real disk access here.
 */

import { ancestorChain, joinPath, pathKey, relLabel } from "@/lib/claude/instructions/paths"
import type { DiscoverCtx, ExternalMemoryFile, ExternalFs } from "../types"

const AGENTS_FILE = "AGENTS.md"

/** `<home>/.config/opencode` unless the resolved roots say otherwise. */
export function opencodeConfigDir(ctx: Pick<DiscoverCtx, "home" | "vendorRoots">): string {
  return ctx.vendorRoots?.opencodeConfigDir || joinPath(ctx.home, ".config/opencode")
}

async function bytesOf(fs: ExternalFs, path: string): Promise<number | undefined> {
  try {
    return (await fs.stat(path)).size
  } catch {
    return undefined
  }
}

async function fileEntry(
  fs: ExternalFs,
  scope: ExternalMemoryFile["scope"],
  absPath: string,
  label: string,
  { includeAbsent = false }: { includeAbsent?: boolean } = {}
): Promise<ExternalMemoryFile | null> {
  const exists = await fs.exists(absPath).catch(() => false)
  if (!exists && !includeAbsent) return null
  return {
    id: pathKey(absPath),
    agent: "opencode",
    scope,
    absPath,
    label,
    // OpenCode has no agent-managed memory store — every file it reads is a
    // plain rules file the user owns, so all of them are editable.
    editable: true,
    exists,
    bytes: exists ? await bytesOf(fs, absPath) : undefined,
  }
}

/** Enumerate OpenCode memory files for the given context. */
export async function discoverOpencode(ctx: DiscoverCtx): Promise<ExternalMemoryFile[]> {
  const { roots, cwd, fs } = ctx
  const out: ExternalMemoryFile[] = []
  const configDir = opencodeConfigDir(ctx)

  // 1. Global — surfaced even when absent, so the user can create it from the
  //    panel (same affordance Codex's ~/.codex/AGENTS.md gets).
  if (configDir) {
    const global = await fileEntry(
      fs,
      "global",
      joinPath(configDir, AGENTS_FILE),
      `${AGENTS_FILE} (OpenCode global)`,
      { includeAbsent: true }
    )
    if (global) out.push(global)
  }

  // 2. Project — walk each containing root from root→cwd.
  const seen = new Set<string>()
  for (const root of roots) {
    const chain = ancestorChain(cwd && pathKey(cwd).startsWith(pathKey(root)) ? cwd : root, root)
    for (const dir of [...chain].reverse()) {
      const abs = joinPath(dir, AGENTS_FILE)
      if (seen.has(pathKey(abs))) continue
      seen.add(pathKey(abs))
      const entry = await fileEntry(fs, "project", abs, relLabel(root, abs))
      if (entry) out.push(entry)
    }
  }

  return out
}
