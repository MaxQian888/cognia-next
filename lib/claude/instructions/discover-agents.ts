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

/** One `.md` agent definition file, located but not read. */
export interface MarkdownAgentPath {
  /** Same kebab id `discoverMarkdownAgentFiles` assigns. */
  id: string
  /** Directory the file sits in (a checked write is rooted here). */
  dir: string
  /** File name inside `dir`. */
  name: string
  absPath: string
}

async function listAgentsInDir(dir: string, fs: InstructionFs): Promise<MarkdownAgentPath[]> {
  let names: string[]
  try {
    names = await fs.readDir(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.toLowerCase().endsWith(".md"))
    .sort()
    .map((name) => ({ id: kebabId(basename(name)), dir, name, absPath: joinPath(dir, name) }))
}

export interface DiscoverAgentsInput {
  roots: string[]
  /** Optional already-resolved global agents directory (e.g. `~/.cognia/agents`). */
  globalAgentsDir?: string
  fs: InstructionFs
}

/** Agent directories in load order: global, non-primary roots, primary root last. */
function agentDirs(input: Omit<DiscoverAgentsInput, "fs">): string[] {
  const dirs: string[] = []
  if (input.globalAgentsDir) dirs.push(input.globalAgentsDir)
  for (const root of [...input.roots].reverse()) {
    if (root) dirs.push(joinPath(root, PROJECT_AGENTS_DIR))
  }
  return dirs
}

/**
 * Every agent definition file in load order, without reading it. The agent
 * configuration read model (`lib/agent-config/`) lists and edits these files;
 * the send path reads them through {@link discoverMarkdownAgentFiles}, which
 * walks the same directories in the same order.
 */
export async function discoverMarkdownAgentPaths(
  input: DiscoverAgentsInput
): Promise<MarkdownAgentPath[]> {
  const paths: MarkdownAgentPath[] = []
  for (const dir of agentDirs(input)) {
    paths.push(...(await listAgentsInDir(dir, input.fs)))
  }
  return paths
}

export async function discoverMarkdownAgentFiles(
  input: DiscoverAgentsInput
): Promise<MarkdownAgentFile[]> {
  // global first, then non-primary roots, then primary root LAST (primary wins).
  const files: MarkdownAgentFile[] = []
  for (const path of await discoverMarkdownAgentPaths(input)) {
    try {
      const content = await input.fs.readText(path.absPath)
      files.push({ id: path.id, content })
    } catch {
      // skip unreadable file
    }
  }
  return files
}
