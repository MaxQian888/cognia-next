/**
 * Plugin `ctx.prompts` API (ADR-0236 §3.2, §5.1).
 *
 * A plugin's model-facing wording is bundled with the plugin, and plugin code
 * cannot import the host's prompt resolver. This namespace is the versioned
 * contract between them:
 *
 * - `register` declares the plugin's prompts. Each becomes a Prompt Center
 *   slot `plugin:<pluginId>/<id>`; the host assigns every authority field
 *   (scopes, activation, risk) and refuses a default that fails its own
 *   contract. Registrations are dropped with the plugin.
 * - `resolve` returns the text to send for one of the plugin's own prompts:
 *   a published override for the session's workspace or the account, else
 *   the plugin's default, with `{{name}}` placeholders filled from `values`
 *   (each clipped to its declared budget). An override that no longer meets
 *   the declared contract (a bumped `contractVersion`, a missing fragment)
 *   is skipped, never sent.
 *
 * A plugin can only declare and resolve ids under its own namespace, so it
 * can neither read another plugin's prompt nor a shipped one. Neither method
 * needs a permission: the text is the plugin's own wording or the user's
 * edit of it, and it goes nowhere until the plugin sends it through a gated
 * API (`ctx.ai.chat` and the like).
 */

import { getDb } from "@/lib/db"
import { createPluginSystemLogger } from "@/lib/plugin/core/logger"
import {
  getPluginPromptEntry,
  pluginPromptId,
  registerPluginPrompts,
  type PluginPromptDeclaration,
} from "@/lib/prompts/plugin-prompts"
import { resolvePromptAsync } from "@/lib/prompts/resolve"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type { PluginPromptsAPI } from "@cognia/plugin-contract/lib/plugin/api/prompts-api"
export type {
  PluginPromptRegistration,
  PluginPromptResolveOptions,
  PluginPromptsAPI,
  PluginResolvedPrompt,
} from "@cognia/plugin-contract/lib/plugin/api/prompts-api"

export type { PluginPromptDeclaration }

/** Where a manifest-less plugin's prompts are consumed, for the detail view. */
function consumerOf(pluginId: string): string {
  return `plugin:${pluginId}`
}

async function workspaceOf(sessionId: string | undefined): Promise<string | undefined> {
  if (!sessionId) return undefined
  const session = await getDb().sessions.get(sessionId)
  return session?.projectId ?? undefined
}

export function createPromptsAPI(pluginId: string): PluginPromptsAPI {
  const logger = createPluginSystemLogger(pluginId)
  const api: PluginPromptsAPI = {
    register(declarations) {
      if (!Array.isArray(declarations)) {
        throw new Error("[prompts-api] register() takes an array of prompt declarations")
      }
      const unregister = registerPluginPrompts(pluginId, declarations, consumerOf(pluginId))
      const promptIds = declarations.map((declaration) => pluginPromptId(pluginId, declaration.id))
      logger.info(`[prompts] registered ${promptIds.length} prompt(s)`)
      return { promptIds, unregister }
    },
    async resolve(id, options = {}) {
      const entry = getPluginPromptEntry(pluginPromptId(pluginId, id))
      if (!entry || entry.pluginId !== pluginId) {
        throw new Error(`[prompts-api] prompt "${id}" is not registered by ${pluginId}`)
      }
      const workspaceId = await workspaceOf(options.sessionId)
      const resolved = await resolvePromptAsync(entry.def, {
        context: workspaceId ? { workspaceId } : {},
        ...(options.values ? { values: options.values } : {}),
      })
      return {
        text: resolved.text,
        source: resolved.source.kind === "override" ? "override" : "default",
      }
    },
  }
  return createGuardedAPI(pluginId, api, {}, { unguarded: ["register", "resolve"] })
}
