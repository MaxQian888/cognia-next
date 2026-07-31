/**
 * Plugin Agent SDK — embeddable agent runtime exposed to plugins via
 * `ctx.agent.run` / `ctx.agent.runStreamed`. See ADR-0026 §Agent-SDK.
 */

export { runPluginAgent, runPluginAgentStreamed, type RunPluginAgentMeta } from "./run"
export { createPluginAgentRun, type PluginAgentRunController } from "./stream"
export { createPiiRedactionGate, type PiiRedactionGateOptions } from "./pii-gate"
export {
  runInputGuardrails,
  runOutputGuardrails,
  createPiiOutputGuardrail,
  PluginGuardrailTripwireError,
} from "./guardrails"
export { dispatchSubagent, runTeam } from "./dispatch"
export { createPluginAgentSession, resumePluginAgentSession } from "./session"
export { resolveContextContributions, readSharedMemory, queryTwinMemory } from "./context-providers"
export {
  createPluginBudget,
  PluginBudgetExceededError,
  type PluginBudget,
  type PluginBudgetOptions,
} from "./budget"
export { withRunTrace, type RunTraceMeta } from "./tracing"
