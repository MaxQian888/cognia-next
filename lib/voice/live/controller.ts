/**
 * Live-voice session orchestrator.
 *
 * Wires the four primitives into one conversation and owns the ordering rules
 * that only make sense when you can see all of them at once:
 *
 *   transport ⇄ provider
 *       ↑ append frames          ↓ server events
 *   capture                   reducer (state) + playback (audio)
 *
 * Ordering rules encoded here:
 *
 * - **The microphone starts only after the session is configured.** Frames sent
 *   before `session-update` lands are interpreted against the provider's
 *   default VAD and voice, which is not what the user configured.
 *
 * - **Barge-in reads the played clock before cutting.** `playedMs()` rewinds as
 *   part of `interrupt()`, so the truncate message has to be computed first, or
 *   the provider's transcript keeps text the user never heard.
 *
 * - **Uplink resampling is conditional.** The capture graph is opened at the
 *   provider's wire rate and usually honours it; when an engine clamps to the
 *   hardware rate instead, frames are resampled rather than shipped at the
 *   wrong pitch.
 *
 * State is exposed as `subscribe`/`getSnapshot` so React can bind with
 * `useSyncExternalStore`. The reducer's referential stability is what keeps
 * that from re-rendering on every audio delta.
 */

import type {
  Experimental_RealtimeModelV4 as RealtimeModel,
  Experimental_RealtimeModelV4ServerEvent as RealtimeServerEvent,
  Experimental_RealtimeModelV4SessionConfig as RealtimeSessionConfig,
  Experimental_RealtimeModelV4ToolDefinition as RealtimeToolDefinition,
} from "@ai-sdk/provider"

import type { RealtimeToolPolicy } from "./approval"
import { LiveVoiceAudioGate, createLiveVoiceAudioGate } from "./audio-gate"
import {
  MicCapture,
  createMicCapture,
  type CaptureFrame,
  type MediaStreamLike,
  type MicCaptureOptions,
} from "./capture"
import { buildLiveVoiceContextEvent } from "./context"
import { encodeUplinkAudio, resampleAudio } from "./pcm-codec"
import {
  LiveVoicePlayback,
  createLiveVoicePlayback,
  type LiveVoicePlaybackOptions,
} from "./playback"
import {
  assertLiveVoicePayloadPiiSafe,
  classifyLiveVoiceError,
  createInitialLiveVoiceState,
  reduceLiveVoiceServerEvent,
  type LiveVoiceState,
} from "./reducer"
import {
  RealtimeToolRuntime,
  createRealtimeToolRuntime,
  serializeToolOutput,
  type RealtimeToolExecutionRequest,
  type RealtimeToolExecutionResult,
  type RealtimeToolRecord,
} from "./tool-runtime"
import {
  LiveVoiceTransport,
  createLiveVoiceTransport,
  type LiveVoiceTransportOptions,
} from "./transport"
import type { PreparedRealtimeSession } from "./types"
import { trackEvent } from "@/lib/telemetry/events/track-event"

const RECONNECT_DELAYS_MS = [0, 1_000, 2_000] as const

export interface RefreshedLiveVoiceSession {
  session: PreparedRealtimeSession
  adapter: RealtimeModel
  sessionConfig: RealtimeSessionConfig
}

/** 20 ms of audio at the provider's uplink rate. */
function frameSamplesFor(sampleRate: number): number {
  return Math.round(sampleRate / 50)
}

