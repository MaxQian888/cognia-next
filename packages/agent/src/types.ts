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
  specVersion: 1 | 2
  identity: {
    sessionId: string
    runId: string
    turnId?: string
    attemptId: string
    providerAttemptId?: string
    parentRunId?: string
  }
  executionFingerprint: string
  executionKind: "agent" | "completion"
  runtimeAdapter: "claude-agent-sdk" | "ai-sdk" | "external"
  runtimePolicySource: "explicit" | "auto" | "legacy-mapped"
  deploymentRef?: string
  modelBindings: { primary: string; fast?: string; powerful?: string }
  route:
    | { kind: "gateway"; routePolicy: string; routePinId?: string; ticketRef?: string }
    | { kind: "direct"; routePolicy: string; credentialProfileRef?: string }
  hostRef: string
  compatibility: { evidence: string; recordRef?: string; suiteVersion?: string }
  capabilities: {
    effective: readonly string[]
    disabledOptional: readonly string[]
    support?: Readonly<Record<string, { support: string; reason?: string }>>
  }
  credential?: { profileRef: string; profileVersion?: string; affinity: string }
  fallbackPolicy: "none" | "completion"
  legacyMigrated?: boolean
}

/**
 * A content-addressed handle to bytes the host already holds.
 *
 * This is what a turn carries instead of a path or a base64 blob: the digest
 * makes the reference verifiable, and nothing large or host-local ends up in
 * the canonical event log that later gets replayed, exported or shared.
 */
export interface AssetReference {
  assetId: string
  digest: string
  mediaType: string
  byteLength: number
  name?: string
}

export type AgentInput =
  | string
  | {
      prompt: string
      /** Assets the host already holds. Requires the `assets-v1` capability. */
      assets?: AssetReference[]
      /**
       * @deprecated Not carried by any host build. Attachments were accepted by
       * the schema and read by no host code path, so the turn ran without them
       * and the caller was told nothing. They are now rejected with
       * `invalid_params`. Use asset references once the host declares the
       * `assets-v1` capability.
       */
      attachments?: {
        name?: string
        mediaType?: string
        path?: string
        data?: string
      }[]
    }

/**
 * The four statuses a turn can actually end in.
 *
 * Mirrors `AgentRunStatus` in `@cognia/agent-config-types`, which the host
 * validates every run result against.
 */
export type AgentRunStatus = "completed" | "failed" | "cancelled" | "timeout"

export interface AgentRunResultV1 {
  status: AgentRunStatus
  text?: string
  /**
   * Present when the session's agent definition declared an output schema and
   * the host validated the turn against it. Read it with
   * `parseStructuredOutput`, which types it and reports a schema failure as a
   * distinct error rather than as a string on a successful result.
   */
  structuredOutput?: unknown
  [key: string]: unknown
}

/**
 * A turn outcome is always terminal.
 *
 * There is deliberately no "waiting" variant. A turn blocked on a permission or
 * an elicitation has not ended, and reporting that as an outcome forced every
 * caller to re-enter a loop the SDK should own. Waiting is observable on the
 * run's event stream, and a session that needs governed operator action reports
 * `recovery_required` from `session.state()`.
 */
export interface AgentTurnOutcome {
  status: AgentRunStatus
  result: AgentRunResultV1
}

/**
 * Work the host is holding for a session. Reachable through `session.state()`
 * and the recovery events, never as a turn outcome.
 */
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
  /**
   * Create this session from a host-persisted agent definition.
   *
   * `version` is resolved once, here — omit it to mean "latest at creation
   * time". The resolved version and its digests are then frozen into the
   * session, which never follows a later `agent/update`.
   */
  agent?: { agentId: string; version?: number }
}

/** The agent version a session was frozen at, if it was created from one. */
export interface AgentSessionBinding {
  agentId: string
  version: number
  definitionDigest: string
  compositionPresetId?: string
  compositionDigest?: string
  executionFingerprint?: string
}

/** Runtime validator for bindings restored from a host's durable state. */
export function isAgentSessionBinding(value: unknown): value is AgentSessionBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const binding = value as Record<string, unknown>
  if (typeof binding.agentId !== "string" || binding.agentId.length === 0) return false
  if (
    typeof binding.version !== "number" ||
    !Number.isSafeInteger(binding.version) ||
    binding.version < 1
  ) {
    return false
  }
  if (typeof binding.definitionDigest !== "string" || binding.definitionDigest.length === 0) {
    return false
  }
  return ["compositionPresetId", "compositionDigest", "executionFingerprint"].every(
    (key) =>
      binding[key] === undefined || (typeof binding[key] === "string" && binding[key].length > 0)
  )
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

/**
 * A record of the sandbox resource policy that was in force.
 *
 * Not a workspace checkpoint. Nothing on disk is captured, and restoring one
 * re-applies the policy only. A real filesystem checkpoint would be declared
 * as `workspace-checkpoint-v1`, which no host currently implements.
 */
export interface SandboxPolicyRecord {
  policyRecordId: string
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

export {
  isAgentWorkerManifestV1,
  type AgentWorkerExecutionProfileV1,
  type AgentWorkerManifestV1,
} from "./worker-manifest"

import type { AgentWorkerManifestV1 } from "./worker-manifest"

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
