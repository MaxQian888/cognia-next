/** Hook wire boundaries are open records; known decision fields stay typed. */
export interface HookInput extends Record<string, unknown> {
  tool_name?: string
  tool_input?: unknown
  agent_id?: string
  agent_type?: string
  hook_origin?: string
  hook_recursion_depth?: unknown
}
export interface HookSpecificOutput extends Record<string, unknown> {
  hookEventName?: string
  decision?: { behavior?: string; message?: string; [key: string]: unknown }
  permissionDecision?: string
  permissionDecisionReason?: string
  additionalContext?: string
  updatedInput?: unknown
  updatedToolOutput?: unknown
  updatedMCPToolOutput?: unknown
  classifierContext?: unknown
}
export interface HookOutput extends Record<string, unknown> {
  hookSpecificOutput?: HookSpecificOutput
  decision?: string
  reason?: string
  continue?: unknown
}
export interface HookOutcome extends HookOutput {
  warnings?: string[]
  block?: string
  warning?: string
  additionalContext?: string
  updatedInput?: unknown
  updatedToolOutput?: unknown
  permissionDecision?: "ask" | "allow"
  sdkOutput?: HookOutput
  pluginResult?: Record<string, unknown>
  output?: string
}
export interface HookDecision extends HookOutcome {
  warnings: string[]
  classifierContextBound?: boolean
}
export interface HookHandler extends Record<string, unknown> {
  type?: string
  command?: string
  async?: boolean
  timeout?: number
  url?: string
  headers?: Record<string, string>
  pluginId?: string
  hookId?: string
  model?: string
  prompt?: string
  server?: string
  tool?: string
  input?: unknown
  policyClass?: string
}
export interface HookGroup {
  matcher?: string
  agents?: string
  hooks?: (HookHandler | null)[]
}
export type HooksConfig = Record<string, HookGroup[]>
export interface AgentIdentity {
  agent_kind?: string
  agent_ref?: string
}
export interface HookAudit {
  hookId: string
  hookEvent: string
  provider: string
  handlerType: string
  policyClass: "managed" | "user"
  outcome: "blocked" | "warning" | "context" | "allowed"
  latencyMs: number
  redacted: boolean
  blockReason?: string
  error?: string
}
export interface PluginHookFrame {
  type: "plugin_hook_exec"
  sessionId?: string
  execId: string
  pluginId: string
  hookId: string
  payload: unknown
}
export type PendingPluginHooks = Map<string, { resolve(value: unknown): void }>
export interface NativeHookContext {
  signal?: AbortSignal
  depth?: number
}
export type NativeHookExecutor = (
  handler: HookHandler,
  payload: string,
  context?: NativeHookContext
) => Promise<HookOutcome>
export interface HookDeps {
  eventName?: string
  provider?: string
  sessionId?: string
  cwd?: string
  agentKind?: string
  agentRef?: string
  agentIdentity?: AgentIdentity
  hookDepth?: number
  pluginTools?: readonly { name?: unknown; pluginId?: unknown; manifestPath?: unknown }[]
  mcpDeclaredBy?: Record<string, string>
  pendingPluginHookCalls?: PendingPluginHooks
  newId?: () => string
  executeNativeHandler?: NativeHookExecutor
  emitRaw?: (frame: PluginHookFrame) => void
  emit?: (frame: PluginHookFrame | HookEnvelope) => void
  emitAudit?: (frame: HookEnvelope) => void
  onAudit?: (audit: HookAudit) => void
  log?: (level: string, message: string) => void
}
export interface HookEnvelope {
  type: "event"
  sessionId?: string
  event: Record<string, unknown>
}
export type HookCallback = (
  input: HookInput,
  toolUseId?: string,
  context?: { signal?: AbortSignal }
) => Promise<HookOutput>
export interface HookMatcher {
  matcher?: string
  hooks: HookCallback[]
}
export type HookMap = Record<string, HookMatcher[]>
export const HOOK_PII_BLOCK_REASON = "Hook data blocked by the PII redaction gate"
export function handlerPolicyClass(handler: HookHandler | null | undefined): "managed" | "user" {
  return handler?.policyClass === "managed" ? "managed" : "user"
}
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined
}
export function errorMessage(value: unknown): unknown {
  return asRecord(value)?.message ?? value
}
