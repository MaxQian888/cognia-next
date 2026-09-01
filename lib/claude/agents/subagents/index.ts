/**
 * How the host's own subagents reach a turn.
 *
 * WHICH agents ship is not decided here. That list is
 * `lib/agent/builtin-catalog` (ADR-0161), shared with the CLI so `Explore` and
 * `Plan` stop being two different agents wearing one name. This module owns the
 * projections: which surface gets which entry, how a plugin subagent and a user
 * template are namespaced beside them, and which precedence wins on a collision.
 *
 * Each projected entry matches the `AgentDefinition` shape declared at
 * `sidecar/.../claude-agent-sdk/sdk.d.ts:38` and is passed to the SDK via
 * `SendOptions.agents`, keyed by the value the dispatcher uses to invoke it.
 */

export { workflowDesignerAgent } from "./workflow-designer"
export { workflowDebuggerAgent } from "./workflow-debugger"
export { workflowRefactorerAgent } from "./workflow-refactorer"
export { workflowDocWriterAgent } from "./workflow-doc-writer"
export type { AgentDefinition } from "./types"

import {
  BUILTIN_AGENT_IDS,
  builtinAgentDefinition,
  builtinAgentsForSurface,
} from "@/lib/agent/builtin-catalog/catalog"
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
  return nativeAgentsForSurface("workflow-editor")
}

/** The catalog entries one session surface injects, as an SDK agents map. */
function nativeAgentsForSurface(
  surface: "workflow-editor" | "team"
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const entry of builtinAgentsForSurface(surface)) {
    out[entry.id] = builtinAgentDefinition(entry) as unknown as Record<string, unknown>
  }
  return out
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
 * The dispatcher id a user template is addressed by.
 *
 * A template whose name slugifies onto a built-in's id CLAIMS that id and the
 * built-in steps aside, which is the precedence rule ADR-0161 froze: a built-in
 * is a default you can replace, and naming your own agent `Explore` should
 * replace `Explore` rather than sit next to it under a second name. Plugin ids
 * stay namespaced under `<pluginId>:` because namespace isolation there is a
 * security property, not a naming convention.
 *
 * Everything else keeps the `template:` prefix so it cannot collide by accident.
 */
function projectedTemplateId(name: string): string {
  const slug = slugifySubagentName(name)
  const shadowed = BUILTIN_AGENT_IDS.find((id) => slugifySubagentName(id) === slug)
  return shadowed ?? `template:${slug}`
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
  return { id: projectedTemplateId(tpl.name), def }
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
/**
 * ADR-0090 Phase 7 (delegation-mode): a NATIVE (SDK Task) subagent runs
 * inside the parent's process and inherits its route/provider/credential —
 * only a frozen model role may differ. A def that pins a DIFFERENT provider
 * or an external backing therefore may NOT ride the native agents map: the
 * SDK would silently run it on the parent's runtime, ignoring the pinned
 * intent. Such defs stay reachable through the orchestrated `dispatch_agent`
 * rail, which honors them.
 */
function isNativeDelegationEligible(def: {
  provider?: string
  externalPresetId?: string
}): boolean {
  return !def.provider && !def.externalPresetId
}

export function resolveAllSubagents(opts: {
  context: "workflow-editor" | "team" | "direct"
}): Record<string, Record<string, unknown>> {
  if (opts.context === "direct") {
    const result: Record<string, Record<string, unknown>> = {}
    for (const entry of listSubagentEntries()) {
      if (entry.entry.disabled) continue
      if (!isNativeDelegationEligible(entry.entry)) continue
      const { id, def } = projectPluginSubagent(entry)
      result[id] = def
    }
    for (const tpl of Object.values(useSubagentRuntimeStore.getState().templates)) {
      if (tpl.isBuiltIn || tpl.disabled) continue
      if (!isNativeDelegationEligible(tpl.config ?? {})) continue
      const { id, def } = projectSubagentTemplate(tpl)
      result[id] = def
    }
    return result
  }
  if (opts.context === "workflow-editor") {
    return nativeAgentsForSurface("workflow-editor")
  }
  // Team context: the catalog's team surface, unioned with plugin entries.
  const result: Record<string, Record<string, unknown>> = nativeAgentsForSurface("team")
  for (const entry of listSubagentEntries()) {
    if (entry.entry.disabled) continue
    if (!isNativeDelegationEligible(entry.entry)) continue
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

/**
 * Project the catalog's `dispatch` surface into dispatchable defs so
 * `dispatch_agent` can target them directly, not only via `SendOptions.agents`
 * in workflow-editor and team sessions. They keep their bare dispatcher ids (no
 * `<pluginId>:` or `template:` prefix) and stay leaves (`allowNesting`
 * omitted). The dispatcher self-selects by `description`, so a general chat will
 * not pick a workflow-specific agent unless the task fits.
 */
function builtInDispatchableSubagents(): Array<{ id: string; def: PluginSubagentDef }> {
  return builtinAgentsForSurface("dispatch").map((entry) => {
    const def = builtinAgentDefinition(entry)
    return {
      id: entry.id,
      def: {
        id: entry.id,
        name: entry.name,
        description: def.description,
        prompt: def.prompt,
        ...(def.tools ? { tools: def.tools } : {}),
        ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
      },
    }
  })
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
  // A user template that claimed a built-in's id replaces it rather than racing
  // it, so the built-in is dropped before the template is appended.
  const shadowedIds = new Set(
    Object.values(useSubagentRuntimeStore.getState().templates)
      .filter((tpl) => !tpl.isBuiltIn && !tpl.disabled)
      .map((tpl) => projectedTemplateId(tpl.name))
  )
  const out: Array<{ id: string; def: PluginSubagentDef }> = builtInDispatchableSubagents().filter(
    (x) => !x.def.disabled && !shadowedIds.has(x.id)
  )
  for (const entry of listSubagentEntries()) {
    if (entry.entry.disabled) continue
    const id = entry.pluginId ? `${entry.pluginId}:${entry.id}` : entry.id
    out.push({ id, def: { ...entry.entry, id } })
  }
  for (const tpl of Object.values(useSubagentRuntimeStore.getState().templates)) {
    if (tpl.isBuiltIn || tpl.disabled) continue
    const id = projectedTemplateId(tpl.name)
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