export interface LiveVoiceControllerOptions {
  session: PreparedRealtimeSession
  adapter: RealtimeModel
  /** Exact config used when minting the ephemeral token. */
  sessionConfig?: RealtimeSessionConfig
  /** Screened instructions; the caller is responsible for the PII gate. */
  instructions?: string
  voice?: string
  deviceId?: string
  /** Permission-preflight stream retained before token minting. */
  initialStream?: MediaStreamLike
  connectTimeoutMs?: number
  /** Re-mint the locked provider for transparent recovery. */
  reconnectSession?(options: { resumptionHandle?: string }): Promise<RefreshedLiveVoiceSession>
  /** Tool definitions to advertise. Omitted for providers without tool support. */
  tools?: RealtimeToolDefinition[]
  /**
   * How to actually run the tools in {@link tools}. Omit to advertise nothing
   * executable — a call that arrives anyway is answered with an error rather
   * than left hanging.
   */
  toolExecution?: {
    /** Chat session the approval cards belong to. */
    sessionId: string
    policy: RealtimeToolPolicy
    execute(request: RealtimeToolExecutionRequest): Promise<RealtimeToolExecutionResult>
  }
  /**
   * Rendered transcript of the conversation so far, injected once the socket
   * opens and before the microphone does. Already screened by the caller.
   */
  contextTranscript?: string
  onError?(error: Error): void
  onToolRecord?(record: RealtimeToolRecord): void

  // ── Seams ─────────────────────────────────────────────────────────
  createCapture?(options: MicCaptureOptions): MicCapture
  createPlayback?(options: LiveVoicePlaybackOptions): LiveVoicePlayback
  createTransport?(options: LiveVoiceTransportOptions): LiveVoiceTransport
  now?(): number
  sleep?(ms: number): Promise<void>
}

export class LiveVoiceController {
  private state: LiveVoiceState = createInitialLiveVoiceState()
  private readonly listeners = new Set<() => void>()
  private readonly inputLevelListeners = new Set<() => void>()
  private inputLevel = 0
  private lastInputLevelAt = Number.NEGATIVE_INFINITY
  private capture: MicCapture | null = null
  private playback: LiveVoicePlayback | null = null
  private transport: LiveVoiceTransport | null = null
  private activeSession: PreparedRealtimeSession
  private activeAdapter: RealtimeModel
  private activeSessionConfig?: RealtimeSessionConfig
  private resumptionHandle: string | undefined
  private reconnectGeneration = 0
  private reconnecting: Promise<void> | null = null
  private connectAbort: AbortController | null = null
  private connectionCount = 0
  private connectionStartedAt = 0
  private lastEndOfUtteranceAt: number | null = null
  private readiness: {
    promise: Promise<void>
    resolve(): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
    settled: boolean
  } | null = null
  private firstAudioFrame: {
    promise: Promise<void>
    resolve(): void
    reject(error: Error): void
    settled: boolean
  } | null = null
  private firstAudioFrameSent = false
  /** Item the assistant is currently speaking, needed to truncate on barge-in. */
  private assistantItemId: string | null = null
  private assistantResponseId: string | null = null
  private assistantResponseActive = false
  private assistantPlaybackEnded = false
  private suppressAssistantOutput = false
  private suppressedResponseId: string | null = null
  private pendingAssistantFinal: Extract<
    RealtimeServerEvent,
    { type: "audio-transcript-done" | "text-done" }
  > | null = null
  private started = false
  /**
   * Reference-counted hold on audio while tool approvals are up. Created once
   * per controller so a release issued during one session can be recognised as
   * stale by the next.
   */
  private readonly gate: LiveVoiceAudioGate = createLiveVoiceAudioGate({
    // Suspension is separate from the user's own mute: it silences the
    // microphone without overwriting what they chose.
    setMicrophoneEnabled: (enabled) => this.capture?.setMuted(!enabled),
    cancelResponse: () => this.transport?.send({ type: "response-cancel" }),
    interruptPlayback: () => this.playback?.interrupt(),
    isUserMuted: () => this.state.muted,
  })
  private toolRuntime: RealtimeToolRuntime | null = null

  constructor(private readonly options: LiveVoiceControllerOptions) {
    this.activeSession = options.session
    this.activeAdapter = options.adapter
    this.activeSessionConfig = options.sessionConfig
  }

  // ── External store ──────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): LiveVoiceState => this.state

