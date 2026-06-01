/**
 * Agent command Auto-mode orchestrator.
 *
 * Decides — without a human in the loop — whether the agent's shell command
 * should run (`allow`), be blocked (`deny`), or fall through to the existing
 * approval modal (`ask`). It layers three sources, highest priority first:
 *
 *   1. **User / character / plugin rules** (OpenCode-style glob ruleset) — an
 *      explicit match wins outright (`resolveBashPermission`).
 *   2. **Deterministic classifier** (`classifyCommand`) — auto-allows safe
 *      read-only/dev commands and denies catastrophes, offline.
 *   3. **Small-model judge** (`judgeCommandSafety`) — only when the classifier
 *      is uncertain *and* the user opted into `rules+model`; turns an
 *      otherwise-`ask` command into allow/deny based on the model's risk band.
 *
 * Anything still uncertain resolves to `ask` — the safe default. This is the
 * brain behind the `permission_request` short-circuit in
 * `hooks/chat/use-claude-chat.ts`; it is pure given the injected client and so
 * fully unit-testable.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import { classifyCommand, type CommandVerdict } from "./command-safety"
import { judgeCommandSafety, type RiskLevel } from "./command-judge"
import { resolveBashPermission, type Ruleset } from "./ruleset"

export interface AutoModeConfig {
  /** Master switch for command Auto-mode. */
  enabled: boolean
  /** `rules` = classifier only; `rules+model` = also consult the small model. */
  mode: "rules" | "rules+model"
  /** When true, a model `high` risk verdict denies instead of prompting. */
  denyOnHighRisk: boolean
}

export type AutoDecisionSource = "user-rule" | "rule" | "model" | "default"

export interface AutoDecision {
  decision: CommandVerdict
  /** Which tier produced the decision (for the chat trace / audit). */
  source: AutoDecisionSource
  /** Short rationale (English; UI maps verdict→i18n for display). */
  reason: string
  /** Model risk band, when the model tier was consulted. */
  risk?: RiskLevel
  /** Head command that drove the verdict, when known. */
  matched?: string
}

export interface EvaluateAutoArgs {
  command: string
  config: AutoModeConfig
  /** Caller rulesets (low→high precedence). Highest authority when matched. */
  rules?: Ruleset[]
  /** Background model client for the `rules+model` tier (null disables it). */
  client?: LlmClient | null
  /** Workspace root — escalates allow→ask for paths that escape it. */
  cwd?: string
  /** UI locale forwarded to the model judge for its rationale. */
  locale?: string
}

const ASK_DEFAULT: AutoDecision = {
  decision: "ask",
  source: "default",
  reason: "requires confirmation",
}

/**
 * Resolve an Auto-mode decision for a command. Never throws — any failure in
 * the model tier degrades to the deterministic verdict (ultimately `ask`).
 */
export async function evaluateAutoDecision({
  command,
  config,
  rules = [],
  client,
  cwd,
  locale,
}: EvaluateAutoArgs): Promise<AutoDecision> {
  if (!config.enabled) return ASK_DEFAULT

  // 1. Explicit user/character/plugin rule wins outright.
  const ruled = resolveBashPermission(command, rules, { cwd })
  if (ruled.explicit) {
    return {
      decision: ruled.verdict,
      source: "user-rule",
      reason: "matched a configured command rule",
    }
  }

  // 2. Deterministic classifier — decisive on allow / deny.
  const cls = classifyCommand(command)
  if (cls.verdict === "allow" || cls.verdict === "deny") {
    return { decision: cls.verdict, source: "rule", reason: cls.reason, matched: cls.matched }
  }

  // 3. Uncertain (classifier said "ask"). Optionally consult the small model.
  if (config.mode === "rules+model" && client) {
    const judged = await judgeCommandSafety(client, command, { cwd, locale })
    if (judged) {
      if (judged.risk === "high") {
        return config.denyOnHighRisk
          ? { decision: "deny", source: "model", reason: judged.reason, risk: judged.risk }
          : { decision: "ask", source: "model", reason: judged.reason, risk: judged.risk }
      }
      if (judged.safe && judged.risk === "low") {
        return { decision: "allow", source: "model", reason: judged.reason, risk: judged.risk }
      }
      return { decision: "ask", source: "model", reason: judged.reason, risk: judged.risk }
    }
  }

  // 4. Safe default.
  return { decision: "ask", source: "rule", reason: cls.reason, matched: cls.matched }
}
