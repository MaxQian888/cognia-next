/**
 * The single authoritative headless-turn orchestration.
 *
 * Every public entry point — `cognia-agent run`, the `@cognia/agent` SDK, the
 * RPC server, `generate-text`, handoff resume, TUI bootstrap — funnels through
 * `runUnifiedTurn`. Before this module there were two orchestrations
 * (`runHeadlessTurn` for one-shot, `createAgentSession` for persistent) that
 * had already drifted: only one of them subscribed the plugin-tool dispatcher
 * unconditionally, only one honoured the stream-idle watchdog, and only one
 * registered per-turn subagent dispatch. A caller's behaviour depended on which
 * one it happened to reach.
 *
 * This module owns ONLY orchestration. It does not assemble context (that is
 * `createCliContextAssembler`), does not talk to a provider (that is
 * `createAgentSession` / `createExternalAgentSession`), and does not decide
 * approvals (that is the permission gate). It composes them, and it owns the
 * five things no collaborator can own alone:
 *
 *   1. backend selection, with no silent substitution;
 *   2. the canonical session lifecycle (lease, log, manifest, resume report);
 *   3. the attempt loop and its side-effect boundary;
 *   4. one cancellation path with guaranteed teardown;
 *   5. the `AgentRunResultV1` every surface reports.
 */

import os from "node:os"

import type { AgentCapabilityId } from "@cognia/agent-config-types/agent-execution"
import type {
  AgentResumeReport,
  AgentRunResultV1,
  AgentRunUsage,
  AgentStructuredError,
} from "@cognia/agent-config-types/agent-run-result"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"
import type { AgentCompositionSelectionV1 } from "@cognia/agent-config-types/agent-composition"

import { resolveHome } from "../../config/load"
import type { ResolvedConfig } from "../../config/schema"
import { createAgentSession, type AgentSession, type AgentSessionParams } from "../session-runner"
import { createExternalAgentSession } from "../external-agent-session"
import { mintSessionId } from "../run"
import type { PermissionResponder } from "../permission-gate"
import { createSessionStore, type SessionHandle, type SessionStore } from "../session-store/store"
import {
  createProviderSessionLease,
  providerSessionKey,
  type ProviderSessionLease,
} from "./provider-session"
import { selectBackend, type BackendSelectResult } from "./backend-select"
import { createTurnCancellation, type CancelReason } from "./cancellation"
import {
  createSideEffectTracker,
  decideRetry,
  isAbortError,
  resolveRetryPolicy,
  sleepWithAbort,
  type FailureSignal,
  type RetryPolicy,
} from "./retry"
import {
  createEnvelopeEmitter,
  mintAttemptId,
  mintRunId,
  mintTurnId,
  type EnvelopeEmitter,
} from "./turn-events"

export const HEADLESS_HOST_REF = "headless-agent-host"

export interface UnifiedTurnParams {
  config: ResolvedConfig
  prompt: string
  gate: PermissionResponder

  /** Reuse an existing session; minted when omitted. */
  sessionId?: string
  /** Preserve the logical run/turn when replaying a crash-suspended attempt. */
  recoveryIdentity?: { runId: string; turnId: string; attempt: number }
  /** `--no-session`: run without persisting anything. Resume is then impossible. */
  persist?: boolean
  /** `--session-dir` override for the canonical store. */
  sessionDirOverride?: string
  /** `--name` for a newly created session. */
  sessionName?: string
  /** Open a session recorded against another workspace (after trust re-eval). */
  allowForeignWorkspace?: boolean

  /** Hard capability requirements; a miss is `unsupported_capability`. */
  requires?: readonly AgentCapabilityId[]
  /** Preferred capabilities; a miss is reported as `disabledOptional`. */
  prefers?: readonly AgentCapabilityId[]

  /** Canonical envelope stream for the caller. */
  onEnvelope?: (
    envelope: import("@cognia/agent-config-types/agent-execution").AgentEventEnvelope
  ) => void
  /** `--include-diagnostics`: allow redacted raw provider payloads through. */
  includeDiagnostics?: boolean

  signal?: AbortSignal
  /** Wall-clock deadline for the turn (`--timeout`). */
  timeoutMs?: number
  /** Stalled-stream deadline (`--idle-timeout`). */
  idleTimeoutMs?: number
  /** Install SIGINT/SIGTERM handlers. On for the CLI, off for in-process SDK use. */
  handleSignals?: boolean
  retry?: Partial<RetryPolicy>
  /** Hard cap on agentic steps (`--max-steps`). */
  maxSteps?: number

