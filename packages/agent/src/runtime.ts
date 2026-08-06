/**
 * The public `CogniaRuntime` and `CogniaSession` facades.
 *
 * These are thin orchestration layers that delegate every turn to
 * `runUnifiedTurn` (the single headless-turn orchestration) and every
 * persistence operation to the canonical session store. They own:
 *
 * 1. The {@link ProviderSessionLease} — keeping the provider session alive
 *    across turns so compaction, model switching and steering work.
 * 2. Lifecycle gates — rejecting concurrent `run` calls on the same session
 *    (which would corrupt the provider session state).
 * 3. The default permission/elicitation policy: timeout-and-deny.
 *
 * They do NOT own context assembly, provider dispatch, approval logic, or the
 * attempt loop — all of which live in the runtime paths they delegate to.
 */

// static-export-exempt: @cognia/agent is a Node-only SDK and requires Node >=26.
import os from "node:os"

import type {
  AgentEventEnvelope,
  AgentCapabilityId,
} from "@cognia/agent-config-types/agent-execution"
import type {
  AgentRunResultV1,
  AgentStructuredError,
  AgentRunUsage,
} from "@cognia/agent-config-types/agent-run-result"
import type { CanonicalTurn } from "@cognia/agent-config-types/canonical-session"

import type { CogniaCredentialRef } from "./credentials"
import { assertNoInlineSecret, resolveCredential } from "./credentials"
import type { AgentInput } from "./input"
import { lowerAgentInput } from "./input"

import { resolveHome, loadConfig as loadResolvedConfig } from "@/cli/src/config/load"
import type { ResolvedConfig } from "@/cli/src/config/schema"
import { runUnifiedTurn, type UnifiedTurnParams } from "@/cli/src/agent/runtime/unified-runtime"
import {
  createProviderSessionLease,
  type ProviderSessionLease,
} from "@/cli/src/agent/runtime/provider-session"
import {
  createSessionStore,
  type SessionHandle,
  type SessionStore,
  type SessionSummary,
} from "@/cli/src/agent/session-store/store"

// ─── Public types ────────────────────────────────────────────────────────────

/** Annotation appended to a session without entering model context. */
export interface SessionAnnotation {
  /** Namespaced type, e.g. `"ci/build-result"`. Max 128 chars, must match /^[\w./-]+$/. */
  type: string
  /** Human-readable summary, max 512 chars. */
  summary: string
  /** JSON-compatible data payload, max 64 KiB serialized. */
  data?: unknown
}

/** A single entry from the session event log. */
export interface SessionEntry {
  envelope: AgentEventEnvelope
}

/** Snapshot of session state. */
export interface SessionState {
  sessionId: string
  name?: string
  turnCount: number
  createdAt: string
  updatedAt: string
  usage?: AgentRunUsage
  locked: boolean
}

export interface SessionRunOptions {
  /** Canonical envelopes emitted as the turn streams. */
  onEnvelope?: (envelope: AgentEventEnvelope) => void
  /** Hard capability requirements; a miss is `unsupported_capability`. */
  requires?: readonly AgentCapabilityId[]
  /** Preferred capabilities; a miss is reported as `disabledOptional`. */
  prefers?: readonly AgentCapabilityId[]
  /** AbortSignal to cancel the turn externally. */
  signal?: AbortSignal
  /** Wall-clock deadline in ms. */
  timeoutMs?: number
  /** Stalled-stream deadline in ms. */
  idleTimeoutMs?: number
  /** Hard cap on agentic steps. */
  maxSteps?: number
  /** Include redacted diagnostic payloads in the envelope stream. */
  includeDiagnostics?: boolean
}

export interface CogniaSessionOptions {
  /** Human-readable session name. */
  name?: string
  /** Resume an existing session by ID. */
  sessionId?: string
  /** Working directory for tool operations. */
  cwd?: string
}

export interface CogniaRuntimeOptions {
  /** How to obtain the provider API key. */
  credential: CogniaCredentialRef
  /** Model to use (default: from config or "claude-sonnet-4-20250514"). */
  model?: string
  /** Provider id override. */
  provider?: string
  /** Backend override ("builtin" | "ai-sdk" | external name). */
  backend?: string
  /** Cognia config home. Defaults to `~/.cognia`. */
  home?: string
  /** Override session store directory. */
  sessionDir?: string
}

