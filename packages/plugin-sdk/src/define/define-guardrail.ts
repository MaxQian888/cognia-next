/**
 * Plugin SDK helper for agent guardrails (Package B).
 *
 * Pure typesafety pass-through — wrapping a guardrail in `defineGuardrail()`
 * gives plugin authors autocomplete and a compile-time check that the shape
 * matches `PluginGuardrail`.
 *
 * Usage:
 *   const noSecrets = defineGuardrail({
 *     id: "no-secrets",
 *     type: "output",
 *     run: ({ output }) => ({ tripwireTriggered: /sk-[a-z0-9]+/i.test(output) }),
 *   })
 */

import type { PluginGuardrail } from "@/types/plugin/plugin-agent-guardrails"

export function defineGuardrail(guardrail: PluginGuardrail): PluginGuardrail {
  return guardrail
}
