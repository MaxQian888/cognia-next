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
import { MicCapture, createMicCapture, type MicCaptureOptions } from "./capture"
import { buildLiveVoiceContextEvent } from "./context"
import { encodeUplinkAudio, resampleAudio } from "./pcm-codec"
import {
  LiveVoicePlayback,
  createLiveVoicePlayback,
  type LiveVoicePlaybackOptions,
} from "./playback"
import {
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
} from "./tool-runtime"
import {
  LiveVoiceTransport,
  createLiveVoiceTransport,
  type LiveVoiceTransportOptions,
} from "./transport"
import type { PreparedRealtimeSession } from "./types"

/** 20 ms of audio at the provider's uplink rate. */
function frameSamplesFor(sampleRate: number): number {
  return Math.round(sampleRate / 50)
}

export interface LiveVoiceControllerOptions {
  session: PreparedRealtimeSession
  adapter: RealtimeModel
  /** Screened instructions; the caller is responsible for the PII gate. */
  instructions?: string
  voice?: string
  deviceId?: string
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

  // ── Seams ─────────────────────────────────────────────────────────
  createCapture?(options: MicCaptureOptions): MicCapture
  createPlayback?(options: LiveVoicePlaybackOptions): LiveVoicePlayback
  createTransport?(options: LiveVoiceTransportOptions): LiveVoiceTransport
}

export class LiveVoiceController {
  private state: LiveVoiceState = createInitialLiveVoiceState()
  private readonly listeners = new Set<() => void>()
  private capture: MicCapture | null = null
  private playback: LiveVoicePlayback | null = null
  private transport: LiveVoiceTransport | null = null
  /** Item the assistant is currently speaking, needed to truncate on barge-in. */
  private assistantItemId: string | null = null
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

  constructor(private readonly options: LiveVoiceControllerOptions) {}

  // ── External store ──────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): LiveVoiceState => this.state

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Dial the provider, configure the session, then open the microphone. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.setState({ ...createInitialLiveVoiceState(), phase: "connecting" })

    const {
      session,
      adapter,
      toolExecution,
      createPlayback = createLiveVoicePlayback,
      createTransport = createLiveVoiceTransport,
    } = this.options

    this.toolRuntime = toolExecution
      ? createRealtimeToolRuntime({
          sessionId: toolExecution.sessionId,
          policy: toolExecution.policy,
          gate: this.gate,
          send: (event) => this.transport?.send(event),
          execute: toolExecution.execute,
          onError: (error) => this.options.onError?.(error),
        })
      : null

    this.playback = createPlayback({
      sampleRate: session.capabilities.outputSampleRate,
      onError: (error) => this.fail(error),
    })

    this.transport = createTransport({
      adapter,
      onServerEvent: (event) => this.handleServerEvent(event),
      onOpen: () => {
        void this.handleOpen()
      },
      onClose: () => this.handleClose(),
      onError: (error) => this.fail(error),
    })

    try {
      this.transport.connect({ token: session.token, url: session.url })
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
  }

  /** Switch microphone without dropping the socket. */
  async setDevice(deviceId: string | undefined): Promise<void> {
    await this.capture?.setDevice(deviceId)
  }

  /** Tear the session down. Safe to call repeatedly. */
  async stop(): Promise<void> {
    this.started = false
    this.assistantItemId = null
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
    this.setState(createInitialLiveVoiceState())
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async handleOpen(): Promise<void> {
    const { session, instructions, voice, tools } = this.options
    const capabilities = session.capabilities

    const config: RealtimeSessionConfig = {
      ...(instructions ? { instructions } : {}),
      ...(voice ? { voice } : {}),
      outputModalities: ["audio"],
      inputAudioFormat: { type: "audio/pcm", rate: capabilities.inputSampleRate },
      outputAudioFormat: { type: "audio/pcm", rate: capabilities.outputSampleRate },
      ...(capabilities.supportsInputTranscript ? { inputAudioTranscription: {} } : {}),
      ...(capabilities.supportsOutputTranscript ? { outputAudioTranscription: {} } : {}),
      ...(capabilities.supportsServerVad
        ? { turnDetection: { type: "server-vad" as const } }
        : { turnDetection: null }),
      // A provider with tools dormant must not be sent any, even if the caller
      // passed some — the capability table is the authority.
      ...(capabilities.supportsTools && tools?.length ? { tools } : {}),
    }

    this.transport?.send({ type: "session-update", config })

    // Seed the conversation before the microphone opens, so the model is
    // already oriented on the user's first word rather than a sentence later.
    const { contextTranscript } = this.options
    if (contextTranscript) {
      this.transport?.send(buildLiveVoiceContextEvent(contextTranscript))
    }

    try {
      await this.openMicrophone()
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async openMicrophone(): Promise<void> {
    const { session, deviceId, createCapture = createMicCapture } = this.options
    const wireRate = session.capabilities.inputSampleRate

    const capture = createCapture({
      sampleRate: wireRate,
      frameSamples: frameSamplesFor(wireRate),
      deviceId,
      onFrame: (frame) => this.sendFrame(frame.samples),
      onError: (error) => this.fail(error),
    })

    await capture.start()
    this.capture = capture
    if (this.state.muted) capture.setMuted(true)
    this.setState({ ...this.state, phase: "listening", error: undefined })
  }

  private sendFrame(samples: Float32Array): void {
    const capture = this.capture
    const transport = this.transport
    if (!capture || !transport) return

    const wireRate = this.options.session.capabilities.inputSampleRate
    const payload = capture.sampleRateMatches
      ? samples
      : resampleAudio(samples, capture.sampleRate, wireRate)

    transport.send({ type: "input-audio-append", audio: encodeUplinkAudio(payload) })
  }

  private handleServerEvent(event: RealtimeServerEvent): void {
    switch (event.type) {
      case "audio-delta":
        this.assistantItemId = event.itemId
        this.playback?.enqueueBase64(event.delta)
        break
      case "audio-done":
        this.playback?.endTurn()
        break
      case "speech-started":
        this.bargeIn()
        break
      case "response-done":
        this.assistantItemId = null
        break
      case "function-call-arguments-done":
        this.runToolCall(event)
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

    // Read before interrupting — `interrupt()` rewinds the played clock.
    const audioEndMs = playback.playedMs()
    playback.interrupt()

    const itemId = this.assistantItemId
    if (itemId && audioEndMs > 0) {
      this.transport?.send({
        type: "conversation-item-truncate",
        itemId,
        contentIndex: 0,
        audioEndMs,
      })
    }
    this.assistantItemId = null
  }

  private handleClose(): void {
    if (!this.started) return
    this.setState({
      ...this.state,
      phase: "error",
      error: this.state.error ?? "Realtime connection was lost",
    })
  }

  private fail(error: Error): void {
    this.options.onError?.(error)
    this.setState({ ...this.state, phase: "error", error: error.message })
  }

  private setState(next: LiveVoiceState): void {
    if (next === this.state) return
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

export function createLiveVoiceController(
  options: LiveVoiceControllerOptions
): LiveVoiceController {
  return new LiveVoiceController(options)
}