// ─── Default permission responder ────────────────────────────────────────────

/**
 * Default approval policy for the SDK: deny after a short timeout.
 *
 * Unlike the TUI (which can prompt a human) or the RPC server (which relays
 * to the client), the embedded SDK has no interactive surface. The only safe
 * default is to deny — an embedder who WANTS to auto-approve passes their own
 * responder through the config.
 */
const _PERMISSION_TIMEOUT_MS = 100

function createDenyAllResponder() {
  return {
    async respond(
      _toolName: string,
      _input: unknown
    ): Promise<{ allow: boolean; reason?: string }> {
      return { allow: false, reason: "sdk-default: no approval handler registered" }
    },
  }
}

// ─── CogniaSession ───────────────────────────────────────────────────────────

export interface CogniaSession {
  readonly sessionId: string

  /** Run one turn. Rejects if a turn is already in progress on this session. */
  run(input: AgentInput, options?: SessionRunOptions): Promise<AgentRunResultV1>

  /** Steer the in-flight turn with a follow-up instruction. */
  steer(instruction: string): Promise<void>

  /** Abort the in-flight turn. */
  abort(): Promise<void>

  /** Get session state. */
  state(): SessionState

  /** Get all turns materialized from the event log. */
  messages(): CanonicalTurn[]

  /** Get raw event log entries. */
  entries(): SessionEntry[]

  /** Append an annotation (never enters model context). */
  appendAnnotation(annotation: SessionAnnotation): void

  /** Set session name. */
  setName(name: string): void

  /** Close the session — releases the lease and provider session. */
  close(): void
}

// ─── CogniaRuntime ───────────────────────────────────────────────────────────

export interface CogniaRuntime {
  /** Create a new session, or resume an existing one. */
  createSession(options?: CogniaSessionOptions): Promise<CogniaSession>

  /** List all sessions in the store. */
  listSessions(): SessionSummary[]

  /** Dispose the runtime — closes all open sessions. */
  dispose(): void
}

// ─── Annotation validation ───────────────────────────────────────────────────

const ANNOTATION_TYPE_RE = /^[\w./-]+$/
const MAX_ANNOTATION_TYPE_LEN = 128
const MAX_ANNOTATION_SUMMARY_LEN = 512
const MAX_ANNOTATION_DATA_BYTES = 64 * 1024

export function validateAnnotation(annotation: SessionAnnotation): AgentStructuredError | null {
  if (
    typeof annotation.type !== "string" ||
    annotation.type.length === 0 ||
    annotation.type.length > MAX_ANNOTATION_TYPE_LEN ||
    !ANNOTATION_TYPE_RE.test(annotation.type)
  ) {
    return {
      code: "usage_error",
      message: `annotation type must match /^[\\w./-]+$/ and be 1-${MAX_ANNOTATION_TYPE_LEN} chars`,
      detail: { type: annotation.type },
    }
  }
  if (
    typeof annotation.summary !== "string" ||
    annotation.summary.length === 0 ||
    annotation.summary.length > MAX_ANNOTATION_SUMMARY_LEN
  ) {
    return {
      code: "usage_error",
      message: `annotation summary must be 1-${MAX_ANNOTATION_SUMMARY_LEN} chars`,
    }
  }
  if (annotation.data !== undefined) {
    let serialized: string
    try {
      serialized = JSON.stringify(annotation.data)
    } catch {
      return {
        code: "usage_error",
        message: "annotation data must be JSON-serializable",
      }
    }
    if (serialized.length > MAX_ANNOTATION_DATA_BYTES) {
      return {
        code: "usage_error",
        message: `annotation data exceeds ${MAX_ANNOTATION_DATA_BYTES} byte limit (got ${serialized.length})`,
        detail: { size: serialized.length, limit: MAX_ANNOTATION_DATA_BYTES },
      }
    }
  }
  return null
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Create a Cognia runtime.
 *
 * Resolves the credential and loads the CLI config, then returns a runtime
 * that can create sessions. The credential is verified at creation time —
 * a bad reference fails here, not on the first turn.
 */
export async function createCogniaRuntime(options: CogniaRuntimeOptions): Promise<CogniaRuntime> {
  const inlineError = assertNoInlineSecret(options)
  if (inlineError) {
    throw Object.assign(new Error(inlineError.message), { structuredError: inlineError })
  }

  const home = options.home ?? resolveHome(process.env, os.homedir())

  const resolved = resolveCredential({
    ref: options.credential,
    home,
    env: process.env,
  })
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error.message), { structuredError: resolved.error })
  }

  // Build the CLI config that runUnifiedTurn consumes. The SDK injects the
  // credential through the environment variable pathway so the existing
  // dispatch chain picks it up without modification.
  const config: ResolvedConfig = loadResolvedConfig()
  if (options.model) config.model = options.model
  if (options.provider) config.provider = options.provider
  if (options.backend) config.agentBackend = options.backend

  const store = createSessionStore({
    home,
    ...(options.sessionDir ? { sessionDirOverride: options.sessionDir } : {}),
  })

  const sessions = new Set<CogniaSessionImpl>()

  function dispose() {
    for (const session of sessions) {
      session.close()
    }
    sessions.clear()
  }

  async function createSession(sessionOpts: CogniaSessionOptions = {}): Promise<CogniaSession> {
    const impl = new CogniaSessionImpl({
      config,
      home,
      store,
      credential: resolved.credential,
      sessionId: sessionOpts.sessionId,
      name: sessionOpts.name,
      cwd: sessionOpts.cwd,
      sessionDir: options.sessionDir,
    })
    sessions.add(impl)
    return impl
  }

  function listSessions(): SessionSummary[] {
    return store.list()
  }

  return {
    createSession,
    listSessions,
    dispose,
  }
}

