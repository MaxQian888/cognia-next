export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface AgentEventEnvelope {
  eventId: string
  sequence: number
  sessionId?: string
  runId?: string
  attemptId?: string
  turnId?: string
  event: { kind: string; [key: string]: unknown }
  [key: string]: unknown
}

export interface CanonicalTurn {
  turnId: string
  role: "user" | "assistant" | "system"
  text: string
  toolCalls?: CanonicalToolCall[]
  at?: string
  usage?: { inputTokens?: number; outputTokens?: number }
  [key: string]: unknown
}

export interface CanonicalToolCall {
  callId: string
  toolName: string
  input?: Record<string, unknown>
  resultText?: string
  isError?: boolean
}

export type SessionFidelity =
  "native-exact" | "structured" | "contextual" | "summary-only" | "unsupported"

export interface CanonicalSessionHeader {
  canonicalVersion: 1
  canonicalSessionId: string
  sourceRuntime: string
  runtimeBinding?: { nativeSessionId?: string }
  title?: string
  createdAt: string
  updatedAt: string
  turnCount: number
  importFidelity: SessionFidelity
  sequenceDigest: string
}

export interface CanonicalSession {
  header: CanonicalSessionHeader
  turns: CanonicalTurn[]
  permissions?: Array<{
    requestId: string
    toolName: string
    decision: "allow" | "allow_always" | "deny" | "pending"
    at?: string
  }>
  checkpoints?: Array<{ checkpointId: string; afterTurnId: string; note?: string }>
  [key: string]: unknown
}

export interface ResolvedAgentExecutionSpec {
  runtime?: string
  model?: string
  capabilities?: readonly string[]
  [key: string]: unknown
}

export type AgentInput =
  | string
  | {
      prompt: string
      attachments?: {
        name?: string
        mediaType?: string
        path?: string
        data?: string
      }[]
    }

export interface AgentRunResultV1 {
  status: string
  text?: string
  [key: string]: unknown
}

export type AgentTurnOutcome =
  | {
      status: "completed" | "failed" | "cancelled" | "timeout"
      result: AgentRunResultV1
    }
  | { status: "requires_action"; suspended: SuspendedRunState }

export interface SuspendedRunState {
  sessionId: string
  runId: string
  turnId: string
  pendingPermissions?: readonly PendingPermission[]
  pendingElicitations?: readonly PendingElicitation[]
  pendingExternalTools?: readonly PendingExternalTool[]
  recoveryRequired?: boolean
  [key: string]: unknown
}

export interface PendingPermission {
  requestId: string
  toolName?: string
  input?: unknown
  [key: string]: unknown
}

export interface PendingElicitation {
  requestId: string
  prompt?: string
  schema?: JsonSchema
  [key: string]: unknown
}

export interface PendingExternalTool {
  requestId: string
  handlerId: string
  sideEffect: SideEffectClass
  [key: string]: unknown
}

export interface CommandReceipt {
  commandId: string
  accepted?: boolean
  duplicate?: boolean
  [key: string]: unknown
}

export interface SessionState {
  sessionId: string
  status: "created" | "idle" | "running" | "waiting" | "recovery_required" | "closed"
  turnCount?: number
  [key: string]: unknown
}

export interface EntryPage {
  entries: readonly { envelope: AgentEventEnvelope; [key: string]: unknown }[]
  nextEventId?: string
}

export interface EntryPageOptions {
  afterEventId?: string
  limit?: number
}

export interface RunOptions {
  signal?: AbortSignal
  timeoutMs?: number
  idleTimeoutMs?: number
  maxSteps?: number
  includeDiagnostics?: boolean
  commandId?: string
}

export interface CommandOptions {
  signal?: AbortSignal
  timeoutMs?: number
  commandId?: string
}

export interface WaitOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface CompactOptions extends CommandOptions {
  instructions?: string
}

export interface CompactionResult extends CommandReceipt {
  /** Present when the live host captured a restorable pre-compaction snapshot. */
  boundaryId?: string
  /** Compaction can succeed even when the active runtime cannot provide an undo snapshot. */
  undoAvailable: boolean
  [key: string]: unknown
}

export interface ForkOptions extends CommandOptions {
  turnId?: string
  name?: string
}

export interface CloneOptions extends CommandOptions {
  name?: string
}

