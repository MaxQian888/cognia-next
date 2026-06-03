/**
 * Subagents bundled with the host (Phase C.5).
 *
 * Each entry exports an `AgentDefinition` matching the shape declared
 * at `sidecar/.../claude-agent-sdk/sdk.d.ts:38`. They are passed to the
 * SDK via `SendOptions.agents` (keyed by the value the dispatcher
 * agent uses to invoke them).
 *
 * Workflow-editor sessions get all four loaded automatically via
 * `resolveSendOptions` (see `lib/claude/build-options.ts`). Team sessions
 * load the same built-ins PLUS any plugin-contributed subagents from the
 * `subagent-registry` overlay (see `lib/plugin/registries/subagent-registry.ts`).
 */

export { workflowDesignerAgent } from "./workflow-designer"
export { workflowDebuggerAgent } from "./workflow-debugger"
export { workflowRefactorerAgent } from "./workflow-refactorer"
export { workflowDocWriterAgent } from "./workflow-doc-writer"
export type { AgentDefinition } from "./types"

import { workflowDesignerAgent } from "./workflow-designer"
import { workflowDebuggerAgent } from "./workflow-debugger"
import { workflowRefactorerAgent } from "./workflow-refactorer"
import { workflowDocWriterAgent } from "./workflow-doc-writer"
import { listSubagentEntries } from "@/lib/plugin/registries/subagent-registry"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { SubAgentTemplate } from "@/types/agent/sub-agent"

/**
 * Single map keyed by the dispatcher-agent name (lowercase-with-dashes)
 * so the build-options branch can spread it directly into
 * `SendOptions.agents` (typed `Record<string, Record<string, unknown>>`
 * upstream by claude-agent-sdk).
 *
 * Used by the workflow-editor session injection in `resolveSendOptions`.
 */
export function workflowEditorSubagents(): Record<string, Record<string, unknown>> {
  return {
    "workflow-designer": workflowDesignerAgent as unknown as Record<string, unknown>,
    "workflow-debugger": workflowDebuggerAgent as unknown as Record<string, unknown>,
    "workflow-refactorer": workflowRefactorerAgent as unknown as Record<string, unknown>,
    "workflow-doc-writer": workflowDocWriterAgent as unknown as Record<string, unknown>,
  }
}

/**
 * Project a plugin subagent def into the Claude SDK `AgentDefinition`
 * shape. The runtime id is `<pluginId>:<id>` so plugin subagents cannot
 * collide with the bare built-in dispatcher names.
 */
function projectPluginSubagent(entry: {
  id: string
  entry: PluginSubagentDef
  pluginId?: string
}): { id: string; def: Record<string, unknown> } {
  const def: Record<string, unknown> = {
    description: entry.entry.description,
    prompt: entry.entry.prompt,
  }
  if (entry.entry.tools) def.tools = entry.entry.tools
  if (entry.entry.disallowedTools) def.disallowedTools = entry.entry.disallowedTools
  if (entry.entry.model) def.model = entry.entry.model
  if (entry.entry.maxTurns !== undefined) def.maxTurns = entry.entry.maxTurns
  if (entry.entry.effort) def.effort = entry.entry.effort
  // Anonymous plugins (no pluginId tag) are still legal — emit the bare id
  // so the dispatcher can address them, but flag the empty namespace
  // segment so a malicious plugin cannot masquerade as another's id.
  const id = entry.pluginId ? `${entry.pluginId}:${entry.id}` : entry.id
  return { id, def }
}

function slugifySubagentName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "subagent"
  )
}

/**
 * Project a user `SubAgentTemplate` (imported via the subagent-importers or
 * authored in Settings) into the Claude SDK `AgentDefinition` shape. The
 * dispatcher id is namespaced under `template:` so it cannot collide with the
 * bare built-in dispatcher names (workflow-*) or plugin ids (`<pluginId>:<id>`).
 */
function projectSubagentTemplate(tpl: SubAgentTemplate): {
  id: string
  def: Record<string, unknown>
} {
  const def: Record<string, unknown> = {
    description: tpl.description,
    prompt: tpl.config.systemPrompt ?? tpl.taskTemplate ?? tpl.description,
  }
  if (tpl.config.tools) def.tools = tpl.config.tools
  if (tpl.config.model) def.model = tpl.config.model
  if (tpl.config.maxSteps !== undefined) def.maxTurns = tpl.config.maxSteps
  return { id: `template:${slugifySubagentName(tpl.name)}`, def }
}

/**
 * Surface every subagent visible to a given session context.
 *
 * - `"workflow-editor"`: 4 built-in workflow-* subagents only. Plugins
 *   contributing subagents that should appear here can still ride
 *   `"team"` resolution because workflow-editor surfaces are deliberately
 *   scope-clamped to host primitives.
 * - `"team"`: 4 built-in workflow-* subagents UNIONED with every plugin-
 *   registered subagent. Plugin ids are namespaced as `<pluginId>:<id>`
 *   to avoid clashing with built-in dispatcher names.
 * - `"direct"`: the user's OWN subagents — every plugin-registered subagent
 *   UNIONED with user-authored / imported templates (`isBuiltIn !== true`).
 *   The workflow-* built-ins (editor-specific) and the seeded built-in
 *   templates (Settings starting points) are deliberately NOT auto-injected
 *   into every direct-chat turn.
 */
export function resolveAllSubagents(opts: {
  context: "workflow-editor" | "team" | "direct"
}): Record<string, Record<string, unknown>> {
  if (opts.context === "direct") {
    const result: Record<string, Record<string, unknown>> = {}
    for (const entry of listSubagentEntries()) {
      const { id, def } = projectPluginSubagent(entry)
      result[id] = def
    }
    for (const tpl of Object.values(useSubagentRuntimeStore.getState().templates)) {
      if (tpl.isBuiltIn) continue
      const { id, def } = projectSubagentTemplate(tpl)
      result[id] = def
    }
    return result
  }
  const builtIn = workflowEditorSubagents()
  if (opts.context === "workflow-editor") {
    return builtIn
  }
  // Team context — union with plugin entries.
  const result: Record<string, Record<string, unknown>> = { ...builtIn }
  for (const entry of listSubagentEntries()) {
    const { id, def } = projectPluginSubagent(entry)
    result[id] = def
  }
  return result
}

/**
 * Enumerate every subagent id visible in a team context. Used by the
 * agent-team-template-registry to validate `requires.subagentIds[]`
 * lookups without loading the full def map.
 */
export function listAllTeamSubagentIds(): string[] {
  return Object.keys(resolveAllSubagents({ context: "team" }))
}
