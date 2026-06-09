/**
 * Pure discovery of markdown-defined subagents under `.cognia/agents/*.md`
 * (project) and an optional global agents dir. Produces the `MarkdownAgentFile[]`
 * that `lib/claude/agents/markdown-agents.ts:buildMarkdownAgents` consumes.
 *
 * Ordering matters: `buildMarkdownAgents` lets later files override earlier ones
 * by id, so we read global first, then non-primary roots, then the PRIMARY root
 * last — the project's primary `.cognia/agents` wins on id collisions.
 */

import { basename, joinPath } from "./paths"
import { PROJECT_AGENTS_DIR, type InstructionFs } from "./types"
import type { MarkdownAgentFile } from "@/lib/claude/agents/markdown-agents"

function kebabId(fileName: string): string {
  return (
    fileName
      .replace(/\.md$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent"
  )
}

async function readAgentsInDir(dir: string, fs: InstructionFs): Promise<MarkdownAgentFile[]> {
  let names: string[]
  try {
    names = await fs.readDir(dir)
  } catch {
    return []
  }
  const out: MarkdownAgentFile[] = []
  for (const name of names.filter((n) => n.toLowerCase().endsWith(".md")).sort()) {
    try {
      const content = await fs.readText(joinPath(dir, name))
      out.push({ id: kebabId(basename(name)), content })
    } catch {
      // skip unreadable file
    }
  }
  return out
}

export interface DiscoverAgentsInput {
  roots: string[]
  /** Optional already-resolved global agents directory (e.g. `~/.cognia/agents`). */
  globalAgentsDir?: string
  fs: InstructionFs
}

export async function discoverMarkdownAgentFiles(
  input: DiscoverAgentsInput
): Promise<MarkdownAgentFile[]> {
  const { roots, globalAgentsDir, fs } = input
  // global first, then non-primary roots, then primary root LAST (primary wins).
  const dirs: string[] = []
  if (globalAgentsDir) dirs.push(globalAgentsDir)
  for (const root of [...roots].reverse()) {
    if (root) dirs.push(joinPath(root, PROJECT_AGENTS_DIR))
  }
  const files: MarkdownAgentFile[] = []
  for (const dir of dirs) {
    files.push(...(await readAgentsInDir(dir, fs)))
  }
  return files
}
