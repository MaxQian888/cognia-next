/**
 * Plugin SDK — guardrail authoring surface (Agent SDK).
 *
 * Re-exports the `defineGuardrail()` helper plugin authors use to declare an
 * input/output guardrail for the agent SDK runtime, plus the built-in PII
 * output guardrail factory. `defineGuardrail()` is a typesafe identity
 * pass-through narrowing to `PluginGuardrail`.
 *
 * Sources:
 *  - `packages/plugin-sdk/src/define/define-guardrail.ts`
 *  - `lib/plugin/agent-sdk/guardrails.ts`
 *  - `types/plugin/plugin-agent-guardrails.ts`
 */

export { defineGuardrail } from "../define/define-guardrail"

export { createPiiOutputGuardrail } from "@/lib/plugin/agent-sdk/guardrails"

export type { PluginGuardrail } from "@/types/plugin/plugin-agent-guardrails"
