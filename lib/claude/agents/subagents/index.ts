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
export { exploreAgent } from "./explore"
export { planAgent } from "./plan"
export type { AgentDefinition } from "./types"

import { workflowDesignerAgent } from "./workflow-designer"
import { workflowDebuggerAgent } from "./workflow-debugger"
import { workflowRefactorerAgent } from "./workflow-refactorer"
import { workflowDocWriterAgent } from "./workflow-doc-writer"
import { exploreAgent } from "./explore"
import { planAgent } from "./plan"
import type { AgentDefinition } from "./types"
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
  if (entry.entry.externalPresetId) def.externalPresetId = entry.entry.externalPresetId
  if (entry.entry.mcpServerIds?.length) def.mcpServerIds = entry.entry.mcpServerIds
  if (entry.entry.hidden) def.hidden = true
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
  // External-CLI backing (A2): route this subagent to an external agent when the
  // template names a preset, so the dispatching model runs it on Claude Code /
  // Codex / … instead of the built-in executor.
  if (tpl.config.externalPresetId) def.externalPresetId = tpl.config.externalPresetId
  if (tpl.config.mcpServerIds?.length) def.mcpServerIds = tpl.config.mcpServerIds
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
      if (entry.entry.disabled) continue
      const { id, def } = projectPluginSubagent(entry)
      result[id] = def
    }
    for (const tpl of Object.values(useSubagentRuntimeStore.getState().templates)) {
      if (tpl.isBuiltIn || tpl.disabled) continue
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
    if (entry.entry.disabled) continue
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

/** Display labels for the host-bundled workflow-* built-ins. */
const BUILT_IN_DISPATCH_LABELS: Record<string, string> = {
  "workflow-designer": "Workflow Designer",
  "workflow-debugger": "Workflow Debugger",
  "workflow-refactorer": "Workflow Refactorer",
  "workflow-doc-writer": "Workflow Doc Writer",
  Explore: "Explore",
  Plan: "Plan",
}

/**
 * Project the 4 host-bundled workflow-* `AgentDefinition`s into dispatchable
 * defs so `dispatch_agent` can target them directly (not only via
 * `SendOptions.agents` in workflow-editor/team sessions). They keep their bare
 * dispatcher ids (no `<pluginId>:`/`template:` prefix) and stay leaves
 * (`allowNesting` omitted). The dispatcher self-selects by `description`, so a
 * general chat won't pick a workflow-specific agent unless the task fits.
 */
function builtInDispatchableSubagents(): Array<{ id: string; def: PluginSubagentDef }> {
  const builtins: Array<[string, AgentDefinition]> = [
    ["workflow-designer", workflowDesignerAgent],
    ["workflow-debugger", workflowDebuggerAgent],
    ["workflow-refactorer", workflowRefactorerAgent],
    ["workflow-doc-writer", workflowDocWriterAgent],
    ["Explore", exploreAgent],
    ["Plan", planAgent],
  ]
  return builtins.map(([id, a]) => ({
    id,
    def: {
      id,
      name: BUILT_IN_DISPATCH_LABELS[id] ?? id,
      description: a.description,
      prompt: a.prompt,
      ...(a.tools ? { tools: a.tools } : {}),
      ...(a.disallowedTools ? { disallowedTools: a.disallowedTools } : {}),
      ...(a.model ? { model: a.model } : {}),
      ...(a.maxTurns !== undefined ? { maxTurns: a.maxTurns } : {}),
      ...(a.effort ? { effort: a.effort } : {}),
      ...(a.hidden ? { hidden: true } : {}),
      ...(a.disabled ? { disabled: true } : {}),
    },
  }))
}

/**
 * Resolve the subagents the `dispatch_agent` host tool can target, as FULL
 * {@link PluginSubagentDef} objects keyed by their projected dispatcher id:
 * the 4 host-bundled workflow-* built-ins, UNIONED with plugin-registered
 * subagents and the user's own templates.
 *
 * Distinct from {@link resolveAllSubagents} (which returns the bare SDK
 * `AgentDefinition` map for `SendOptions.agents`): the nested-dispatch path
 * dispatches via an inline def — `getSubagent` can't resolve projected ids
 * (`<pluginId>:<id>`, `template:<slug>`) — so it needs the full def, including
 * the `allowNesting` / `maxDepth` fields that gate whether the dispatched child
 * may itself nest.
 */
export function resolveDispatchableSubagents(): Array<{ id: string; def: PluginSubagentDef }> {
  // `disabled` defs are excluded everywhere; `hidden` defs stay dispatchable
  // (UI pickers filter them out on their side — OpenCode semantics).
  const out: Array<{ id: string; def: PluginSubagentDef }> = builtInDispatchableSubagents().filter(
    (x) => !x.def.disabled
  )
  for (const entry of listSubagentEntries()) {
    if (entry.entry.disabled) continue
    const id = entry.pluginId ? `${entry.pluginId}:${entry.id}` : entry.id
    out.push({ id, def: { ...entry.entry, id } })
  }
  for (const tpl of Object.values(useSubagentRuntimeStore.getState().templates)) {
    if (tpl.isBuiltIn || tpl.disabled) continue
    const id = `template:${slugifySubagentName(tpl.name)}`
    out.push({
      id,
      def: {
        id,
        name: tpl.name,
        description: tpl.description,
        prompt: tpl.config.systemPrompt ?? tpl.taskTemplate ?? tpl.description,
        ...(tpl.config.tools ? { tools: tpl.config.tools } : {}),
        ...(tpl.config.model ? { model: tpl.config.model } : {}),
        ...(tpl.config.maxSteps !== undefined ? { maxTurns: tpl.config.maxSteps } : {}),
        // External-CLI backing (A2): a template naming a preset dispatches to
        // that external agent, with its declared MCP servers forwarded into the
        // ACP session. Without these two, `dispatch_agent` would silently route
        // the template to the built-in executor instead.
        ...(tpl.config.externalPresetId ? { externalPresetId: tpl.config.externalPresetId } : {}),
        ...(tpl.config.mcpServerIds?.length ? { mcpServerIds: tpl.config.mcpServerIds } : {}),
        ...(tpl.config.allowNesting ? { allowNesting: true } : {}),
        ...(tpl.config.maxNestingDepth !== undefined
          ? { maxDepth: tpl.config.maxNestingDepth }
          : {}),
        ...(tpl.hidden ? { hidden: true } : {}),
      },
    })
  }
  return out
}

/** Resolve a single dispatchable subagent def by its projected id. */
export function getDispatchableSubagentDef(id: string): PluginSubagentDef | undefined {
  return resolveDispatchableSubagents().find((x) => x.id === id)?.def
}