  home?: string
  /** Definition-owned selection lowered through the existing composition resolver. */
  compositionSelection?: AgentCompositionSelectionV1
  /** Definition-owned JSON Schema lowered through the provider's structured-output path. */
  outputSchema?: Record<string, unknown>

  /**
   * Override how this turn's `SendOptions` are resolved. The ONLY supported
   * use is narrowing — `generate-text` and `/init` strip every tool and bypass
   * approvals so the model can answer with text and nothing else. It is
   * forwarded to the context assembler rather than applied here, so a narrowed
   * turn still gets the same instructions, MCP and skill assembly as any other.
   */
  resolveOptions?: AgentSessionParams["resolveOptions"]
  /** Injected transcript effects for the legacy flat transcript the session writes. */
  transcriptFs?: AgentSessionParams["transcriptFs"]
  /** Override the in-process plugin-tool relay (RPC uses it for durable elicitations). */
  subscribePluginTools?: AgentSessionParams["subscribePluginTools"]
  /** Override MCP discovery for a host-managed session (for example RPC configure). */
  resolveMcpServers?: AgentSessionParams["resolveMcpServers"]

  /**
   * Provider session owned by the CALLER and reused across turns.
   *
   * Absent (the one-shot `run -p` case) the turn builds its own and closes it
   * on the way out. Present (SDK `CogniaSession`, RPC per-session state) the
   * turn borrows it and leaves it open, so the conversation — and the live
   * control channel `compact`/`enqueue`/`setModel` need — survives to the next
   * prompt. Cancellation closes it either way.
   */
  providerSession?: ProviderSessionLease

  // ---- Injected collaborators (tests / advanced wiring) ------------------
  /** Build the underlying provider session. Defaults to the real factories. */
  createSession?: (params: AgentSessionParams) => AgentSession
  createExternalSession?: typeof createExternalAgentSession
  store?: SessionStore
  selectBackendFn?: typeof selectBackend
  now?: () => number
  random?: () => number
}

export interface UnifiedTurnResult {
  result: AgentRunResultV1
  /** Envelopes emitted by the FINAL attempt, in order. */
  envelopes: readonly import("@cognia/agent-config-types/agent-execution").AgentEventEnvelope[]
}