export interface SessionCreateOptions {
  commandId?: string
  name?: string
  cwd?: string
  model?: string
  permissionMode?: AgentPermissionMode
  tags?: string[]
  handoff?: import("./handoff-envelope").HandoffEnvelope
}

export interface SessionSummary {
  sessionId: string
  name?: string
  [key: string]: unknown
}

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max"
export type AgentPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan"

export type PermissionDecision =
  | { kind: "approve" }
  | { kind: "approve_always" }
  | { kind: "reject"; reason?: string }
  | { kind: "modify"; input: unknown }

export type ElicitationResponse =
  { kind: "submit"; value: unknown } | { kind: "cancel" } | { kind: "timeout" }

export type ExternalToolResponse =
  | { kind: "result"; value: unknown }
  | { kind: "error"; error: { code: string; message?: string; retryable?: boolean } }

export interface SandboxStatus {
  enabled: boolean
  policy?: Record<string, unknown>
  workspace?: string
  [key: string]: unknown
}

export interface SandboxSnapshot {
  snapshotId: string
  createdAt?: string
  [key: string]: unknown
}

export interface AuditPage {
  entries: readonly Record<string, unknown>[]
  nextCursor?: string
}

export type SideEffectClass = "none" | "idempotent" | "non-idempotent"
export type JsonSchema = Record<string, unknown>

export interface ClientToolRegistration {
  handlerId: string
  name: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  sideEffect: SideEffectClass
  timeoutMs?: number
}

export interface ClientHookRegistration {
  handlerId: string
  name: string
  event: string
  timeoutPolicy: "continue" | "deny" | "fail"
  timeoutMs?: number
}

export type ClientToolHandler = (
  input: unknown,
  context: ClientInvocationContext
) => unknown | Promise<unknown>

export type ClientHookHandler = (
  payload: unknown,
  context: ClientInvocationContext
) => unknown | Promise<unknown>

export interface ClientInvocationContext {
  sessionId: string
  runId: string
  attemptId: string
  invocationId: string
  idempotencyKey?: string
}

export interface CogniaDiagnostic {
  level: "debug" | "info" | "warn" | "error"
  message: string
  code?: string
  data?: Record<string, unknown>
}

export interface ProtocolLimits {
  maxOpenSessions: number
  maxActiveTurns: number
  maxFrameBytes: number
  maxReplayEvents: number
  maxOutboundBufferBytes: number
}

export interface AgentWorkerManifestV1 {
  manifestVersion: 1
  runtime: string
  models: readonly string[]
  hardCapabilities: readonly string[]
  maxActiveTurns: number
  credentialProfileRefs: readonly string[]
  workspaceBindingRefs: readonly string[]
  taskWorkspace: { enabled: boolean }
  sandbox: { capabilities: readonly string[] }
  platform: { os: string; arch: string }
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)
}

/** Validate an untrusted worker hello before it can participate in placement. */
export function isAgentWorkerManifestV1(value: unknown): value is AgentWorkerManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const manifest = value as Record<string, unknown>
  const taskWorkspace = manifest.taskWorkspace as Record<string, unknown> | undefined
  const sandbox = manifest.sandbox as Record<string, unknown> | undefined
  const platform = manifest.platform as Record<string, unknown> | undefined
  return (
    manifest.manifestVersion === 1 &&
    typeof manifest.runtime === "string" &&
    manifest.runtime.length > 0 &&
    isStringArray(manifest.models) &&
    isStringArray(manifest.hardCapabilities) &&
    Number.isInteger(manifest.maxActiveTurns) &&
    (manifest.maxActiveTurns as number) > 0 &&
    isStringArray(manifest.credentialProfileRefs) &&
    isStringArray(manifest.workspaceBindingRefs) &&
    taskWorkspace?.enabled !== undefined &&
    typeof taskWorkspace.enabled === "boolean" &&
    isStringArray(sandbox?.capabilities) &&
    typeof platform?.os === "string" &&
    platform.os.length > 0 &&
    typeof platform.arch === "string" &&
    platform.arch.length > 0
  )
}

export interface InitializeResult {
  protocolVersion: 2
  host: { name: string; version: string }
  runtimeVersion: string
  instanceId: string
  methods: readonly string[]
  capabilities: readonly string[]
  limits: ProtocolLimits
  workerManifest?: AgentWorkerManifestV1
}
