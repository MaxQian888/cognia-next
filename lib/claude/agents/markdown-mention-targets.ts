/**
 * Project markdown subagents (`.cognia/agents/*.md` + the global agents dir)
 * as chat `@`-mention targets.
 *
 * These agents are ALREADY dispatched at send time — `build-options.ts` merges
 * `markdownAgentsToSdkMap(...)` into `opts.agents`. But they were never offered
 * as `@`-mention targets, and `resolveTargetAgentId` resolved only against
 * `buildChatMentionTargets()` (built-ins + plugins + templates), so a markdown
 * `@`-mention could never route. This module is the SHARED projection used by
 * BOTH the picker hook (`use-markdown-chat-agents.ts`) and the send-time
 * resolver (`use-claude-chat.ts:buildSendOptions`) so the two never drift.
 *
 * The markdown agent id is the kebab filename — the same key
 * `markdownAgentsToSdkMap` uses — so `handle === id` round-trips 1:1 with the
 * registered agent map. Discovery only depends on the workspace `roots`
 * (+ the global agents dir), never the cwd (see `discoverMarkdownAgentFiles`).
 */

import { buildMarkdownAgents, type MarkdownAgentFile } from "@/lib/claude/agents/markdown-agents"
import type { SubagentMentionTarget } from "@/lib/claude/agents/chat-mention-targets"

/** "code-reviewer" → "Code Reviewer" (AgentDefinition carries no display name). */
function humanizeId(id: string): string {
  return (
    id
      .split(/[-_]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") || id
  )
}

/** Pure projection of parsed markdown agent files → mention targets. */
export function markdownAgentTargets(files: MarkdownAgentFile[]): SubagentMentionTarget[] {
  const { agents } = buildMarkdownAgents(files)
  return Object.entries(agents).map(([id, def]) => ({
    id,
    name: humanizeId(id),
    description: def.description,
    model: def.model,
    // id is already kebab (no whitespace) and === the SDK agent-map key.
    handle: id,
  }))
}

/**
 * Discover + project markdown agents for a session. Returns `[]` off-Tauri or
 * when no workspace roots / global agents exist. Cheap on repeat calls —
 * `loadProjectInstructions` memoises by `{cwd, roots, config}` for 3s.
 */
export async function discoverMarkdownAgentTargets(input: {
  cwd?: string
  roots: string[]
}): Promise<SubagentMentionTarget[]> {
  try {
    const { loadProjectInstructions } = await import("@/lib/claude/instructions/load")
    const { markdownAgentFiles } = await loadProjectInstructions({
      cwd: input.cwd,
      roots: input.roots,
    })
    return markdownAgentTargets(markdownAgentFiles)
  } catch {
    // Discovery is best-effort: a failure must never block a send or the picker.
    return []
  }
}