function errorFrom(error: unknown): FailureSignal {
  if (error && typeof error === "object") {
    const candidate = error as {
      message?: unknown
      status?: unknown
      statusCode?: unknown
      code?: unknown
      retryAfter?: unknown
      headers?: { get?: (name: string) => string | null }
    }
    const status =
      typeof candidate.status === "number"
        ? candidate.status
        : typeof candidate.statusCode === "number"
          ? candidate.statusCode
          : undefined
    const headerRetryAfter = candidate.headers?.get?.("retry-after") ?? undefined
    const retryAfter =
      typeof candidate.retryAfter === "string" || typeof candidate.retryAfter === "number"
        ? candidate.retryAfter
        : (headerRetryAfter ?? undefined)
    return {
      // A transport-level failure surfaces as an errno, an HTTP one as a status.
      code:
        typeof candidate.code === "string" && status === undefined
          ? "transport_error"
          : "provider_error",
      message: typeof candidate.message === "string" ? candidate.message : String(error),
      ...(status !== undefined ? { status } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    }
  }
  return { code: "provider_error", message: String(error) }
}

function statusForCancel(reason: CancelReason): AgentRunResultV1["status"] {
  return reason === "timeout" || reason === "idle-timeout" ? "timeout" : "cancelled"
}

/**
 * Run one headless turn end to end.
 *
 * Never throws for an expected failure — a bad backend, a locked session, a
 * dead provider and a cancelled run all come back as an `AgentRunResultV1` with
 * a structured `error`, because every caller (CLI exit code, SDK promise, RPC
 * response) needs to branch on the same values.
 */
export async function runUnifiedTurn(params: UnifiedTurnParams): Promise<UnifiedTurnResult> {
  const now = params.now ?? Date.now
  const random = params.random ?? Math.random
  const home = params.home ?? resolveHome(process.env, os.homedir())
  const startedAt = now()
  const sessionId = params.sessionId ?? mintSessionId(startedAt, random())
  const runId = params.recoveryIdentity?.runId ?? mintRunId(startedAt, random())
  const turnId = params.recoveryIdentity?.turnId ?? mintTurnId(runId, 0)
  const persist = params.persist !== false
  // A one-shot run owns its provider session and closes it with the turn; a
  // multi-turn caller passes its own lease and keeps it open. See
  // `provider-session.ts` for why re-opening per turn is not an option.
  const ownsLease = !params.providerSession
  const lease = params.providerSession ?? createProviderSessionLease()

  // ---- 1. Backend selection. Before anything is spawned or locked. --------
  const selection = (params.selectBackendFn ?? selectBackend)({
    ...(params.config.agentBackend ? { requested: params.config.agentBackend } : {}),
    ...(params.requires ? { requires: params.requires } : {}),
    ...(params.prefers ? { prefers: params.prefers } : {}),
  })
  if (!selection.ok) {
    return failedResult({
      sessionId,
      runId,
      turnId,
      attemptId: mintAttemptId(turnId, 0),
      backend: params.config.agentBackend ?? "builtin",
      model: params.config.model ?? "unknown",
      error: selection.error,
      persist: false,
    })
  }
  const backend: BackendSelectResult = selection.backend

  // ---- 2. Session lifecycle. The lease is taken before the sidecar spawns,
  // so a locked session fails fast instead of after a costly bootstrap. ------
  const store =
    params.store ??
    createSessionStore({
      home,
      ...(params.sessionDirOverride ? { sessionDirOverride: params.sessionDirOverride } : {}),
      now,
    })

  let handle: SessionHandle | null = null
  let resume: AgentResumeReport | undefined
  if (persist) {
    const opened = params.sessionId
      ? store.open(params.sessionId, {
          writable: true,
          cwd: params.config.cwd,
          ...(params.sessionName ? { name: params.sessionName } : {}),
          ...(params.allowForeignWorkspace ? { allowForeignWorkspace: true } : {}),
          runtimeBinding: { backend: backend.id },
        })
      : store.create(sessionId, {
          cwd: params.config.cwd,
          ...(params.sessionName ? { name: params.sessionName } : {}),
          runtimeBinding: { backend: backend.id },
        })
    if (!opened.ok) {
      return failedResult({
        sessionId,
        runId,
        turnId,
        attemptId: mintAttemptId(turnId, 0),
        backend: backend.id,
        model: params.config.model ?? "unknown",
        error: opened.error,
        persist: false,
      })
    }
    handle = opened.value
    if (handle.resume) resume = handle.resume
  }

  // ---- 3. Cancellation scope. Everything registered from here is guaranteed
  // to be torn down, on every exit path including a throw. ------------------
  const cancellation = createTurnCancellation({
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: params.idleTimeoutMs }
      : params.config.streamIdleTimeoutMs !== undefined
        ? { idleTimeoutMs: params.config.streamIdleTimeoutMs }
        : {}),
    ...(params.handleSignals ? { handleSignals: true } : {}),
  })
  // The lease is registered FIRST so it is released LAST — a teardown that
  // throws mid-way must never leave the session locked.
  if (handle) cancellation.onCleanup(() => handle?.close())

  const policy: RetryPolicy = {
    maxRetries: resolveRetryPolicy(params.retry).maxRetries,
    ...(params.retry?.baseBackoffMs !== undefined
      ? { baseBackoffMs: params.retry.baseBackoffMs }
      : {}),
    ...(params.retry?.maxBackoffMs !== undefined
      ? { maxBackoffMs: params.retry.maxBackoffMs }
      : {}),
    random,
  }

  const warnings: Array<{ code: string; message: string }> = []
  for (const capability of backend.disabledOptional) {
    warnings.push({
      code: "capability_unavailable",
      message: `backend "${backend.id}" does not provide the preferred capability ${capability}`,
    })
  }

  let session: AgentSession | null = null
  let lastEmitter: EnvelopeEmitter | null = null
  let text = ""
  let usage: AgentRunUsage | undefined
  let nativeSessionId: string | undefined
  let structuredOutput: unknown
  let failure: AgentStructuredError | undefined
  let attempt = params.recoveryIdentity?.attempt ?? 0

  try {
    for (;;) {
      const attemptId = mintAttemptId(turnId, attempt)
      const sideEffects = createSideEffectTracker()
      const emitter = createEnvelopeEmitter({
        identity: {
          sessionId,
          runId,
          turnId,
          attemptId,
          hostRef: HEADLESS_HOST_REF,
          runtime: backend.kind === "builtin" ? "claude-agent-sdk" : backend.id,
        },
        ...(params.onEnvelope ? { onEnvelope: params.onEnvelope } : {}),
        sideEffects,
        ...(params.includeDiagnostics ? { includeDiagnostics: true } : {}),
        now: () => new Date(now()),
      })
      lastEmitter = emitter

      emitter.emit({ kind: "lifecycle", phase: "started" })
      // The user's input is recorded BEFORE the provider is called, so a turn
      // that dies mid-flight still shows what was asked.
      emitter.emit({ kind: "user-input", text: params.prompt })
      for (const warning of warnings) {
        emitter.emit({ kind: "warning", code: warning.code, message: warning.message })
      }

      // The provider session is created once and reused across retries: a
      // retry re-sends the turn, it does not rebuild the whole context.
      //
      // WHO CLOSES IT depends on who owns the lease. A one-shot run owns its
      // own, so the session dies with the turn. A caller that passed a lease
      // (the SDK's `CogniaSession`, the RPC server) keeps it open across turns,
      // and closing it here would silently discard the conversation.
      if (!session) {
        session = await lease.replace(
          providerSessionKey({
            sessionId,
            backendId: backend.id,
            ...(params.config.model ? { model: params.config.model } : {}),
            cwd: params.config.cwd,
          }),
          () => buildSession(params, sessionId, home, backend)
        )
        cancellation.onCleanup(() => {
          // A borrowed lease still closes on cancellation — a cancelled turn
          // must not leave a sidecar or external agent running, and the lease
          // rebuilds on the caller's next prompt.
          if (ownsLease || cancellation.cancelled) return lease.close()
        })
      }

      try {
        const captured = await session.send(params.prompt, {
          gate: params.gate,
          signal: cancellation.signal,
          ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
          onEvent: (event: CaptureStreamEvent) => {
            // Any byte of progress resets the idle deadline.
            cancellation.noteActivity()
            emitter.fromCapture(event)
          },
        })
        text = captured.text
        structuredOutput = captured.structuredOutput
        if (captured.usage) {
          usage = normalizeUsage(captured.usage as unknown as Record<string, unknown>)
        }
        if (params.outputSchema && captured.structuredOutput === undefined) {
          failure = {
            code: "provider_error",
            message: "the turn completed without the required structured output",
          }
          emitter.emit({
            kind: "failure",
            code: failure.code,
            message: failure.message,
            retryable: false,
          })
          emitter.emit({ kind: "lifecycle", phase: "ended" })
          break
        }
        emitter.emit({ kind: "lifecycle", phase: "ended" })
        if (attempt > 0) {
          emitter.emit({
            kind: "retry",
            phase: "succeeded",
            attempt,
            maxRetries: policy.maxRetries,
            code: failure?.code ?? "provider_error",
          })
        }
        failure = undefined
        break
      } catch (error) {
        if (cancellation.cancelled) {
          emitter.emit({ kind: "lifecycle", phase: "interrupted" })
          failure = cancellation.toError() ?? { code: "cancelled", message: "cancelled" }
          break
        }
        if (isAbortError(error)) {
          emitter.emit({ kind: "lifecycle", phase: "interrupted" })
          failure = { code: "cancelled", message: (error as Error).message }
          break
        }

        const signal = errorFrom(error)
        const decision = decideRetry({
          failure: signal,
          attempt,
          sideEffectPerformed: sideEffects.performed,
          policy,
          now: now(),
        })

        if (!decision.retry) {
          failure = {
            code: signal.code,
            message: signal.message,
            ...(decision.reason === "side-effect"
              ? { detail: { notRetried: sideEffects.reason } }
              : {}),
          }
          if (decision.reason === "exhausted") {
            emitter.emit({
              kind: "retry",
              phase: "exhausted",
              attempt,
              maxRetries: policy.maxRetries,
              code: signal.code,
              message: signal.message,
            })
          }
          emitter.emit({
            kind: "failure",
            code: signal.code,
            message: signal.message,
            retryable: false,
          })
          emitter.emit({ kind: "lifecycle", phase: "ended" })
          break
        }

        emitter.emit({
          kind: "retry",
          phase: "scheduled",
          attempt: attempt + 1,
          maxRetries: policy.maxRetries,
          code: signal.code,
          delayMs: decision.delayMs,
          ...(decision.retryAfterMs !== undefined ? { retryAfterMs: decision.retryAfterMs } : {}),
          message: signal.message,
        })
        emitter.emit({ kind: "lifecycle", phase: "ended" })
        // Persist the failed attempt before sleeping — a run killed during
        // backoff must still show what it tried.
        handle?.append(emitter.emitted)

        try {
          await sleepWithAbort(decision.delayMs, cancellation.signal)
        } catch {
          failure = cancellation.toError() ?? { code: "cancelled", message: "cancelled" }
          break
        }
        failure = { code: signal.code, message: signal.message }
        attempt += 1
      }
    }

    // ---- 4. Persist the final attempt and fold the manifest. --------------
    if (handle && lastEmitter) {
      handle.append(lastEmitter.emitted)
      handle.commitTurn({
        turnsAdded: text.length > 0 ? 2 : 1,
        ...(usage ? { usage } : {}),
        lastAssistantText: text,
        runtimeBinding: {
          backend: backend.id,
          ...(nativeSessionId ? { nativeSessionId } : {}),
          ...(params.config.model ? { model: params.config.model } : {}),
          ...(params.config.provider ? { provider: params.config.provider } : {}),
        },
      })
    }
  } finally {
    await cancellation.finalize()
  }

  const cancelReason = cancellation.reason
  const status: AgentRunResultV1["status"] = failure
    ? cancelReason
      ? statusForCancel(cancelReason)
      : "failed"
    : "completed"

  const result: AgentRunResultV1 = {
    schemaVersion: 1,
    type: "result",
    status,
    sessionId,
    runId,
    turnId,
    attemptId: mintAttemptId(turnId, attempt),
    ...(nativeSessionId ? { nativeSessionId } : {}),
    text,
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(usage ? { usage } : {}),
    backend: backend.id,
    model: params.config.model ?? "unknown",
    ...(params.config.provider ? { provider: params.config.provider } : {}),
    capabilities: backend.capabilities,
    session: handle
      ? {
          persisted: true,
          sessionDir: handle.dir,
          turnsAppended: text.length > 0 ? 2 : 1,
          turnCount: handle.manifest.turnCount,
          ...(handle.manifest.lineage ? { lineage: handle.manifest.lineage } : {}),
        }
      : { persisted: false },
    ...(resume ? { resume } : {}),
    ...(failure ? { error: failure } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  }

  return { result, envelopes: lastEmitter?.emitted ?? [] }
}

