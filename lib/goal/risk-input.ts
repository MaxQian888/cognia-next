/**
 * /goal adapter for the risk classifier — projects a goal's objective plus its
 * session posture onto the transport-agnostic `RiskInput` that `lib/policy/risk`
 * consumes. The /goal counterpart of `lib/ai/agent/team/risk-input.ts`.
 *
 * **Honest limitation (ADR-0070 Phase 2).** A goal has no roster. The only
 * signals available at creation time are the redacted objective text and the
 * session's *configured* posture — which is weaker than Agent Team's, where the
 * roster names its tools outright. The strongest signal (what the goal actually
 * calls, turn by turn) needs per-turn tool-call interception, which is
 * deliberately out of scope here.
 *
 * Two consequences worth stating plainly:
 *
 *  1. Evidence is drawn from **explicit configuration only** — an operator
 *     turning on `builtinTools.process`, allow-listing `bash`, or enabling
 *     computer-use. It deliberately does NOT infer "the Anthropic SDK ships a
 *     native Bash tool, therefore every goal can shell out". That inference is
 *     technically true and useless: it would classify *every* goal on the
 *     default path as high risk, gate all of them, and teach operators to switch
 *     `riskGating` off — losing the real signal along with the noise. The
 *     SDK-native tools stay covered by the existing per-call permission gate.
 *  2. The classifier reads the **redacted** objective (`safeObjective`), never
 *     the raw text. Redaction replaces names/entities, not verbs, so the
 *     destructive-intent signal survives it intact.
 */

import type { AppSettings, Character } from "@cognia/agent-config-types"
import type { RiskInput } from "@/lib/policy/risk/classify-risk"

export interface BuildGoalRiskInputParams {
  /** The redacted objective — never the raw text. */
  safeObjective: string
  /** The goal's character, when it resolves to one. */
  character?: Character | null
  /** Settings snapshot the goal was created against. */
  appSettings?: AppSettings | null
}

/**
 * Builtin-tool suites an operator can switch on, and the concrete tool ids each
 * one surfaces that the classifier judges. Ids match
 * `lib/settings/builtin-tools-data.json`; suites with no risky ids (git, lsp,
 * codeGraph, environment, …) are intentionally absent rather than mapped to an
 * empty list — a suite appearing here is a claim that it carries risk.
 */
const BUILTIN_SUITE_TOOL_IDS: Record<string, string[]> = {
  coreFiles: ["bash", "write", "edit", "multi_edit"],
  process: ["start_process", "terminate_process"],
  shellAdvanced: ["shell_execute_advanced"],
  terminalRepl: ["terminal_repl_spawn", "terminal_repl_write", "terminal_repl_kill"],
  fileExtras: ["file_append", "file_binary_write"],
}

/**
 * Build the classifier input for a goal.
 *
 * Sandbox posture follows the documented cascade for chat sessions:
 * `Character.sandboxEnabled` beats `AppSettings.sandboxDefaultEnabled`
 * (`ChatSession.sandboxEnabled` would win over both, but a goal is created
 * against a character + settings, not a resolved per-send session).
 */
export function buildGoalRiskInput({
  safeObjective,
  character,
  appSettings,
}: BuildGoalRiskInputParams): RiskInput {
  const toolIds = new Set<string>()
  const capabilityIds = new Set<string>()

  // Explicit per-character allowlist — the operator named these tools.
  for (const id of character?.allowedTools ?? []) toolIds.add(id)

  // Soft-binding flags that attach a whole native tool family.
  if (character?.enableComputerUse === true) toolIds.add("computer_use")

  // Operator-enabled builtin suites.
  const builtin = appSettings?.builtinTools as Record<string, unknown> | undefined
  if (builtin) {
    for (const [suite, ids] of Object.entries(BUILTIN_SUITE_TOOL_IDS)) {
      if (builtin[suite] === true) for (const id of ids) toolIds.add(id)
    }
  }

  for (const id of character?.mcpServerIds ?? []) capabilityIds.add(id)
  for (const id of character?.skillIds ?? []) capabilityIds.add(id)

  // A tool the operator explicitly denied cannot be evidence of anything.
  for (const id of character?.disallowedTools ?? []) toolIds.delete(id)

  return {
    objective: safeObjective,
    taskDescriptions: [],
    toolIds: [...toolIds],
    capabilityIds: [...capabilityIds],
    sandboxEnabled: character?.sandboxEnabled ?? appSettings?.sandboxDefaultEnabled ?? false,
  }
}
