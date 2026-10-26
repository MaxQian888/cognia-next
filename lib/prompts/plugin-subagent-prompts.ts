/**
 * The prompt of a plugin-contributed subagent as a Prompt Center slot
 * (ADR-0236 §5.1).
 *
 * A plugin subagent has no user-owned record to copy into without loss (a
 * subagent template cannot carry `effort` or `disallowedTools`), so its prompt
 * is a namespaced override slot, `plugin:<pluginId>/subagent.<id>`, and every
 * other field of the definition stays the plugin's. The subagent capability
 * registers the slot next to the subagent and drops it with it; both
 * delegation rails read the prompt through `resolvePluginSubagentPrompt`.
 *
 * Delegation resolves without a workspace, so only an account override is
 * offered. A definition whose own prompt would not pass the Prompt Center's
 * checks (a stray `{{`, an over-long body, personal data) gets no slot and
 * runs exactly as shipped.
 */

import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import { loggers } from "@cognia/logging"
import {
  getPluginPromptEntry,
  pluginPromptId,
  registerPluginPrompts,
  unregisterPluginPrompts,
} from "./plugin-prompts"
import { resolvePrompt } from "./resolve"

const LOCAL_PREFIX = "subagent."
const CONSUMER = "lib/claude/agents/subagents/index.ts"

function localIdOf(subagentId: string): string {
  return `${LOCAL_PREFIX}${subagentId}`
}

/** Register the slot for one accepted plugin subagent; returns its disposer. */
export function registerPluginSubagentPrompt(pluginId: string, def: PluginSubagentDef): () => void {
  try {
    return registerPluginPrompts(
      pluginId,
      [
        {
          id: localIdOf(def.id),
          title: def.name,
          ...(def.description ? { description: def.description } : {}),
          defaultBody: def.prompt,
        },
      ],
      CONSUMER,
      { scopes: ["account"] }
    )
  } catch (error) {
    loggers.plugin.warn("plugin subagent prompt is not overridable", {
      pluginId,
      subagentId: def.id,
      err: String(error),
    })
    return () => undefined
  }
}

/** Drop every subagent slot of a plugin, leaving its other prompts. */
export function unregisterPluginSubagentPrompts(pluginId: string): void {
  unregisterPluginPrompts(pluginId, LOCAL_PREFIX)
}

/** The prompt a delegation sends for a plugin subagent: an account override, else its own. */
export function resolvePluginSubagentPrompt(
  pluginId: string | undefined,
  def: PluginSubagentDef
): string {
  if (!pluginId) return def.prompt
  const entry = getPluginPromptEntry(pluginPromptId(pluginId, localIdOf(def.id)))
  // A slot registered for a different text (a re-registered definition) is not this one.
  if (!entry || entry.def.defaultBody !== def.prompt) return def.prompt
  return resolvePrompt(entry.def).text
}
