/**
 * @cognia/agent — embed the Cognia coding agent in a Node process.
 *
 * One persistent session runtime — the same one behind `cognia-agent run`, the
 * TUI and the RPC server — with canonical streaming events, durable sessions
 * and a structured result contract.
 *
 * @example
 * ```ts
 * import { createCogniaRuntime } from "@cognia/agent"
 *
 * const runtime = await createCogniaRuntime({
 *   credential: { credentialEnv: "ANTHROPIC_API_KEY" },
 * })
 *
 * const session = await runtime.createSession({ name: "my-session" })
 * const result = await session.run("Write hello world in TypeScript")
 * console.log(result.text)
 *
 * await session.close()
 * await runtime.dispose()
 * ```
 *
 * @packageDocumentation
 */

// ---- Public types from the authority packages ----
export type {
  AgentRunResultV1,
  AgentStructuredError,
  AgentErrorCode,
  AgentRunStatus,
  AgentRunUsage,
  AgentSessionPersistence,
  AgentResumeReport,
  AgentExitCode,
} from "@cognia/agent-config-types/agent-run-result"
export type {
  AgentEventEnvelope,
  CanonicalAgentEvent,
  AgentCapabilityId,
  AgentRuntimeAdapterId,
  AgentExecutionPolicy,
  CanonicalContentPart,
} from "@cognia/agent-config-types/agent-execution"
export type { CanonicalSession, CanonicalTurn } from "@cognia/agent-config-types/canonical-session"

// ---- SDK-specific types ----
export type { CogniaCredentialRef, ResolvedCredential } from "./credentials"
export type {
  AgentInput,
  AgentAttachment,
  AgentPathAttachment,
  AgentBase64Attachment,
} from "./input"
export { assertNoInlineSecret, resolveCredential } from "./credentials"
export { lowerAgentInput, safeAttachmentName } from "./input"

// ---- Runtime & Session ----
export type {
  CogniaRuntime,
  CogniaRuntimeOptions,
  CogniaSession,
  CogniaSessionOptions,
  SessionRunOptions,
  SessionState,
  SessionEntry,
  SessionAnnotation,
} from "./runtime"
export { createCogniaRuntime } from "./runtime"

// ---- Strict tool sampling (public policy layer) ----
export type {
  ToolStrictPolicy,
  ToolStrictDeclaration,
  ModelStrictCapability,
  StrictPolicyResolution,
  StrictPolicyBatchResult,
} from "@/lib/ai/tools/strict-sampling"
export {
  getModelStrictCapability,
  resolveStrictPolicy,
  applyStrictPolicies,
} from "@/lib/ai/tools/strict-sampling"