/**
 * Build the provider session for the selected backend.
 *
 * The two factories are NOT interchangeable — `createExternalAgentSession`
 * throws for `builtin` — so the branch is on the selection's `kind`, which is
 * the only value that has already been validated against the registry.
 */
function buildSession(
  params: UnifiedTurnParams,
  sessionId: string,
  home: string,
  backend: BackendSelectResult
): AgentSession {
  const base: AgentSessionParams = {
    config:
      params.maxSteps !== undefined
        ? { ...params.config, aiSdkMaxSteps: params.maxSteps }
        : params.config,
    sessionId,
    home,
    ...(params.resolveOptions ? { resolveOptions: params.resolveOptions } : {}),
    ...(params.transcriptFs ? { transcriptFs: params.transcriptFs } : {}),
    ...(params.subscribePluginTools ? { subscribePluginTools: params.subscribePluginTools } : {}),
    ...(params.resolveMcpServers ? { resolveMcpServers: params.resolveMcpServers } : {}),
    ...(params.compositionSelection ? { compositionSelection: params.compositionSelection } : {}),
    ...(params.outputSchema ? { outputSchema: params.outputSchema } : {}),
  }
  if (backend.kind === "external") {
    return (params.createExternalSession ?? createExternalAgentSession)(base)
  }
  return (params.createSession ?? createAgentSession)(base)
}

