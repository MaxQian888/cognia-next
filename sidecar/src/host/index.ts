import type { FeatureCallMessage } from "./feature-call/index.ts"
import type { SendOptions, Prompt } from "../shared/wire/inbound.ts"
import type { HostSession, Outcome } from "./sessions/types.ts"
import type { HostMessage } from "./wire.ts"
import type { SmokeState } from "./smoke.ts"
import { parseHostMessage } from "./wire.ts"
import { errorMessage } from "../shared/errors.ts"
import {
  makeWrappedEmit,
  envelopeEmitterParams,
  restartReason,
  routeSendIntoLiveLoop,
  routeRestore,
  routeClose,
} from "./sessions/lifecycle.ts"
import { providerVisibleSendPayloadIsSafe, retainedRuntimeSendIsSafe } from "./commands/send.ts"
import {
  routeSetMode,
  runControlWithTimeout,
  routeSteer,
  controlPreflight,
  guardedControlParams,
  runtimeStatus,
} from "./control/handle.ts"
import { buildPermissionResult, routeCallReserveDecision } from "./commands/responses.ts"
import { dropDuplicateCommand } from "./commands/ledger.ts"
import { blockUnsupportedCommand, routeCommand } from "./router.ts"
import { createUncaughtErrorGuard } from "./lifecycle.ts"
import {
  SMOKE_DEFAULT_TIMEOUT_MS,
  smokeCredentialGap,
  smokeObserveFrame,
  smokeOutcome,
} from "./smoke.ts"
import readline from "node:readline"
import { readVersionInfo } from "./version-info.ts"
import { dispatch } from "../runtimes/index.ts"
import { capabilityError } from "../runtimes/registry.ts"
import { createEnvelopeEmitter } from "./events/envelope.ts"
import { sessionStoreFromSendOptions } from "../runtimes/claude-agent-sdk/session-store.ts"
import { handleSessionApi } from "../runtimes/claude-agent-sdk/session-api.ts"
import { resetWarmPool } from "../runtimes/claude-agent-sdk/warm-pool.ts"
import { controlArgs, buildControlResponse } from "./control/control.ts"
import { createFeatureCallHandler } from "./feature-call/index.ts"
import { createHostRpc } from "../platform/host-rpc.ts"
export {
  makeWrappedEmit,
  envelopeEmitterParams,
  restartReason,
  routeSendIntoLiveLoop,
  routeRestore,
  routeClose,
} from "./sessions/lifecycle.ts"
export { providerVisibleSendPayloadIsSafe } from "./commands/send.ts"
export {
  routeSetMode,
  CONTROL_TIMEOUT_MS,
  runControlWithTimeout,
  routeSteer,
  controlPreflight,
  guardedControlParams,
} from "./control/handle.ts"
export {
  buildPermissionResult,
  persistableSuggestions,
  routeCallReserveDecision,
} from "./commands/responses.ts"
export {
  RECENT_COMMAND_SESSIONS,
  RECENT_COMMAND_IDS_PER_SESSION,
  dropDuplicateCommand,
} from "./commands/ledger.ts"
export { blockUnsupportedCommand, routeCommand } from "./router.ts"
export {
  UNCAUGHT_ERROR_BUDGET,
  UNCAUGHT_ERROR_WINDOW_MS,
  createUncaughtErrorGuard,
} from "./lifecycle.ts"
export {
  SMOKE_CREDENTIAL_ENV,
  SMOKE_DEFAULT_TIMEOUT_MS,
  smokeCredentialGap,
  smokeObserveFrame,
  smokeOutcome,
} from "./smoke.ts"
export function createAgentHost({
  shutdownHostTelemetry = async () => {},
}: { shutdownHostTelemetry?: () => Promise<unknown> } = {}) {
  const VERBOSE = (() => {
    const raw = process.env.COGNIA_SIDECAR_VERBOSE
    return raw === "1" || raw === "true"
  })()

  function logv(message: string) {
    if (!VERBOSE) return
    process.stderr.write(`[sidecar:verbose] ${message}\n`)
  }

  const emitObservers = new Set<(payload: unknown) => void>()

  function emitForTests(payload: unknown) {
    emit(payload)
  }

  function emit(payload: unknown) {
    if (emitObservers.size > 0) {
      for (const observe of emitObservers) {
        try {
          observe(payload)
        } catch {
          // An observer must never break the wire.
        }
      }
    }
    try {
      process.stdout.write(JSON.stringify(payload) + "\n")
    } catch (err) {
      // Last-resort logging — stderr is captured by Tauri but not used as a protocol channel.
      process.stderr.write(`[sidecar] failed to emit: ${errorMessage(err)}\n`)
    }
  }

  function log(level: "info" | "warn" | "error", message: string) {
    emit({ type: "log", level, message })
  }

  const hostRpc = createHostRpc({ emit })

  const featureCalls = createFeatureCallHandler({ emit, hostRpc })

  const sessions = new Map<string, HostSession>()
  const commandLedger = new Map<string, Map<string, boolean>>()

  function startSession(sessionId: string, firstPrompt: Prompt, sendOptions: SendOptions = {}) {
    // Wired after `dispatch` returns so the wrapped emitter can verify it still
    // owns the map entry before retiring it (defends against a superseded old
    // loop evicting this replacement — see `makeWrappedEmit`).
    const ownerRef: { session: HostSession | null } = { session: null }
    // One ref per loop. `handleSend` advances it for later turns on THIS session;
    // a replacement loop gets its own, so this one keeps stamping its old id.
    const turnRef = { id: sendOptions?.turnId }
    // ADR-0090 Phase 3: sessions carrying a frozen execution spec ALSO emit
    // canonical `agent_event` envelopes (additive dual channel); legacy
    // sessions pay nothing.
    const emitterParams = envelopeEmitterParams({ sessionId, sendOptions, turnRef, emit })
    const baseEmit = emitterParams ? createEnvelopeEmitter(emitterParams) : emit
    const wrappedEmit = makeWrappedEmit(
      baseEmit,
      sessions,
      sessionId,
      () => ownerRef.session,
      turnRef,
      typeof sendOptions.transcriptInvalidationId === "string"
        ? sendOptions.transcriptInvalidationId
        : undefined
    )
    const dispatchParams = {
      sessionId,
      firstPrompt,
      sendOptions,
      emit: wrappedEmit,
      log,
      hostRpc,
    }
    const session: HostSession | null = dispatch(dispatchParams)
    if (!session) return null
    ownerRef.session = session
    session.turnRef = turnRef
    session.runtimeAdapterId = emitterParams?.runtime
    sessions.set(sessionId, session)
    return session
  }

  function handleSend(msg: HostMessage) {
    const { sessionId, prompt, options } = msg
    if (!sessionId) {
      log("error", "send: sessionId required")
      return
    }
    if (typeof prompt !== "string" && !Array.isArray(prompt)) {
      log("error", "send: prompt must be string or content-block array")
      return
    }
    // This is the final shared boundary before provider execution. Renderer
    // callers already apply the same gate, but headless/ACP callers do not pass
    // through the renderer and must fail closed here as well.
    if (!providerVisibleSendPayloadIsSafe({ prompt, options })) {
      log("error", "send: provider-visible payload rejected by the PII gate")
      emit({
        type: "session_ended",
        sessionId,
        error: "provider-visible payload rejected by the PII gate",
        ...(options?.turnId ? { turnId: options.turnId } : {}),
        ...(options?.transcriptInvalidationId
          ? { transcriptInvalidationId: options.transcriptInvalidationId }
          : {}),
      })
      return
    }
    const existing = sessions.get(sessionId!)
    if (!retainedRuntimeSendIsSafe(existing, options)) {
      emit({
        type: "session_ended",
        sessionId,
        errorCode: "RUNTIME_SESSION_NOT_RETAINED",
        error:
          "runtime_session_not_retained: retained context is unavailable; retry to restore conversation history.",
        ...(options?.turnId ? { turnId: options.turnId } : {}),
        ...(options?.transcriptInvalidationId
          ? { transcriptInvalidationId: options.transcriptInvalidationId }
          : {}),
      })
      return
    }
    if (existing) {
      // Defense-in-depth: close-and-restart any session that can't safely take a
      // new prompt in place (changed cwd, or a previous turn that never ended).
      const reason = restartReason(existing, options)
      if (reason) {
        log("warn", `send: restarting session ${sessionId} (${reason})`)
        handleClose({ sessionId })
        startSession(sessionId, prompt, options)
        return
      }
      routeSendIntoLiveLoop(existing, options, prompt)
    } else {
      startSession(sessionId, prompt, options)
    }
  }

  async function handleInterrupt(msg: HostMessage) {
    const { sessionId } = msg
    const s = sessions.get(sessionId!)
    if (!s) {
      log("warn", `interrupt: no session ${sessionId}`)
      return
    }
    try {
      await s.q!.interrupt!()
    } catch (err) {
      log("error", `interrupt failed: ${errorMessage(err)}`)
    }
    // Anthropic path: settle tool/approval round-trips the SDK interrupt doesn't
    // drain (`pendingPluginToolCalls` has no signal wiring). The ai-sdk path
    // already drains inside `q.interrupt()`, so this is a no-op there.
    try {
      s.drainPending?.("interrupted")
    } catch (err) {
      log("error", `drainPending (interrupt) failed: ${errorMessage(err)}`)
    }
  }

  async function handleCompact(msg: HostMessage) {
    const { sessionId, focus } = msg
    const s = sessions.get(sessionId!)
    if (!s) {
      log("warn", `compact: no session ${sessionId}`)
      return
    }
    if (typeof s.requestCompact !== "function") return
    try {
      await s.requestCompact(focus)
    } catch (err) {
      log("error", `compact failed: ${errorMessage(err)}`)
    }
  }

  function handleRestore(msg: HostMessage) {
    routeRestore(sessions, msg, log)
  }

  async function handleSetMode(msg: HostMessage) {
    const outcome = await routeSetMode(sessions, msg)
    if (!outcome.ok) log("error", `set_mode failed: ${outcome.error}`)
  }

  async function handleControl(msg: HostMessage) {
    const { sessionId, requestId, method, params } = msg
    const respond = (extra: Outcome) =>
      emit(
        buildControlResponse({
          sessionId: sessionId!,
          requestId: requestId!,
          method: method!,
          ...extra,
        })
      )

    if (method === "runtimeStatus") {
      respond({ ok: true, result: runtimeStatus(sessions.get(sessionId!)) })
      return
    }

    const rejection = controlPreflight(sessions.get(sessionId!)?.runtimeAdapterId, method, params)
    if (rejection) {
      // A capability miss ALSO gets the typed `capability_error` event, because
      // that is what the canonical event stream carries; the control_response is
      // only how this particular request settles.
      if (rejection.capability) emit(capabilityError(sessionId, rejection.capability, method))
      respond({ ok: false, error: rejection.error })
      return
    }
    if (method === "setPermissionMode") {
      respond(await routeSetMode(sessions, { sessionId, mode: params?.mode }))
      return
    }
    if (method === "steer") {
      respond(routeSteer(sessions, { sessionId, ...params }))
      return
    }
    const s = sessions.get(sessionId!)
    if (!s) {
      respond({ ok: false, error: "no_active_session" })
      return
    }
    const fn = s.q ? Reflect.get(s.q, method!) : undefined
    if (typeof fn !== "function") {
      respond({ ok: false, error: "unsupported_provider" })
      return
    }
    let effectiveParams
    try {
      effectiveParams = guardedControlParams(method!, params ?? {}, s.sendOptions)
    } catch (error) {
      respond({ ok: false, error: errorMessage(error) })
      return
    }
    const outcome = await runControlWithTimeout(
      fn as (...args: unknown[]) => unknown,
      s.q,
      controlArgs(method!, effectiveParams)
    )
    // Keep the shared sendOptions ref consistent so any later resolve agrees with
    // the live switch (mirrors handleSetMode's permissionMode mutation). Only on a
    // confirmed (non-timed-out) success.
    if (outcome.ok && method === "setModel" && s.sendOptions && params?.model) {
      s.sendOptions.model = params.model as string
    }
    respond(outcome)
  }

  function handlePermissionResponse(msg: HostMessage) {
    const { sessionId, requestId, decision, updatedInput, message, interrupt } = msg
    const s = sessions.get(sessionId!)
    if (!s) return
    const pending = s.pendingApprovals?.get(requestId!)
    if (!pending) return
    s.pendingApprovals!.delete(requestId!)

    pending.resolve(
      buildPermissionResult(decision!, {
        updatedInput,
        message,
        input: pending.input as Record<string, unknown> | undefined,
        // The SDK's own suggestions, captured when the request was raised — not
        // anything the renderer supplied. A renderer-authored rule set would be
        // an unreviewed write into the permission store.
        suggestions: pending.suggestions,
        suppressAlwaysAllowRule: pending.suppressAlwaysAllowRule as boolean | undefined,
        interrupt,
        rich: Boolean(s.sendOptions?.execution),
      })
    )
  }

  function handlePluginToolResponse(msg: HostMessage) {
    const { sessionId, toolUseId, result, error } = msg
    const s = sessions.get(sessionId!)
    if (!s || !s.pendingPluginToolCalls) return
    const pending = s.pendingPluginToolCalls.get(toolUseId!)
    if (!pending) return
    s.pendingPluginToolCalls.delete(toolUseId!)
    pending.resolve({ result, error })
  }

  function handlePluginHookResponse(msg: HostMessage) {
    const { sessionId, execId, result, error } = msg
    const s = sessions.get(sessionId!)
    if (!s || !s.pendingPluginHookCalls) return
    const pending = s.pendingPluginHookCalls.get(execId!)
    if (!pending) return
    s.pendingPluginHookCalls.delete(execId!)
    pending.resolve({ result, error })
  }

  function handleToolResultDecision(msg: HostMessage) {
    const { sessionId, reviewId, updatedToolOutput } = msg
    const s = sessions.get(sessionId!)
    if (!s || !s.pendingToolResultReviews) return
    const pending = s.pendingToolResultReviews.get(reviewId!)
    if (!pending) return
    s.pendingToolResultReviews.delete(reviewId!)
    pending.resolve(updatedToolOutput)
  }

  function handleProtocolAdapterChunk(msg: HostMessage) {
    const { sessionId, execId, chunk } = msg
    const s = sessions.get(sessionId!)
    const channel = s?.pendingProtocolExecs?.get(execId!)
    if (channel) channel.push(chunk)
  }

  function handleProtocolAdapterDone(msg: HostMessage) {
    const { sessionId, execId, usage } = msg
    const s = sessions.get(sessionId!)
    const channel = s?.pendingProtocolExecs?.get(execId!)
    if (!channel) return
    channel.finish(usage)
    s!.pendingProtocolExecs!.delete(execId!)
  }

  function handleProtocolAdapterError(msg: HostMessage) {
    const { sessionId, execId, error } = msg
    const s = sessions.get(sessionId!)
    const channel = s?.pendingProtocolExecs?.get(execId!)
    if (!channel) return
    channel.fail(error ?? "protocol adapter error")
    s!.pendingProtocolExecs!.delete(execId!)
  }

  function handleClose(msg: { sessionId?: string }) {
    routeClose(sessions, msg, log)
  }

  async function smoke() {
    // Quick round-trip test invoked with `node claude-host.mjs --smoke`.
    //
    // Honest by construction. It used to exit 0 unconditionally once the
    // session map emptied, so an invalid key, a 401, or an SDK that never
    // answered all reported success. Now: no credential is exit 2 naming the
    // variables, an error frame is exit 1, the deadline is exit 3, and 0 needs
    // assistant text with no error.
    const gap = smokeCredentialGap()
    if (gap) {
      console.error(`[sidecar smoke] no credential: set one of ${gap.join(", ")}`)
      process.exit(2)
    }
    const timeoutMs = Number(process.env.COGNIA_SMOKE_TIMEOUT_MS) || SMOKE_DEFAULT_TIMEOUT_MS
    const state: SmokeState = {
      sawAssistantText: false,
      sawError: false,
      errorReason: null,
      timedOut: false,
      timeoutMs,
    }
    const observer = (payload: unknown) =>
      smokeObserveFrame(state, payload as Parameters<typeof smokeObserveFrame>[1])
    emitObservers.add(observer)
    console.error(`[sidecar smoke] starting… (deadline ${timeoutMs}ms)`)
    const deadline = Date.now() + timeoutMs
    const s = startSession("smoke-1", "Reply with the single word PONG.")
    if (!s) {
      state.sawError = true
      state.errorReason = "startSession returned null"
    }
    while (sessions.has("smoke-1") && !state.sawError) {
      if (Date.now() >= deadline) {
        state.timedOut = true
        try {
          routeClose(sessions, { type: "close", sessionId: "smoke-1" }, log)
        } catch {
          // Best effort; the deadline already decided the outcome.
        }
        break
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    emitObservers.delete(observer)
    const outcome = smokeOutcome(state)
    console.error(`[sidecar smoke] ${outcome.code === 0 ? "ok" : "FAILED"}: ${outcome.reason}`)
    await shutdownHostTelemetry()
    process.exit(outcome.code)
  }

  function installUncaughtErrorGuards() {
    const guard = createUncaughtErrorGuard({ log, exit: (code) => process.exit(code) })
    process.on("uncaughtException", (err) => guard("uncaughtException", err))
    process.on("unhandledRejection", (err) => guard("unhandledRejection", err))
  }

  function startReadLoop() {
    const rl = readline.createInterface({ input: process.stdin })
    rl.on("line", (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let msg
      try {
        msg = parseHostMessage(JSON.parse(trimmed) as unknown)
        if (!msg) {
          log("error", "bad JSON line: expected command frame")
          return
        }
      } catch (err) {
        log("error", `bad JSON line: ${errorMessage(err)}`)
        return
      }
      if (dropDuplicateCommand(sessions, msg, emit, commandLedger)) return
      if (blockUnsupportedCommand(sessions, msg, emit)) return
      routeCommand(msg, {
        emit,
        log,
        sessions,
        handlers: {
          send: handleSend,
          interrupt: handleInterrupt,
          compact: handleCompact,
          restore: handleRestore,
          set_mode: handleSetMode,
          control: handleControl,
          session_api: (m) =>
            // Session-level reads and mutations that need no live session (list,
            // rename, fork, import, …). Separate from `control` because those
            // resolve a running query by id and these deliberately do not.
            handleSessionApi(m as HostMessage, {
              emit,
              store: sessionStoreFromSendOptions(m?.sendOptions ?? {}, { hostRpc, log }),
            }),
          feature_call: (m) => featureCalls.call(m as unknown as FeatureCallMessage),
          feature_call_abort: (m) => featureCalls.abort((m as HostMessage).requestId),
          permission_response: handlePermissionResponse,
          plugin_tool_response: handlePluginToolResponse,
          plugin_hook_response: handlePluginHookResponse,
          // Answered by Rust directly (never by the renderer) — see src/platform/host-rpc.ts.
          host_rpc_result: (m) => hostRpc.resolveResult(m),
          tool_result_decision: handleToolResultDecision,
          call_reserve_decision: (m) => {
            routeCallReserveDecision(sessions, m)
          },
          protocol_adapter_chunk: (m) => {
            if (!featureCalls.handleProtocolAdapterMessage(m)) handleProtocolAdapterChunk(m)
          },
          protocol_adapter_done: (m) => {
            if (!featureCalls.handleProtocolAdapterMessage(m)) handleProtocolAdapterDone(m)
          },
          protocol_adapter_error: (m) => {
            if (!featureCalls.handleProtocolAdapterMessage(m)) handleProtocolAdapterError(m)
          },
          close: handleClose,
        },
      })
    })
    rl.on("close", async () => {
      // Parent closed our stdin — shut down all sessions gracefully.
      // Fail in-flight host RPCs first: their replies can never arrive now, and
      // a tool awaiting one would otherwise hang until its own timeout.
      hostRpc.rejectAll("sidecar stdin closed")
      await featureCalls.close()
      for (const id of Array.from(sessions.keys())) {
        handleClose({ sessionId: id })
      }
      await shutdownHostTelemetry()
      process.exit(0)
    })

    const { sdkVersion, sidecarVersion } = readVersionInfo()
    emit({ type: "ready", sdkVersion, sidecarVersion })
    logv(`ready sdk=${sdkVersion ?? "?"} sidecar=${sidecarVersion ?? "?"}`)
  }

  let hostStarted = false

  function startAgentHost() {
    if (hostStarted) return
    hostStarted = true
    process.once("beforeExit", () => {
      void shutdownHostTelemetry()
      resetWarmPool()
    })
    installUncaughtErrorGuards()
    startReadLoop()
  }
  return { startAgentHost, smoke, emitObservers, emitForTests }
}
