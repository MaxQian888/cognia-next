/**
 * Microphone capture for live voice.
 *
 * The retiring WebRTC session handed raw `MediaStreamTrack`s to a peer
 * connection and never saw a sample. A WebSocket transport has to produce the
 * PCM itself, so this module owns the graph:
 *
 *   getUserMedia → MediaStreamAudioSourceNode → AudioWorkletNode → onFrame
 *
 * Design notes that are load-bearing:
 *
 * - **The browser does the resampling.** The context is opened at the
 *   provider's wire rate, so no JS resampler sits on the hot path. Some
 *   engines (notably WKWebView) silently clamp to the hardware rate, so the
 *   actual rate is reported back via {@link MicCapture.sampleRate}; the caller
 *   resamples only on a mismatch. Skipping that check ships chipmunk audio
 *   that otherwise looks like it works.
 *
 * - **Mute is enforced in two places.** `track.enabled = false` drives the OS
 *   microphone indicator, which users check; the worklet also drops its partial
 *   frame so no half-utterance is committed when the user unmutes.
 *
 * - **Device switches never tear down the graph.** A new stream is acquired
 *   *before* the old one is released, so a failed switch leaves the existing
 *   microphone running rather than killing the session.
 *
 * Every Web Audio and media entry point is injectable, so the whole module is
 * testable in the `node` Jest project without a DOM.
 */

import { CAPTURE_PROCESSOR_NAME, buildCaptureWorkletSource } from "./capture-worklet-source"

export interface CaptureFrame {
  /** Exactly `frameSamples` values in [-1, 1], at {@link MicCapture.sampleRate}. */
  samples: Float32Array
  /** Root-mean-square level of this frame, in [0, 1]. */
  rms: number
}

export interface MediaStreamTrackLike {
  enabled: boolean
  stop(): void
}

export interface MediaStreamLike {
  getAudioTracks(): MediaStreamTrackLike[]
  getTracks(): MediaStreamTrackLike[]
}

export interface AudioNodeLike {
  connect(target: AudioNodeLike): void
  disconnect(): void
}

export interface WorkletNodeLike extends AudioNodeLike {
  port: {
    onmessage: ((event: { data: unknown }) => void) | null
    postMessage(message: unknown): void
  }
}

export interface CaptureContextLike {
  readonly sampleRate: number
  readonly state: string
  createMediaStreamSource(stream: MediaStreamLike): AudioNodeLike
  audioWorklet?: { addModule(url: string): Promise<void> }
  resume(): Promise<void>
  close(): Promise<void>
}

export interface MicCaptureOptions {
  /** Provider wire rate, e.g. 24000 for OpenAI or 16000 for Gemini Live. */
  sampleRate: number
  /** Samples per emitted frame at `sampleRate`. */
  frameSamples: number
  deviceId?: string
  onFrame(frame: CaptureFrame): void
  /** Reports a fatal capture error; the session should surface and stop. */
  onError?(error: Error): void
  /** Stream acquired during permission preflight, before any token is minted. */
  initialStream?: MediaStreamLike

  // ── Seams (tests inject; production uses the real APIs) ──────────────
  audioContextFactory?(options: { sampleRate: number }): CaptureContextLike
  getUserMedia?(constraints: unknown): Promise<MediaStreamLike>
  /** `AudioWorkletNode` is a global constructor, not a context method. */
  createWorkletNode?(context: CaptureContextLike, name: string): WorkletNodeLike
  createModuleUrl?(source: string): string
  revokeModuleUrl?(url: string): void
}

function defaultAudioContextFactory(options: { sampleRate: number }): CaptureContextLike {
  const Ctor =
    (globalThis as { AudioContext?: new (o: unknown) => CaptureContextLike }).AudioContext ??
    (globalThis as { webkitAudioContext?: new (o: unknown) => CaptureContextLike })
      .webkitAudioContext
  if (!Ctor) throw new Error("Web Audio API is not available in this environment")
  return new Ctor({ sampleRate: options.sampleRate, latencyHint: "interactive" })
}

function defaultGetUserMedia(constraints: unknown): Promise<MediaStreamLike> {
  const media = (
    globalThis as {
      navigator?: { mediaDevices?: { getUserMedia(c: unknown): Promise<MediaStreamLike> } }
    }
  ).navigator?.mediaDevices
  if (!media) throw new Error("microphone capture is not available in this environment")
  return media.getUserMedia(constraints)
}

/** Acquire and retain the selected microphone before contacting a provider. */
export function preflightMicrophone(
  deviceId?: string,
  getUserMedia: (constraints: unknown) => Promise<MediaStreamLike> = defaultGetUserMedia
): Promise<MediaStreamLike> {
  return getUserMedia(buildAudioConstraints(deviceId))
}

function defaultCreateWorkletNode(context: CaptureContextLike, name: string): WorkletNodeLike {
  // `as unknown as` because lib.dom already declares a differently-shaped
  // `AudioWorkletNode`, so a direct assertion is rejected as non-overlapping.
  const Ctor = (
    globalThis as unknown as {
      AudioWorkletNode?: new (c: CaptureContextLike, n: string) => WorkletNodeLike
    }
  ).AudioWorkletNode
  if (!Ctor) throw new Error("AudioWorklet is not available in this environment")
  return new Ctor(context, name)
}

function defaultCreateModuleUrl(source: string): string {
  return URL.createObjectURL(new Blob([source], { type: "text/javascript" }))
}