function normalizeUsage(raw: Record<string, unknown>): AgentRunUsage {
  const pick = (...names: string[]): number | undefined => {
    for (const name of names) {
      const value = raw[name]
      if (typeof value === "number" && Number.isFinite(value)) return value
    }
    return undefined
  }
  const usage: AgentRunUsage = {}
  const input = pick("inputTokens", "input_tokens", "promptTokens")
  const output = pick("outputTokens", "output_tokens", "completionTokens")
  const cacheRead = pick("cacheReadTokens", "cache_read_input_tokens")
  const cacheCreate = pick("cacheCreationTokens", "cache_creation_input_tokens")
  const cost = pick("costUsd", "total_cost_usd")
  if (input !== undefined) usage.inputTokens = input
  if (output !== undefined) usage.outputTokens = output
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead
  if (cacheCreate !== undefined) usage.cacheCreationTokens = cacheCreate
  if (cost !== undefined) usage.costUsd = cost
  return usage
}

/** A failure that happened before any turn could start. */
function failedResult(input: {
  sessionId: string
  runId: string
  turnId: string
  attemptId: string
  backend: string
  model: string
  error: AgentStructuredError
  persist: boolean
}): UnifiedTurnResult {
  return {
    result: {
      schemaVersion: 1,
      type: "result",
      status: "failed",
      sessionId: input.sessionId,
      runId: input.runId,
      turnId: input.turnId,
      attemptId: input.attemptId,
      text: "",
      backend: input.backend,
      model: input.model,
      capabilities: [],
      session: { persisted: false },
      error: input.error,
    },
    envelopes: [],
  }
}
