/**
 * Plugin Agent SDK — input/output guardrails (ADR-0026 §Agent-SDK).
 *
 * Guardrails are validators that run AROUND a plugin agent run: input
 * guardrails before the turn (validate the prompt), output guardrails after
 * (validate the final text). A guardrail that trips its tripwire aborts the run
 * with a typed error. Mirrors the OpenAI Agents SDK guardrail primitive and
 * generalizes the PII gate.
 *
 * Dependency-free leaf. The runtime in `lib/plugin/agent-sdk/guardrails.ts`
 * executes these around `runPluginAgent` / `runPluginAgentStreamed`; the
 * `lib/plugin/registries/guardrail-registry.ts` overlay stores reusable ones a
 * plugin registers via `ctx.agent.guardrails`.
 */

/** Outcome of a guardrail check. `tripwireTriggered` aborts the run. */
export interface PluginGuardrailResult {
  tripwireTriggered: boolean
  /** Human-readable reason surfaced on the thrown tripwire error. */
  message?: string
  /** Free-form metadata for telemetry / debugging. */
  metadata?: Record<string, unknown>
}

/** Context handed to an input guardrail (before the turn runs). */
export interface PluginInputGuardrailContext {
  prompt: string
  signal?: AbortSignal
}

/** Context handed to an output guardrail (after the final text is produced). */
export interface PluginOutputGuardrailContext {
  prompt: string
  output: string
  signal?: AbortSignal
}

/** A guardrail that validates the prompt before the run. */
export interface PluginInputGuardrail {
  id: string
  name?: string
  type: "input"
  run: (ctx: PluginInputGuardrailContext) => PluginGuardrailResult | Promise<PluginGuardrailResult>
}

/** A guardrail that validates the final output after the run. */
export interface PluginOutputGuardrail {
  id: string
  name?: string
  type: "output"
  run: (ctx: PluginOutputGuardrailContext) => PluginGuardrailResult | Promise<PluginGuardrailResult>
}

export type PluginGuardrail = PluginInputGuardrail | PluginOutputGuardrail

/**
 * Plugin-facing guardrail registry surface (`ctx.agent.guardrails`). Registered
 * guardrails are reusable: a run opts into them by id via
 * `PluginAgentRunOptions.guardrails` (alongside inline guardrail objects).
 */
export interface PluginAgentGuardrailsAPI {
  /** Register a reusable guardrail (plugin-scoped; dropped on disable). */
  register: (guardrail: PluginGuardrail) => void
  /** Drop a previously-registered guardrail by id. */
  unregister: (id: string) => void
  /** List registered guardrail ids. */
  list: () => string[]
}