  /** Independent 10 Hz meter store; audio frames never update session state. */
  subscribeInputLevel = (listener: () => void): (() => void) => {
    this.inputLevelListeners.add(listener)
    return () => this.inputLevelListeners.delete(listener)
  }

  getInputLevelSnapshot = (): number => this.inputLevel

  getToolRecords = (): readonly RealtimeToolRecord[] => this.toolRuntime?.records ?? []

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Dial the provider, configure the session, then open the microphone. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.connectionCount = 0
    this.resumptionHandle = undefined
    this.lastEndOfUtteranceAt = null
    this.lastInputLevelAt = Number.NEGATIVE_INFINITY
    this.inputLevel = 0
    this.assistantItemId = null
    this.assistantResponseId = null
    this.assistantResponseActive = false
    this.assistantPlaybackEnded = false
    this.suppressAssistantOutput = false
    this.suppressedResponseId = null
    this.pendingAssistantFinal = null
    this.beginFirstAudioFrame()
    this.setState({ ...createInitialLiveVoiceState(), phase: "connecting" })

    const { toolExecution, createPlayback = createLiveVoicePlayback } = this.options

    this.toolRuntime = toolExecution
      ? createRealtimeToolRuntime({
          sessionId: toolExecution.sessionId,
          policy: toolExecution.policy,
          gate: this.gate,
          send: (event) => this.transport?.send(event),
          execute: toolExecution.execute,
          onError: (error) => this.options.onError?.(error),
          onRecord: (record) => {
            this.options.onToolRecord?.(record)
            void trackEvent("voice.tool.completed", {
              provider: this.activeSession.provider,
              status: record.status,
              durationMs: record.durationMs,
            })
          },
        })
      : null

    this.playback = createPlayback({
      sampleRate: this.activeSession.capabilities.outputSampleRate,
      onError: (error) => this.fail(error),
      onEnded: () => this.handlePlaybackEnded(),
    })

