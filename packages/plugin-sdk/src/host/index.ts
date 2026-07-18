/**
 * @deprecated Monorepo-only compatibility surface for host implementations.
 * Capability-specific host modules remain under `src/api/*`; neither this
 * entry nor those sources are included in the npm tarball.
 */

export { runPkceAuthFlow } from "@/lib/plugin/auth/auth-pkce-flow"
export { __makeSession } from "@/lib/plugin/auth/auth-provider-registry"
export { createPiiRedactionGate } from "@/lib/plugin/agent-sdk/pii-gate"
export { createPiiOutputGuardrail } from "@/lib/plugin/agent-sdk/guardrails"
export { executeCliTool } from "@/lib/plugin/cli-tools/execute-cli-tool"
