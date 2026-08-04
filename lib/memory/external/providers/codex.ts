/**
 * Codex memory/instruction discovery.
 *
 * Verified locations (docs: developers.openai.com/codex/guides/agents-md, /memories):
 *   - global    ~/.codex/AGENTS.override.md (preferred), then ~/.codex/AGENTS.md (editable)
 *   - project   root→cwd per dir: AGENTS.override.md, then AGENTS.md            (editable)
 *   - memories  ~/.codex/memories/*                                            (read-only)
 *
 * Pure + fs-injected (see {@link DiscoverCtx}); no real disk access here.
 */

import { ancestorChain, joinPath, pathKey, relLabel } from "@/lib/claude/instructions/paths"
import type { DiscoverCtx, ExternalMemoryFile, ExternalFs } from "../types"

/** Same-dir precedence: override wins, but we surface both so either can be edited. */
const AGENTS_FILES = ["AGENTS.override.md", "AGENTS.md"] as const

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
  editable: boolean,
  absPath: string,
  label: string,
  { includeAbsent = false }: { includeAbsent?: boolean } = {}
): Promise<ExternalMemoryFile | null> {
  const exists = await fs.exists(absPath).catch(() => false)
  if (!exists && !includeAbsent) return null
  return {
    id: pathKey(absPath),
    agent: "codex",
    scope,
    absPath,
    label,
    editable,
    exists,
    bytes: exists ? await bytesOf(fs, absPath) : undefined,
  }
}

/** Enumerate Codex memory files for the given context. */
export async function discoverCodex(ctx: DiscoverCtx): Promise<ExternalMemoryFile[]> {
  const { home, roots, cwd, fs } = ctx
  const out: ExternalMemoryFile[] = []
  // `$CODEX_HOME` relocates the whole tree; `vendorRoots` carries it.
  const codexDir = ctx.vendorRoots?.codexHome || joinPath(home, ".codex")

  // 1. Global — surface AGENTS.md slot even when absent; override only when present.
  const override = await fileEntry(
    fs,
    "global",
    true,
    joinPath(codexDir, "AGENTS.override.md"),
    "~/.codex/AGENTS.override.md"
  )
  if (override) out.push(override)
  const global = await fileEntry(
    fs,
    "global",
    true,
    joinPath(codexDir, "AGENTS.md"),
    "~/.codex/AGENTS.md",
    { includeAbsent: true }
  )
  if (global) out.push(global)

  // 2. Project — walk each containing root from root→cwd.
  const seen = new Set<string>()
  for (const root of roots) {
    const chain = ancestorChain(cwd && pathKey(cwd).startsWith(pathKey(root)) ? cwd : root, root)
    for (const dir of [...chain].reverse()) {
      for (const name of AGENTS_FILES) {
        const abs = joinPath(dir, name)
        if (seen.has(pathKey(abs))) continue
        seen.add(pathKey(abs))
        const entry = await fileEntry(fs, "project", true, abs, relLabel(root, abs))
        if (entry) out.push(entry)
      }
    }
  }

  // 3. Codex-managed memories — read-only.
  out.push(...(await discoverMemories(fs, codexDir)))

  return out
}

async function discoverMemories(fs: ExternalFs, codexDir: string): Promise<ExternalMemoryFile[]> {
  const memoriesDir = joinPath(codexDir, "memories")
  let names: string[]
  try {
    names = await fs.readDir(memoriesDir)
  } catch {
    return []
  }
  const out: ExternalMemoryFile[] = []
  for (const name of names.sort()) {
    const abs = joinPath(memoriesDir, name)
    const entry = await fileEntry(fs, "memories", false, abs, `memories/${name}`)
    if (entry) out.push(entry)
  }
  return out
}