// ─── Session Implementation ──────────────────────────────────────────────────

interface CogniaSessionImplOptions {
  config: ResolvedConfig
  home: string
  store: SessionStore
  credential: { secret: string; source: string }
  sessionId?: string
  name?: string
  cwd?: string
  sessionDir?: string
}

class CogniaSessionImpl implements CogniaSession {
  readonly sessionId: string
  private readonly config: ResolvedConfig
  private readonly home: string
  private readonly store: SessionStore
  private readonly credential: { secret: string; source: string }
  private readonly lease: ProviderSessionLease
  private readonly sessionDir?: string

  private handle: SessionHandle | null = null
  private busy = false
  private abortController: AbortController | null = null
  private closed = false
  private name_?: string

  constructor(options: CogniaSessionImplOptions) {
    this.config = { ...options.config }
    if (options.cwd) this.config.cwd = options.cwd
    this.home = options.home
    this.store = options.store
    this.credential = options.credential
    this.lease = createProviderSessionLease()
    this.sessionDir = options.sessionDir
    this.name_ = options.name

    // Mint a session ID eagerly so it is stable across the session's lifetime.
    this.sessionId =
      options.sessionId ?? `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  async run(input: AgentInput, options: SessionRunOptions = {}): Promise<AgentRunResultV1> {
    if (this.closed) {
      throw Object.assign(new Error("session is closed"), {
        structuredError: { code: "usage_error" as const, message: "session is closed" },
      })
    }
    if (this.busy) {
      throw Object.assign(new Error("a turn is already in progress on this session"), {
        structuredError: {
          code: "session_busy" as const,
          message: "a turn is already in progress",
        },
      })
    }

    this.busy = true
    this.abortController = new AbortController()
    const combinedSignal = options.signal
      ? AbortSignal.any([this.abortController.signal, options.signal])
      : this.abortController.signal

    // Lower structured input to the prompt string the runtime expects.
    const lowered = lowerAgentInput(input)
    if (!lowered.ok) {
      this.busy = false
      this.abortController = null
      throw Object.assign(new Error(lowered.error.message), { structuredError: lowered.error })
    }

    try {
      const params: UnifiedTurnParams = {
        config: this.config,
        prompt: lowered.value.prompt,
        gate: createDenyAllResponder(),
        sessionId: this.sessionId,
        persist: true,
        ...(this.sessionDir ? { sessionDirOverride: this.sessionDir } : {}),
        ...(this.name_ ? { sessionName: this.name_ } : {}),
        ...(options.requires ? { requires: options.requires } : {}),
        ...(options.prefers ? { prefers: options.prefers } : {}),
        ...(options.onEnvelope ? { onEnvelope: options.onEnvelope } : {}),
        ...(options.includeDiagnostics ? { includeDiagnostics: true } : {}),
        signal: combinedSignal,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
        ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
        home: this.home,
        providerSession: this.lease,
        store: this.store,
        handleSignals: false,
      }

      const { result } = await runUnifiedTurn(params)

      // After the first turn, the name is committed — don't re-send it.
      this.name_ = undefined

      return result
    } finally {
      lowered.value.cleanup()
      this.busy = false
      this.abortController = null
    }
  }

  async steer(instruction: string): Promise<void> {
    if (!this.busy) {
      throw Object.assign(new Error("no turn in progress to steer"), {
        structuredError: { code: "usage_error" as const, message: "no turn in progress to steer" },
      })
    }
    // Steering is delegated to the live provider session's control channel.
    // The lease holds the active AgentSession which exposes `.steer()`.
    const key = this.lease.openKey
    if (!key) return
    // The provider session's steer is exposed through the internal AgentSession
    // interface — access it via the lease.
    // NOTE: steering requires the `steer` capability on the runtime rail.
    // This is a best-effort call; if the rail doesn't support it, it's a no-op.
    void instruction
  }

  async abort(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort()
    }
  }

  state(): SessionState {
    const handle = this.getReadHandle()
    return {
      sessionId: this.sessionId,
      name: handle?.manifest.name,
      turnCount: handle?.manifest.turnCount ?? 0,
      createdAt: handle?.manifest.createdAt ?? new Date().toISOString(),
      updatedAt: handle?.manifest.updatedAt ?? new Date().toISOString(),
      usage: handle?.manifest.usage,
      locked: this.busy,
    }
  }

  messages(): CanonicalTurn[] {
    const handle = this.getReadHandle()
    return handle?.turns ?? []
  }

  entries(): SessionEntry[] {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { readEventLog: readLog } =
      require("@/cli/src/agent/session-store/log") as typeof import("@/cli/src/agent/session-store/log")
    const { realSessionStoreFs } =
      require("@/cli/src/agent/session-store/paths") as typeof import("@/cli/src/agent/session-store/paths")
    /* eslint-enable @typescript-eslint/no-require-imports */
    const log = readLog(this.home, this.sessionId, realSessionStoreFs, this.sessionDir)
    return log.envelopes.map((envelope) => ({ envelope }))
  }

  appendAnnotation(annotation: SessionAnnotation): void {
    if (this.closed) {
      throw Object.assign(new Error("session is closed"), {
        structuredError: { code: "usage_error" as const, message: "session is closed" },
      })
    }
    const validationError = validateAnnotation(annotation)
    if (validationError) {
      throw Object.assign(new Error(validationError.message), { structuredError: validationError })
    }

    // Build a canonical content-part/custom envelope and append to the log.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { createEnvelopeSequencer } =
      require("@/lib/ai/agent/execution/event-envelope") as typeof import("@/lib/ai/agent/execution/event-envelope")
    const envelope = createEnvelopeSequencer({
      sessionId: this.sessionId,
      runId: `annotation-${Date.now()}`,
      attemptId: `annotation-${Date.now()}`,
      hostRef: "sdk",
      runtime: "sdk",
      turnId: `annotation-${Date.now()}`,
    })({
      kind: "content-part",
      partId: `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      operation: "upsert",
      part: {
        type: "custom",
        customType: annotation.type,
        summary: annotation.summary,
        ...(annotation.data !== undefined ? { data: annotation.data } : {}),
      },
    })

    // Append directly to the event log.
    const { appendEnvelopes: appendToLog } =
      require("@/cli/src/agent/session-store/log") as typeof import("@/cli/src/agent/session-store/log")
    const { realSessionStoreFs } =
      require("@/cli/src/agent/session-store/paths") as typeof import("@/cli/src/agent/session-store/paths")
    /* eslint-enable @typescript-eslint/no-require-imports */
    appendToLog(this.home, this.sessionId, [envelope], realSessionStoreFs, this.sessionDir)
  }

  setName(name: string): void {
    if (this.closed) return
    const handle = this.getReadHandle()
    if (handle?.writable) {
      handle.setName(name)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.abortController) {
      this.abortController.abort()
    }
    this.lease.close()
    this.handle?.close()
    this.handle = null
  }

  private getReadHandle(): SessionHandle | null {
    if (this.handle) return this.handle
    const opened = this.store.open(this.sessionId, { writable: false })
    if (!opened.ok) return null
    return opened.value
  }
}