    try {
      await this.connectActiveSession()
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      await this.stop()
      throw error
    }
  }

  /** Mute or unmute the microphone. */
  setMuted(muted: boolean): void {
    this.capture?.setMuted(muted)
    // Drop whatever partial utterance the server buffered, so unmuting cannot
    // commit half a sentence recorded before the mute.
    if (muted) this.transport?.send({ type: "input-audio-clear" })
    this.setState({ ...this.state, muted })
    if (muted) this.setInputLevel(0)
  }

  /** Switch microphone without dropping the socket. */
  async setDevice(deviceId: string | undefined): Promise<void> {
    await this.capture?.setDevice(deviceId)
  }

  /** Reset the retry budget after the user explicitly asks to try again. */
  async retry(): Promise<void> {
    if (!this.started || this.reconnecting) return
    this.connectAbort?.abort()
    this.connectAbort = null
    this.rejectReadiness(new Error("live voice readiness was superseded"))
    this.toolRuntime?.reset()
    this.playback?.interrupt()
    const transport = this.transport
    this.transport = null
    transport?.close(4004, "manual reconnect")
    await this.reconnect(true)
  }

  /** Wait until the provider acknowledged config and the microphone is live. */
  waitUntilReady(): Promise<void> {
    return this.readiness?.promise ?? Promise.resolve()
  }

  /** Wait until uplink audio is queued; provider fallback remains legal before this point. */
  waitUntilFirstAudioFrame(): Promise<void> {
    return this.firstAudioFrame?.promise ?? Promise.resolve()
  }

  /** Tear the session down. Safe to call repeatedly. */
  async stop(): Promise<void> {
    this.started = false
    this.reconnectGeneration++
    this.connectAbort?.abort()
    this.connectAbort = null
    this.rejectReadiness(new Error("live voice connection was cancelled"))
    this.rejectFirstAudioFrame(new Error("live voice connection was cancelled"))
    this.assistantItemId = null
    this.pendingAssistantFinal = null
    this.suppressAssistantOutput = false
    this.suppressedResponseId = null
    // Invalidate before tearing anything down: a tool still running must not be
    // able to send its result into whatever session replaces this one, and its
    // gate release must not unmute that session's microphone.
    this.toolRuntime?.reset()
    this.toolRuntime = null
    this.gate.reset()
    const capture = this.capture
    this.capture = null
    await capture?.dispose()
    this.playback?.stop()
    this.playback = null
    this.transport?.close(1000, "client ended session")
    this.transport = null
    this.reconnecting = null
    this.inputLevel = 0
    this.setState(createInitialLiveVoiceState())
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async handleOpen(): Promise<void> {
    const { instructions, voice, tools } = this.options
    const session = this.activeSession
    const capabilities = session.capabilities

    const config: RealtimeSessionConfig = this.activeSessionConfig ?? {
      ...(instructions ? { instructions } : {}),
      ...(voice ? { voice } : {}),
      outputModalities: ["audio"],
      inputAudioFormat: { type: "audio/pcm", rate: capabilities.inputSampleRate },
      outputAudioFormat: { type: "audio/pcm", rate: capabilities.outputSampleRate },
      ...(capabilities.supportsInputTranscript ? { inputAudioTranscription: {} } : {}),
      ...(capabilities.supportsOutputTranscript ? { outputAudioTranscription: {} } : {}),
      ...(capabilities.supportsServerVad
        ? {
            turnDetection: {
              type:
                session.provider === "openai" ? ("semantic-vad" as const) : ("server-vad" as const),
            },
          }
        : { turnDetection: null }),
      // A provider with tools dormant must not be sent any, even if the caller
      // passed some — the capability table is the authority.
      ...(capabilities.supportsTools && tools?.length ? { tools } : {}),
    }

    assertLiveVoicePayloadPiiSafe(config)
    this.transport?.send({ type: "session-update", config })
  }

  private seedProviderContext(): void {
    // Seed the conversation before the microphone opens, so the model is
    // already oriented on the user's first word rather than a sentence later.
    const { contextTranscript } = this.options
    if (this.connectionCount === 1 && contextTranscript) {
      this.transport?.send(buildLiveVoiceContextEvent(contextTranscript))
    }

    if (this.connectionCount > 1 && this.activeSession.provider !== "google") {
      const completedTranscript = this.state.turns
        .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`)
        .join("\n")
      if (completedTranscript) {
        // RealtimeModelV4 only accepts user-authored client text. Send one
        // explicitly labelled transcript rather than forging assistant items;
        // drafts and pending tool state never enter `state.turns`.
        this.transport?.send(buildLiveVoiceContextEvent(completedTranscript))
      }
    }
  }

  private async finishProviderReadiness(): Promise<void> {
    const readiness = this.readiness
    if (!readiness || readiness.settled) return
    readiness.settled = true
    clearTimeout(readiness.timer)
    try {
      this.seedProviderContext()
      if (!this.capture) await this.openMicrophone()
      else {
        this.setState({
          ...this.state,
          phase: "listening",
          error: undefined,
          errorInfo: undefined,
          reconnect: undefined,
        })
      }
      void trackEvent("voice.connection.ready", {
        provider: this.activeSession.provider,
        durationMs: Math.max(0, (this.options.now ?? Date.now)() - this.connectionStartedAt),
      })
      readiness.resolve()
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      readiness.reject(error)
      this.fail(error)
    }
  }

  private async openMicrophone(): Promise<void> {
    const { deviceId, initialStream, createCapture = createMicCapture } = this.options
    const session = this.activeSession
    const wireRate = session.capabilities.inputSampleRate

    const capture = createCapture({
      sampleRate: wireRate,
      frameSamples: frameSamplesFor(wireRate),
      deviceId,
      initialStream,
      onFrame: (frame) => this.sendFrame(frame),
      onError: (error) => this.fail(error),
    })

    await capture.start()
    this.capture = capture
    if (this.state.muted) capture.setMuted(true)
    this.setState({ ...this.state, phase: "listening", error: undefined })
  }

  private sendFrame(frame: CaptureFrame): void {
    const capture = this.capture
    const transport = this.transport
    if (!capture || !transport) return

    const wireRate = this.activeSession.capabilities.inputSampleRate
    this.publishInputLevel(frame.rms)
    const payload = capture.sampleRateMatches
      ? frame.samples
      : resampleAudio(frame.samples, capture.sampleRate, wireRate)

    transport.send({ type: "input-audio-append", audio: encodeUplinkAudio(payload) })
    this.resolveFirstAudioFrame()
  }

  private handleServerEvent(event: RealtimeServerEvent): void {
    if (event.type === "response-created") {
      this.beginAssistantResponse(event.responseId)
    } else if (this.suppressAssistantOutput && this.isAssistantOutputEvent(event)) {
      const responseId = this.assistantEventResponseId(event)
      if (!responseId || responseId === this.suppressedResponseId) return
      // Gemini does not emit response-created. Its mapper advances the
      // synthetic responseId on the first event of the next model turn.
      this.beginAssistantResponse(responseId)
    } else if (this.isAssistantOutputEvent(event)) {
      const responseId = this.assistantEventResponseId(event)
      if (responseId && responseId !== this.assistantResponseId) {
        this.beginAssistantResponse(responseId)
      }
    }

    const providerReady =
      (this.activeSession.provider === "google" && event.type === "session-created") ||
      (this.activeSession.provider !== "google" && event.type === "session-updated")
    if (providerReady) void this.finishProviderReadiness()

    switch (event.type) {
      case "audio-delta":
        if (this.lastEndOfUtteranceAt !== null) {
          void trackEvent("voice.first-audio", {
            provider: this.activeSession.provider,
            eouToAudioMs: Math.max(0, (this.options.now ?? Date.now)() - this.lastEndOfUtteranceAt),
          })
          this.lastEndOfUtteranceAt = null
        }
        this.assistantResponseActive = true
        this.assistantPlaybackEnded = false
        this.assistantItemId = event.itemId
        this.playback?.enqueueBase64(event.delta)
        break
      case "audio-done":
        this.playback?.endTurn()
        break
      case "speech-started":
        this.bargeIn()
        break
      case "speech-stopped":
        this.lastEndOfUtteranceAt = (this.options.now ?? Date.now)()
        break
      case "response-done":
        this.assistantResponseActive = false
        if (this.playback?.state === "idle") this.commitPendingAssistantFinal()
        break
      case "audio-transcript-delta":
      case "text-delta":
        this.assistantResponseActive = true
        this.assistantItemId = event.itemId
        break
      case "audio-transcript-done":
      case "text-done":
        this.assistantItemId = event.itemId
        this.pendingAssistantFinal = event
        if (this.assistantPlaybackEnded) this.commitPendingAssistantFinal()
        // A final transcript is not verified until queued audio drains (or a
        // text-only response completes). Do not let the generic reducer persist it yet.
        return
      case "function-call-arguments-done":
        this.runToolCall(event)
        break
      case "custom":
        this.handleCustomEvent(event)
        break
      default:
        break
    }

    this.setState(reduceLiveVoiceServerEvent(this.state, event))
  }

  /**
   * Run a tool the model asked for.
   *
   * When no executor was configured the call is still answered: a function call
   * left without an output stalls the model mid-conversation with the
   * microphone open, which reads to the user as the assistant having frozen.
   */
  private runToolCall(
    event: Extract<RealtimeServerEvent, { type: "function-call-arguments-done" }>
  ): void {
    const call = { callId: event.callId, name: event.name, arguments: event.arguments }

    if (!this.toolRuntime) {
      this.transport?.send({
        type: "conversation-item-create",
        item: {
          type: "function-call-output",
          callId: call.callId,
          name: call.name,
          output: serializeToolOutput({ error: "tool calling is not available in this session" }),
        },
      })
      this.transport?.send({ type: "response-create" })
      return
    }

    // Fire and forget: the runtime never rejects and owns its own error paths,
    // and blocking the event loop here would stall inbound audio.
    void this.toolRuntime.handleToolCall(call)
  }

  /**
   * The user started talking over the assistant. Stop the audio and tell the
   * provider how much of its reply was actually heard, so its transcript
   * matches the conversation the user experienced.
   */
  private bargeIn(): void {
    const playback = this.playback
    if (!playback) return

    const playbackActive = playback.state === "playing" || playback.state === "paused"
    const interrupted = playbackActive || this.assistantResponseActive
    if (!interrupted) {
      this.assistantItemId = null
      return
    }
    this.suppressAssistantOutput = true
    this.suppressedResponseId = this.assistantResponseId
    this.assistantResponseActive = false

    // Stop generation at the source before reconciling local playback. The
    // provider adapters that expose cancellation serialize this immediately;
    // adapters whose server already reported an interruption may no-op it.
    this.transport?.send({ type: "response-cancel" })

    // Read before interrupting — `interrupt()` rewinds the played clock.
    const audioEndMs = playback.playedMs()
    playback.interrupt()
    void trackEvent("voice.interrupted", {
      provider: this.activeSession.provider,
      playedMs: audioEndMs,
    })

    const itemId = this.assistantItemId
    if (playbackActive && itemId && audioEndMs > 0) {
      this.transport?.send({
        type: "conversation-item-truncate",
        itemId,
        contentIndex: 0,
        audioEndMs,
      })
    }
    if (playbackActive || !this.assistantPlaybackEnded) {
      this.pendingAssistantFinal = null
      this.setState({
        ...this.state,
        assistantDraft: "",
        turns: itemId ? this.state.turns.filter((turn) => turn.id !== itemId) : this.state.turns,
      })
    }
    this.assistantItemId = null
  }

  private handleClose(): void {
    if (!this.started) return
    const error = new Error("Realtime connection was lost")
    this.rejectReadiness(error)
    this.transport = null
    if (this.reconnecting) return
    this.toolRuntime?.reset()
    if (!this.firstAudioFrameSent) {
      this.rejectFirstAudioFrame(error)
      this.fail(error)
      return
    }
    if (!this.capture || !this.options.reconnectSession) {
      this.fail(new Error("Realtime connection was lost"))
      return
    }
    void this.reconnect(false)
  }

  private fail(error: Error): void {
    if (!this.firstAudioFrameSent) this.rejectFirstAudioFrame(error)
    this.options.onError?.(error)
    const errorInfo = classifyLiveVoiceError(error)
    void trackEvent("voice.error", {
      provider: this.activeSession.provider,
      code: errorInfo.code,
    })
    this.setState({
      ...this.state,
      phase: "error",
      error: errorInfo.message,
      errorInfo,
      reconnect: undefined,
    })
  }

  private setState(next: LiveVoiceState): void {
    if (next === this.state) return
    this.state = next
    for (const listener of this.listeners) listener()
  }

  private publishInputLevel(rms: number): void {
    const now = (this.options.now ?? Date.now)()
    if (now - this.lastInputLevelAt < 100) return
    this.lastInputLevelAt = now
    const next = this.state.muted ? 0 : Math.max(0, Math.min(1, rms))
    this.setInputLevel(next)
  }

  private setInputLevel(next: number): void {
    if (next === this.inputLevel) return
    this.inputLevel = next
    for (const listener of this.inputLevelListeners) listener()
  }

  private async connectActiveSession(): Promise<void> {
    const { createTransport = createLiveVoiceTransport } = this.options
    this.beginReadiness()
    const transport = createTransport({
      adapter: this.activeAdapter,
      onServerEvent: (event) => {
        if (this.transport === transport) this.handleServerEvent(event)
      },
      onOpen: () => {
        if (this.transport !== transport) return
        this.connectionCount++
        void this.handleOpen().catch((cause) => {
          const error = cause instanceof Error ? cause : new Error(String(cause))
          this.started = false
          this.rejectReadiness(error)
          this.fail(error)
          this.transport?.close(4003, "session config rejected")
          this.transport = null
        })
      },
      onClose: () => {
        if (this.transport === transport) this.handleClose()
      },
      onError: (error) => {
        if (this.transport === transport) this.fail(error)
      },
    })
    this.transport = transport
    this.connectionStartedAt = (this.options.now ?? Date.now)()
    const abort = new AbortController()
    this.connectAbort = abort
    try {
      await transport.connect(this.activeSession, {
        timeoutMs: this.options.connectTimeoutMs ?? 10_000,
        signal: abort.signal,
      })
    } finally {
      if (this.connectAbort === abort) this.connectAbort = null
    }
  }

  private reconnect(manual: boolean): Promise<void> {
    if (this.reconnecting) return this.reconnecting
    const generation = ++this.reconnectGeneration
    const run = this.runReconnectAttempts(generation, manual).finally(() => {
      if (this.reconnectGeneration === generation) this.reconnecting = null
    })
    this.reconnecting = run
    return run
  }

  private async runReconnectAttempts(generation: number, manual: boolean): Promise<void> {
    const sleep =
      this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
    let lastError = new Error("Realtime connection was lost")

    for (let index = 0; index < RECONNECT_DELAYS_MS.length; index++) {
      if (!this.started || generation !== this.reconnectGeneration) return
      const attempt = index + 1
      this.setState({
        ...this.state,
        phase: "reconnecting",
        error: undefined,
        errorInfo: undefined,
        reconnect: { attempt, maxAttempts: RECONNECT_DELAYS_MS.length },
      })
      void trackEvent("voice.reconnect", {
        provider: this.activeSession.provider,
        attempt,
        outcome: "started",
      })
      if (RECONNECT_DELAYS_MS[index] > 0) await sleep(RECONNECT_DELAYS_MS[index])
      if (!this.started || generation !== this.reconnectGeneration) return

      try {
        const refreshed = await this.options.reconnectSession?.({
          resumptionHandle:
            this.activeSession.provider === "google" ? this.resumptionHandle : undefined,
        })
        if (!refreshed) throw new Error("Realtime reconnect is unavailable")
        if (refreshed.session.provider !== this.activeSession.provider) {
          throw new Error("Realtime reconnect attempted to switch providers")
        }
        this.activeSession = refreshed.session
        this.activeAdapter = refreshed.adapter
        this.activeSessionConfig = refreshed.sessionConfig
        await this.connectActiveSession()
        await this.waitUntilReady()
        void trackEvent("voice.reconnect", {
          provider: this.activeSession.provider,
          attempt,
          outcome: "succeeded",
        })
        return
      } catch (cause) {
        lastError = cause instanceof Error ? cause : new Error(String(cause))
        this.transport?.close(4001, "reconnect attempt failed")
        this.transport = null
        void trackEvent("voice.reconnect", {
          provider: this.activeSession.provider,
          attempt,
          outcome: "failed",
        })
      }
    }

    if (manual || this.started) this.fail(lastError)
  }

  private handleCustomEvent(event: Extract<RealtimeServerEvent, { type: "custom" }>): void {
    if (this.activeSession.provider !== "google") return
    const raw = event.raw as
      | {
          sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean }
          goAway?: { timeLeft?: string }
          toolCallCancellation?: { ids?: string[] }
        }
      | undefined
    if (event.rawType === "toolCallCancellation") {
      for (const callId of raw?.toolCallCancellation?.ids ?? []) this.toolRuntime?.cancel(callId)
      return
    }
    if (event.rawType === "sessionResumptionUpdate") {
      const update = raw?.sessionResumptionUpdate
      if (update?.resumable && update.newHandle) this.resumptionHandle = update.newHandle
      return
    }
    if (event.rawType === "goAway" && this.capture && !this.reconnecting) {
      this.toolRuntime?.reset()
      const transport = this.transport
      this.transport = null
      transport?.close(4002, "provider requested reconnect")
      if (!this.firstAudioFrameSent) {
        const error = new Error("Realtime connection was lost before the first audio frame")
        this.rejectFirstAudioFrame(error)
        this.fail(error)
        return
      }
      void this.reconnect(false)
    }
  }

  private isAssistantOutputEvent(event: RealtimeServerEvent): boolean {
    return (
      event.type === "audio-delta" ||
      event.type === "audio-done" ||
      event.type === "audio-transcript-delta" ||
      event.type === "audio-transcript-done" ||
      event.type === "text-delta" ||
      event.type === "text-done" ||
      event.type === "response-done" ||
      event.type === "function-call-arguments-delta" ||
      event.type === "function-call-arguments-done"
    )
  }

  private assistantEventResponseId(event: RealtimeServerEvent): string | null {
    return "responseId" in event && typeof event.responseId === "string" ? event.responseId : null
  }

  private beginAssistantResponse(responseId: string): void {
    this.suppressAssistantOutput = false
    this.suppressedResponseId = null
    this.assistantResponseId = responseId
    this.assistantResponseActive = true
    this.assistantItemId = null
    this.assistantPlaybackEnded = false
    this.pendingAssistantFinal = null
  }

  private handlePlaybackEnded(): void {
    this.assistantPlaybackEnded = true
    this.commitPendingAssistantFinal()
  }

  private commitPendingAssistantFinal(): void {
    const pending = this.pendingAssistantFinal
    if (!pending || this.suppressAssistantOutput) return
    this.pendingAssistantFinal = null
    this.setState(reduceLiveVoiceServerEvent(this.state, pending))
  }

  private beginFirstAudioFrame(): void {
    this.rejectFirstAudioFrame(new Error("live voice first audio wait was superseded"))
    let resolvePromise: () => void = () => undefined
    let rejectPromise: (error: Error) => void = () => undefined
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    void promise.catch(() => undefined)
    this.firstAudioFrameSent = false
    this.firstAudioFrame = {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      settled: false,
    }
  }

  private resolveFirstAudioFrame(): void {
    const first = this.firstAudioFrame
    if (!first || first.settled) return
    first.settled = true
    this.firstAudioFrameSent = true
    first.resolve()
  }

  private rejectFirstAudioFrame(error: Error): void {
    const first = this.firstAudioFrame
    if (!first || first.settled) return
    first.settled = true
    first.reject(error)
  }

  private beginReadiness(): void {
    this.rejectReadiness(new Error("live voice readiness was superseded"))
    let resolvePromise: () => void = () => undefined
    let rejectPromise: (error: Error) => void = () => undefined
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    void promise.catch(() => undefined)
    const timeoutMs = this.options.connectTimeoutMs ?? 10_000
    const readiness = {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer: setTimeout(() => {
        const error = new Error(`live voice provider readiness timed out after ${timeoutMs}ms`)
        this.rejectReadiness(error)
        this.fail(error)
      }, timeoutMs),
      settled: false,
    }
    ;(readiness.timer as unknown as { unref?: () => void }).unref?.()
    this.readiness = readiness
  }

  private rejectReadiness(error: Error): void {
    const readiness = this.readiness
    if (!readiness || readiness.settled) return
    readiness.settled = true
    clearTimeout(readiness.timer)
    readiness.reject(error)
  }
}

export function createLiveVoiceController(
  options: LiveVoiceControllerOptions
): LiveVoiceController {
  return new LiveVoiceController(options)
}
