/**
 * Pure read-outs of what the dispatch layer will actually do with a template.
 *
 * The editor used to present every field as if it were independently
 * meaningful. Three of them are not, and the consequences were invisible:
 *
 *  - `config.systemPrompt` WINS over `taskTemplate`. The projector builds the
 *    prompt as `systemPrompt ?? taskTemplate ?? description`, so filling in a
 *    system prompt silently retires the task template and every variable
 *    declared for it.
 *  - Pinning a `provider` or an `externalPresetId` makes the template fail
 *    `isNativeDelegationEligible`, which removes it from the SDK `agents` map.
 *    It stays reachable only through `dispatch_agent` — which is itself only
 *    offered when nesting is enabled or the session is in plan mode
 *    (`build-options.ts`).
 *  - Built-in templates are never dispatched at all. Both resolvers skip
 *    `isBuiltIn`, so they are fork sources, not runnable subagents.
 *
 * Kept pure and separate from the panel so each rule is pinned by a test that
 * reads like the rule it encodes.
 */

import type { SubAgentTemplate } from "@/types/agent/sub-agent"

/** Which field the dispatcher will actually use as the system prompt. */
export type PromptSource = "systemPrompt" | "taskTemplate" | "description"

export function promptSource(
  template: Pick<SubAgentTemplate, "config" | "taskTemplate">
): PromptSource {
  if (template.config?.systemPrompt) return "systemPrompt"
  if (template.taskTemplate) return "taskTemplate"
  return "description"
}

/**
 * True when the user has authored a task template that will never be used
 * because a system prompt outranks it.
 */
export function taskTemplateOverridden(
  template: Pick<SubAgentTemplate, "config" | "taskTemplate">
): boolean {
  return Boolean(template.config?.systemPrompt) && Boolean(template.taskTemplate?.trim())
}

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g

/** Placeholder names referenced by a task template, in first-seen order. */
export function extractPlaceholders(taskTemplate: string | undefined): string[] {
  if (!taskTemplate) return []
  const seen = new Set<string>()
  for (const match of taskTemplate.matchAll(PLACEHOLDER)) {
    seen.add(match[1])
  }
  return [...seen]
}

export interface VariableDiagnostics {
  /** Used in the task template but not declared. */
  undeclared: string[]
  /** Declared but never referenced. */
  unused: string[]
}

export function variableDiagnostics(
  taskTemplate: string | undefined,
  variables: SubAgentTemplate["variables"]
): VariableDiagnostics {
  const used = extractPlaceholders(taskTemplate)
  const declared = (variables ?? []).map((v) => v.name.trim()).filter(Boolean)
  const declaredSet = new Set(declared)
  const usedSet = new Set(used)
  return {
    undeclared: used.filter((name) => !declaredSet.has(name)),
    unused: declared.filter((name) => !usedSet.has(name)),
  }
}

/**
 * `disabled`     — excluded from dispatch, discovery and every picker.
 * `fork-only`    — a seeded built-in: duplicate it to get something runnable.
 * `dispatch-only`— pinned off the parent's runtime, so only `dispatch_agent`
 *                  can run it.
 * `direct`       — offered to the model in ordinary chat.
 */
export type Reachability = "disabled" | "fork-only" | "dispatch-only" | "direct"

/** Mirrors `isNativeDelegationEligible` in `lib/claude/agents/subagents/index.ts`. */
export function nativeDelegationEligible(config: SubAgentTemplate["config"] | undefined): boolean {
  return !config?.provider && !config?.externalPresetId
}

export function reachability(
  template: Pick<SubAgentTemplate, "config" | "isBuiltIn" | "disabled">
): Reachability {
  if (template.disabled) return "disabled"
  if (template.isBuiltIn) return "fork-only"
  if (!nativeDelegationEligible(template.config)) return "dispatch-only"
  return "direct"
}

/**
 * A `dispatch-only` template is unreachable in practice unless the
 * `dispatch_agent` rail is actually offered. That happens when app-level
 * nesting is on, or the session is in plan mode.
 */
export function dispatchRailUnavailable(
  reach: Reachability,
  opts: { nestingEnabled: boolean }
): boolean {
  return reach === "dispatch-only" && !opts.nestingEnabled
}
