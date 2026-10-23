/**
 * The plugin contract's share of `lib/chat/template/launch-spec.ts`, which re-exports these.
 */
import type { ChatSession, SystemPromptPreset } from "@cognia/agent-config-types"

/**
 * Which repository a template expects.
 *
 * Both halves are stored on purpose. `projectId` is how it resolves instantly
 * on the machine that saved it; `gitRemote` is the only half that survives the
 * trip to another machine, because a workspace is identified in this codebase
 * by a LOCAL ABSOLUTE PATH and nothing else — there is no portable repository
 * identity to store. Neither is sufficient alone.
 */
export interface ChatTemplateWorkspaceRef {
  projectId?: string
  /** e.g. `git@github.com:acme/app.git` — the portable half. */
  gitRemote?: string
  branch?: string
}

export interface ChatTemplateLaunchSpec {
  // ── same shape as SystemPromptPreset ──────────────────────────────────────
  systemPrompt?: string
  model?: string
  permissionMode?: ChatSession["permissionMode"]
  effort?: SystemPromptPreset["effort"]
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServerIds?: string[]
  skillIds?: string[]
  agentModeId?: string | null
  workingDir?: string
  // ── the three a preset cannot express ─────────────────────────────────────
  /** The persona the conversation runs as. */
  characterId?: string
  /** The Squad (executor) the conversation runs on — ADR-0140. */
  squadId?: string
  workspace?: ChatTemplateWorkspaceRef
}
