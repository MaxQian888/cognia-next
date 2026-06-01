/**
 * Renderer glue between a `permission_request` tool call and the Auto-mode
 * orchestrator (`auto-mode.ts`). Kept separate from the chat hook so it stays
 * pure (no React, no store reach-through) and unit-testable: the hook builds
 * the LLM client + reads settings, hands them here, and acts on the returned
 * decision.
 */

import type { AppSettings } from "@/lib/claude/types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { extractCommand } from "./command-from-tool"
import { evaluateAutoDecision, type AutoDecision, type AutoModeConfig } from "./auto-mode"
import type { Ruleset } from "./ruleset"

export interface RunAutoModeArgs {
  toolName: string
  input: unknown
  settings: AppSettings | null | undefined
  /** Background model client (already built by the caller); null disables the model tier. */
  client: LlmClient | null
  cwd?: string
  locale?: string
  /** Plugin-contributed command rulesets (lower precedence than user rules). */
  pluginRules?: Ruleset[]
}

/**
 * Evaluate Auto-mode for a tool call. Returns `null` when Auto-mode does not
 * apply (non-shell tool, or the master switch is off) so the caller proceeds
 * with the normal approval flow. Otherwise returns the allow/ask/deny
 * decision.
 */
export async function runAutoModeForTool({
  toolName,
  input,
  settings,
  client,
  cwd,
  locale,
  pluginRules = [],
}: RunAutoModeArgs): Promise<AutoDecision | null> {
  const command = extractCommand(toolName, input)
  if (command == null) return null

  const auto = settings?.agentPermissions?.autoApprove
  if (!auto?.enabled) return null

  const config: AutoModeConfig = {
    enabled: true,
    mode: auto.mode ?? "rules",
    denyOnHighRisk: auto.denyOnHighRisk ?? true,
  }

  // User command rules outrank plugin rules (last in the low→high array wins).
  const userRules = settings?.agentPermissions?.commandRules
  const rules: Ruleset[] = [...pluginRules]
  if (userRules && Object.keys(userRules).length > 0) rules.push({ Bash: userRules })

  return evaluateAutoDecision({ command, config, rules, client, cwd, locale })
}
