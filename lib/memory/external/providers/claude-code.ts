/**
 * Claude Code memory/instruction discovery.
 *
 * Verified locations (docs: code.claude.com/docs/en/memory, /claude-directory):
 *   - user      ~/.claude/CLAUDE.md                                   (editable)
 *   - managed   <os-specific>/ClaudeCode/CLAUDE.md                    (read-only policy)
 *   - project   root→cwd: CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md (editable)
 *   - auto      ~/.claude/projects/<encoded-repo>/memory/*.md         (editable)
 *
 * Pure + fs-injected (see {@link DiscoverCtx}); no real disk access here.
 */

import { ancestorChain, joinPath, pathKey, relLabel } from "@/lib/claude/instructions/paths"
import { encodeClaudeProject } from "../home"
import type { DiscoverCtx, ExternalMemoryFile, ExternalFs, ExternalPlatform } from "../types"

/** Same-dir project file precedence — all surfaced (concatenated by Claude Code). */
const PROJECT_FILES = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"] as const

/** OS-specific managed (enterprise policy) CLAUDE.md location. */
function managedClaudePath(platform: ExternalPlatform): string {
  switch (platform) {
    case "macos":
      return "/Library/Application Support/ClaudeCode/CLAUDE.md"
    case "windows":
      return "C:\\Program Files\\ClaudeCode\\CLAUDE.md"
    default:
      return "/etc/claude-code/CLAUDE.md"
  }
}

/** Stat helper → bytes, tolerant of stat failures on an existing file. */
async function bytesOf(fs: ExternalFs, path: string): Promise<number | undefined> {
  try {
    const s = await fs.stat(path)
    return s.size
  } catch {
    return undefined
  }
}

async function fileEntry(
  fs: ExternalFs,
  agentScope: { scope: ExternalMemoryFile["scope"]; editable: boolean },
  absPath: string,
  label: string,
  { includeAbsent = false }: { includeAbsent?: boolean } = {}
): Promise<ExternalMemoryFile | null> {
  const exists = await fs.exists(absPath).catch(() => false)
  if (!exists && !includeAbsent) return null
  return {
    id: pathKey(absPath),
    agent: "claude-code",
    scope: agentScope.scope,
    absPath,
    label,
    editable: agentScope.editable,
    exists,
    bytes: exists ? await bytesOf(fs, absPath) : undefined,
  }
}

/** Enumerate Claude Code memory files for the given context. */
export async function discoverClaudeCode(ctx: DiscoverCtx): Promise<ExternalMemoryFile[]> {
  const { home, roots, cwd, platform, fs } = ctx
  const out: ExternalMemoryFile[] = []
  const claudeDir = joinPath(home, ".claude")

  // 1. User-global — surfaced even when absent so the user knows the slot exists.
  const user = await fileEntry(
    fs,
    { scope: "user", editable: true },
    joinPath(claudeDir, "CLAUDE.md"),
    "~/.claude/CLAUDE.md",
    { includeAbsent: true }
  )
  if (user) out.push(user)

  // 2. Managed policy — read-only, only when present.
  const managed = await fileEntry(
    fs,
    { scope: "managed", editable: false },
    managedClaudePath(platform),
    "managed/CLAUDE.md"
  )
  if (managed) out.push(managed)

  // 3. Project files — walk each containing root from root→cwd.
  const seen = new Set<string>()
  for (const root of roots) {
    const chain = ancestorChain(cwd && pathKey(cwd).startsWith(pathKey(root)) ? cwd : root, root)
    // ancestorChain is nearest-first; reverse to root-first for stable display order.
    for (const dir of [...chain].reverse()) {
      for (const rel of PROJECT_FILES) {
        const abs = joinPath(dir, rel)
        if (seen.has(pathKey(abs))) continue
        seen.add(pathKey(abs))
        const entry = await fileEntry(
          fs,
          { scope: "project", editable: true },
          abs,
          relLabel(root, abs)
        )
        if (entry) out.push(entry)
      }
    }
  }

  // 4. Auto-memory — every ~/.claude/projects/<encoded>/memory/*.md.
  out.push(...(await discoverAutoMemory(fs, claudeDir, roots)))

  return out
}

/** Scan each `~/.claude/projects/<dir>/memory` for MEMORY.md + topic files. */
async function discoverAutoMemory(
  fs: ExternalFs,
  claudeDir: string,
  roots: string[]
): Promise<ExternalMemoryFile[]> {
  const projectsDir = joinPath(claudeDir, "projects")
  let projectDirs: string[]
  try {
    projectDirs = await fs.readDir(projectsDir)
  } catch {
    return []
  }
  const activeEncoded = new Set(roots.map(encodeClaudeProject))
  const out: ExternalMemoryFile[] = []
  for (const dirName of projectDirs.sort()) {
    const memoryDir = joinPath(joinPath(projectsDir, dirName), "memory")
    let names: string[]
    try {
      names = await fs.readDir(memoryDir)
    } catch {
      continue
    }
    const mdFiles = names.filter((n) => n.toLowerCase().endsWith(".md")).sort()
    if (mdFiles.length === 0) continue
    const isActive = activeEncoded.has(dirName)
    for (const name of mdFiles) {
      const abs = joinPath(memoryDir, name)
      const entry = await fileEntry(
        fs,
        { scope: "auto", editable: true },
        abs,
        `${isActive ? "★ " : ""}projects/${dirName}/memory/${name}`
      )
      if (entry) out.push(entry)
    }
  }
  return out
}
