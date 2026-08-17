/**
 * Pi memory/instruction discovery (ADR-0119).
 *
 * Verified against `@earendil-works/pi-coding-agent@0.84.1`:
 *
 *   - Pi's per-directory context candidates are, in priority order,
 *     `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`,
 *     `CLAUDE.MD` — first match wins per directory, and the whole mechanism
 *     is switched off by `--no-context-files` / `-nc`.
 *   - Pi's own project resource list is `settings.json`, `extensions`,
 *     `skills`, `prompts`, `themes`, `SYSTEM.md`, `APPEND_SYSTEM.md`.
 *
 * So this provider surfaces exactly the two files nobody else does:
 *
 *   - global   <pi agent dir>/SYSTEM.md, APPEND_SYSTEM.md
 *   - project  <cwd>/.pi/SYSTEM.md, APPEND_SYSTEM.md
 *
 * It deliberately does NOT re-surface AGENTS.md / CLAUDE.md. Pi reads them,
 * but the claude-code and codex providers already own those paths and the
 * aggregate de-dupes by path — emitting them again would only add duplicate
 * rows attributed to a second agent. This mirrors the same decision the
 * OpenCode provider documents.
 *
 * `SYSTEM.md` *replaces* Pi's default system prompt rather than adding to it,
 * which is why it is labelled distinctly from `APPEND_SYSTEM.md`.
 *
 * Pure + fs-injected (see {@link DiscoverCtx}); no real disk access here.
 */

import { joinPath, pathKey, relLabel } from "@/lib/claude/instructions/paths"
import type { DiscoverCtx, ExternalMemoryFile, ExternalFs } from "../types"

const SYSTEM_FILE = "SYSTEM.md"
const APPEND_SYSTEM_FILE = "APPEND_SYSTEM.md"

/** Pi's project-scope config directory name, always `<cwd>/.pi`. */
const PROJECT_DIR = ".pi"

/** `$PI_CODING_AGENT_DIR` or `<home>/.pi/agent`, per `lib/agent-roots/`. */
export function piAgentDir(ctx: Pick<DiscoverCtx, "home" | "vendorRoots">): string {
  return ctx.vendorRoots?.piAgentDir || (ctx.home ? joinPath(ctx.home, ".pi/agent") : "")
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
    agent: "pi",
    scope,
    absPath,
    label,
    // Both files are plain user-owned prompt files — Pi has no agent-managed
    // memory store of its own.
    editable: true,
    exists,
    bytes: exists ? await bytesOf(fs, absPath) : undefined,
  }
}

/** Enumerate Pi memory files for the given context. */
export async function discoverPi(ctx: DiscoverCtx): Promise<ExternalMemoryFile[]> {
  const { roots, fs } = ctx
  const out: ExternalMemoryFile[] = []
  const agentDir = piAgentDir(ctx)

  // 1. Global — surfaced even when absent so the panel can offer creation,
  //    the same affordance Codex's ~/.codex/AGENTS.md gets.
  if (agentDir) {
    for (const [name, suffix] of [
      [SYSTEM_FILE, "Pi global system prompt"],
      [APPEND_SYSTEM_FILE, "Pi global system prompt suffix"],
    ] as const) {
      const entry = await fileEntry(fs, "global", joinPath(agentDir, name), `${name} (${suffix})`, {
        includeAbsent: true,
      })
      if (entry) out.push(entry)
    }
  }

  // 2. Project — Pi only reads `<cwd>/.pi`, not every ancestor directory, so
  //    there is no root→cwd walk here (unlike AGENTS.md discovery).
  const seen = new Set<string>()
  for (const root of roots) {
    for (const name of [SYSTEM_FILE, APPEND_SYSTEM_FILE]) {
      const abs = joinPath(joinPath(root, PROJECT_DIR), name)
      if (seen.has(pathKey(abs))) continue
      seen.add(pathKey(abs))
      const entry = await fileEntry(fs, "project", abs, relLabel(root, abs))
      if (entry) out.push(entry)
    }
  }

  return out
}