/** Constraints that ask the platform for clean, single-channel voice input. */
export function buildAudioConstraints(deviceId?: string): {
  audio: Record<string, unknown>
} {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: 1,
      // Echo cancellation is the first line of defence against the model
      // interrupting itself once playback and capture share a device.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  }
}

export class MicCapture {
  private readonly options: Required<
    Pick<MicCaptureOptions, "sampleRate" | "frameSamples" | "onFrame">
  > &
    MicCaptureOptions
  private context: CaptureContextLike | null = null
  private stream: MediaStreamLike | null = null
  private source: AudioNodeLike | null = null
  private worklet: WorkletNodeLike | null = null
  private muted = false
  private disposed = false

  constructor(options: MicCaptureOptions) {
    this.options = options as MicCapture["options"]
  }

  /**
   * The rate the graph actually runs at, which may differ from the requested
   * one. Callers must resample when it does not match the provider's wire rate.
   */
  get sampleRate(): number {
    return this.context?.sampleRate ?? this.options.sampleRate
  }

  /** Whether the requested rate was honoured. */
  get sampleRateMatches(): boolean {
    return this.sampleRate === this.options.sampleRate
  }

  get isMuted(): boolean {
    return this.muted
  }

  get isRunning(): boolean {
    return this.worklet !== null
  }

  /** Acquire the microphone and start emitting frames. Idempotent. */
  async start(): Promise<void> {
    if (this.disposed) throw new Error("MicCapture has been disposed")
    if (this.worklet) return

    const {
      sampleRate,
      frameSamples,
      deviceId,
      initialStream,
      audioContextFactory = defaultAudioContextFactory,
      getUserMedia = defaultGetUserMedia,
      createWorkletNode = defaultCreateWorkletNode,
      createModuleUrl = defaultCreateModuleUrl,
      revokeModuleUrl = (url: string) => URL.revokeObjectURL(url),
    } = this.options

    // Acquire the microphone first: the permission prompt can take many
    // seconds, and an ephemeral session token minted before it would burn most
    // of its ~60s lifetime waiting for the user.
    const stream = initialStream ?? (await getUserMedia(buildAudioConstraints(deviceId)))
    this.options.initialStream = undefined

    let context: CaptureContextLike | null = null
    try {
      context = audioContextFactory({ sampleRate })
      if (!context.audioWorklet) {
        throw new Error("AudioWorklet is not supported in this environment")
      }

      const moduleUrl = createModuleUrl(buildCaptureWorkletSource({ frameSamples }))
      try {
        await context.audioWorklet.addModule(moduleUrl)
      } finally {
        revokeModuleUrl(moduleUrl)
      }

      const worklet = createWorkletNode(context, CAPTURE_PROCESSOR_NAME)
      worklet.port.onmessage = (event) => this.handleWorkletMessage(event.data)

      const source = context.createMediaStreamSource(stream)
      source.connect(worklet)

      // A suspended context produces no render quanta at all. Resume is safe to
      // call when already running.
      if (context.state === "suspended") await context.resume()

      this.context = context
      this.stream = stream
      this.source = source
      this.worklet = worklet
      // Re-apply a mute requested before start so state can't silently drop.
      if (this.muted) this.applyMute(true)
    } catch (error) {
      for (const track of stream.getTracks()) track.stop()
      if (context) await context.close().catch(() => undefined)
      throw error
    }
  }

  /**
   * Mute or unmute. Keeps the graph and level meter alive so the UI can show
   * "muted, zero level" rather than freezing.
   */
  setMuted(muted: boolean): void {
    this.muted = muted
    if (this.worklet) this.applyMute(muted)
  }

  /**
   * Switch input device without dropping the socket or re-adding the worklet
   * module. The new stream is acquired before the old one is released.
   */
  async setDevice(deviceId: string | undefined): Promise<void> {
    this.options.deviceId = deviceId
    if (!this.context || !this.worklet) return

    const getUserMedia = this.options.getUserMedia ?? defaultGetUserMedia
    const next = await getUserMedia(buildAudioConstraints(deviceId))
    const previous = this.stream

    this.source?.disconnect()
    this.source = this.context.createMediaStreamSource(next)
    this.source.connect(this.worklet)
    this.stream = next
    if (this.muted) this.applyMute(true)

    for (const track of previous?.getTracks() ?? []) track.stop()
  }

  /** Drop any partially buffered frame — used when re-gating the microphone. */
  reset(): void {
    this.worklet?.port.postMessage({ type: "reset" })
  }

  /** Release the microphone and the audio graph. Safe to call repeatedly. */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.worklet) {
      this.worklet.port.onmessage = null
      this.worklet.disconnect()
      this.worklet = null
    }
    this.source?.disconnect()
    this.source = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    const context = this.context
    this.context = null
    if (context) await context.close().catch(() => undefined)
  }

  private applyMute(muted: boolean): void {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted
    this.worklet?.port.postMessage({ type: "mute", muted })
  }

  private handleWorkletMessage(data: unknown): void {
    if (!isFrameMessage(data)) return
    try {
      this.options.onFrame({ samples: data.samples, rms: data.rms })
    } catch (error) {
      // A throwing consumer must not kill the audio graph.
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

function isFrameMessage(data: unknown): data is { samples: Float32Array; rms: number } {
  if (typeof data !== "object" || data === null) return false
  const message = data as { type?: unknown; samples?: unknown; rms?: unknown }
  return (
    message.type === "frame" &&
    message.samples instanceof Float32Array &&
    typeof message.rms === "number"
  )
}

/** Convenience factory mirroring the rest of the module's function style. */
export function createMicCapture(options: MicCaptureOptions): MicCapture {
  return new MicCapture(options)
}
