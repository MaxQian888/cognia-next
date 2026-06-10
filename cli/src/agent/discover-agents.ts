/**
 * Discover `.cognia/agents/*.md` subagent definitions from disk and parse them
 * into dispatchable defs, reusing the desktop's `buildMarkdownAgents` parser.
 * Mirrors the Claude-Code `.claude/agents` convention; the file fs is injectable
 * for tests and defaults to a Node adapter.
 */
import nodeFs from "node:fs/promises"
import path from "node:path"

import { buildMarkdownAgents, type MarkdownAgentFile } from "@/lib/claude/agents/markdown-agents"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"

/** The minimal fs surface discovery needs (matches `InstructionFs`). */
export interface AgentFs {
  exists(path: string): Promise<boolean>
  readDir(path: string): Promise<string[]>
  readText(path: string): Promise<string>
}

const defaultFs: AgentFs = {
  async exists(p) {
    try {
      await nodeFs.access(p)
      return true
    } catch {
      return false
    }
  },
  async readDir(p) {
    try {
      return await nodeFs.readdir(p)
    } catch {
      return []
    }
  },
  readText: (p) => nodeFs.readFile(p, "utf8"),
}

/** Collect agent markdown files from each root's `.cognia/agents` dir. First
 * root wins on an id collision (project overrides global). */
export async function discoverAgentFiles(
  roots: string[],
  fs: AgentFs = defaultFs
): Promise<MarkdownAgentFile[]> {
  const byId = new Map<string, MarkdownAgentFile>()
  for (const root of roots) {
    const dir = path.join(root, ".cognia", "agents")
    if (!(await fs.exists(dir))) continue
    const names = await fs.readDir(dir)
    for (const name of names) {
      if (!name.endsWith(".md")) continue
      const id = name.slice(0, -3)
      if (byId.has(id)) continue
      try {
        byId.set(id, { id, content: await fs.readText(path.join(dir, name)) })
      } catch {
        // unreadable file — skip
      }
    }
  }
  return [...byId.values()]
}

export interface AgentSummary {
  id: string
  name: string
  description: string
  def: PluginSubagentDef
}

/** Parse discovered files into `{ id, name, description, def }` rows. */
export function buildAgents(files: MarkdownAgentFile[]): AgentSummary[] {
  const { agents } = buildMarkdownAgents(files)
  return Object.entries(agents).map(([name, def]) => ({
    id: name,
    name,
    description: def.description ?? "",
    def: {
      id: name,
      name,
      description: def.description ?? "",
      prompt: def.prompt ?? "",
      ...(def.tools ? { tools: def.tools } : {}),
      ...(def.model ? { model: def.model } : {}),
    },
  }))
}
