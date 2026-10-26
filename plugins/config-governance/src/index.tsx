/**
 * Config Governance — built-in plugin (ADR-0238).
 *
 * Governs the agent configuration a user writes — repository instruction
 * files, markdown agent files, Skills, characters, templates and prompt
 * overrides — by answering three questions, each with its own evidence:
 *
 *   - Should this rule exist? An audit that adapts Anthropic's prompt-audit
 *     method (vendored, pinned, Apache-2.0): deterministic signals, a
 *     repository reference check and version-control dates feed a model
 *     judgment whose answer is validated, then cut into selectable hunks.
 *   - Is it followed? Rules about tool use become checks replayed over past
 *     sessions; a rule that is not followed can be adopted as a tool hook.
 *   - Did changing it help? Adherence before and after an applied change, and
 *     an eval dataset run as baseline and candidate.
 *
 * Everything goes through the public SDK: `ctx.agentConfig` reads surfaces
 * through their owners and writes with the user's per-surface confirmation,
 * and secret-bearing settings (hooks, MCP servers, permission rules) only ever
 * arrive as structural facts. Surfaces: a rail view, `/governance`, a palette
 * quick action, two read-only agent tools, a playbook skill, Prompt Center
 * slots for every model-facing text, tool hooks for adopted rules, and a
 * weekly drift check that is off until the user resumes it.
 */
import {
  definePlugin,
  definePluginManifest,
  type PluginContext,
  type PluginHooksAll,
  type PluginTaskResult,
} from "@cognia/plugin-sdk"

import { PLUGIN_ID } from "./model"
import { createGovernanceHost } from "./host"
import { GOVERNANCE_PROMPTS } from "./prompts"
import { setActiveRuntime } from "./runtime/active"
import { GovernanceRuntime } from "./runtime/runtime"
import { GOVERNANCE_SKILL } from "./skill"
import { handleGovernanceCommand } from "./slash"
import { createGovernanceTools } from "./tool"
import manifestJson from "../plugin.json"

export { GovernanceView } from "./ui/governance-view"

export const VIEW_CONTAINER_ID = "config-governance"
export const DRIFT_HANDLER = "governanceDrift"
export const COMMAND_ID = "governance"
export const OPEN_COMMAND_ID = "governance.open"

export const manifest = definePluginManifest({
  ...manifestJson,
  skills: [GOVERNANCE_SKILL],
})

export async function activateGovernance(ctx: PluginContext): Promise<GovernanceRuntime> {
  const runtime = new GovernanceRuntime(createGovernanceHost(ctx))
  setActiveRuntime(runtime)
  ctx.lifecycle.onDispose(() => {
    runtime.cancel()
    runtime.forgetSessions()
    setActiveRuntime(null)
  }, `${PLUGIN_ID}:runtime`)

  const prompts = ctx.prompts.register(GOVERNANCE_PROMPTS)
  ctx.lifecycle.onDispose(() => prompts.unregister(), `${PLUGIN_ID}:prompts`)

  const sessionWorkspace = async (sessionId: string) =>
    (await ctx.session.getSession(sessionId).catch(() => null))?.projectId ?? null
  for (const tool of createGovernanceTools(runtime, sessionWorkspace)) ctx.agent.registerTool(tool)

  ctx.lifecycle.onDispose(
    ctx.scheduler.registerHandler(DRIFT_HANDLER, async (): Promise<PluginTaskResult> => {
      try {
        const output = await runtime.driftCheck()
        return { success: true, output, metrics: { itemsProcessed: output.workspaces } }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }),
    `${PLUGIN_ID}:drift-handler`
  )

  await runtime.loadEnforcement()
  ctx.lifecycle.onDispose(
    ctx.configuration.onChange(() => {
      void runtime.loadEnforcement()
    }),
    `${PLUGIN_ID}:config`
  )
  return runtime
}

export default definePlugin({
  manifest,
  activate: async (ctx: PluginContext) => {
    const runtime = await activateGovernance(ctx)
    const sessionWorkspace = async (sessionId: string) =>
      (await ctx.session.getSession(sessionId).catch(() => null))?.projectId ?? null
    const openView = () => ctx.ui.openViewContainer(VIEW_CONTAINER_ID)
    // The tool-use hooks live on the full hook set the manager reads back from activation.
    const hooks: PluginHooksAll = {
      onCommand: async (command, args, context) => {
        if (command === OPEN_COMMAND_ID) {
          await openView()
          return true
        }
        if (command !== COMMAND_ID) return false
        return handleGovernanceCommand(
          { runtime, t: (key, params) => ctx.i18n.t(key, params), openView, sessionWorkspace },
          args,
          context
        )
      },
      onUserPromptSubmit: (_prompt, sessionId) => {
        runtime.onPrompt(sessionId)
        return { action: "proceed" as const }
      },
      onPreToolUse: async (toolName, toolArgs, sessionId) => {
        try {
          const denyReason = await runtime.preToolUse(toolName, toolArgs, sessionId)
          return denyReason ? { action: "deny" as const, denyReason } : { action: "allow" as const }
        } catch {
          // An enforcement failure must not take the user's tools down with it.
          return { action: "allow" as const }
        }
      },
      onPostToolUse: async (toolName, toolArgs, toolResult, sessionId) => {
        try {
          const modifiedResult = await runtime.postToolUse(
            toolName,
            toolArgs,
            toolResult,
            sessionId
          )
          return modifiedResult === undefined ? {} : { modifiedResult }
        } catch {
          return {}
        }
      },
    }
    return hooks
  },
})
