/**
 * Progressive PCM player — the live-playback primitive for streaming TTS
 * providers (OpenAI Realtime).
 *
 * Cloud REST providers return a finished audio buffer that the orchestrator
 * plays through an `<audio>` element. A streaming provider instead emits raw
 * 24kHz PCM16 mono deltas as they're synthesized; we schedule each delta back
 * to back on a Web Audio clock so playback starts on the first delta instead
 * of waiting for the whole utterance. The `<audio>`-element path can't do this
 * (it needs a complete, container-framed file), hence a separate player.
 */

export interface PcmPlayerOptions {
  /** Sample rate of the incoming PCM (OpenAI Realtime emits 24000). */
  sampleRate?: number
  /** 0..1 output gain. */
  volume?: number
  /** Injectable AudioContext factory (tests pass a fake). */
  audioContextFactory?: () => AudioContextLike
  onProgress?: (progress: number) => void
  onEnded?: () => void
  /**
   * Keep the audio context open when the current utterance drains.
   *
   * A TTS request plays once and is done, so the default is to close the
   * context and free the hardware. A live-voice conversation reuses one player
   * across many assistant turns — Chromium caps concurrent contexts at roughly
   * six, and re-opening one per turn also re-triggers autoplay gating. With
   * this set the player reports the turn as ended and returns to `idle`,
   * ready for the next delta, instead of transitioning to `ended`.
   */
  keepAlive?: boolean
}

/** The subset of the Web Audio API the player relies on. */
export interface AudioContextLike {
  readonly currentTime: number
  readonly destination: AudioNodeLike
  state: string
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike
  createBufferSource(): AudioBufferSourceLike
  createGain(): GainNodeLike
  suspend(): Promise<void>
  resume(): Promise<void>
  close(): Promise<void>
}

export interface AudioNodeLike {
  connect(target: AudioNodeLike): void
  disconnect(): void
}

export interface GainNodeLike extends AudioNodeLike {
  gain: { value: number }
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array
}

export interface AudioBufferSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null
  onended: (() => void) | null
  start(when: number): void
  stop(when?: number): void
}

function defaultAudioContextFactory(): AudioContextLike {
  const Ctor =
    (globalThis as unknown as { AudioContext?: new () => AudioContextLike }).AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: new () => AudioContextLike })
      .webkitAudioContext
  if (!Ctor) throw new Error("Web Audio API is not available in this environment")
  return new Ctor()
}

/** Convert little-endian PCM16 bytes into normalized Float32 samples. */
export function pcm16ToFloat32(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer)
  const count = Math.floor(buffer.byteLength / 2)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const sample = view.getInt16(i * 2, true)
    out[i] = sample < 0 ? sample / 0x8000 : sample / 0x7fff
  }
  return out
}

type PlayerState = "idle" | "playing" | "paused" | "ended"

export class PcmPlayer {
  private readonly sampleRate: number
  private readonly onProgress?: (progress: number) => void
  private readonly onEnded?: () => void
  private ctx: AudioContextLike | null = null
  private gain: GainNodeLike | null = null
  private readonly volume: number
  private readonly factory: () => AudioContextLike

  /** Absolute context time where the next chunk should start. */
  private nextStartTime = 0
  /** Absolute context time the very first chunk started at, for progress. */
  private firstStartTime = 0
  private started = false
  /** Total scheduled audio duration (seconds), for progress. */
  private scheduledDuration = 0
  private endedSources = 0
  private totalSources = 0
  private inputEnded = false
  private state: PlayerState = "idle"
  private readonly keepAlive: boolean
  /** Sources scheduled but not yet finished, so `interrupt()` can cut them. */
  private readonly liveSources = new Set<AudioBufferSourceLike>()

  constructor(options: PcmPlayerOptions = {}) {
    this.sampleRate = options.sampleRate ?? 24000
    this.volume = Math.max(0, Math.min(1, options.volume ?? 1))
    this.onProgress = options.onProgress
    this.onEnded = options.onEnded
    this.factory = options.audioContextFactory ?? defaultAudioContextFactory
    this.keepAlive = options.keepAlive ?? false
  }

  /** Queue one PCM16 delta for playback. Lazily opens the audio context. */
  enqueue(pcm16: ArrayBuffer): void {
    if (this.state === "ended") return
    if (pcm16.byteLength < 2) return
    const ctx = this.ensureContext()
    const samples = pcm16ToFloat32(pcm16)
    const buffer = ctx.createBuffer(1, samples.length, this.sampleRate)
    buffer.getChannelData(0).set(samples)

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain as GainNodeLike)

    // Never schedule in the past — if we've fallen behind, start at `currentTime`.
    const startAt = Math.max(this.nextStartTime, ctx.currentTime)
    const duration = samples.length / this.sampleRate
    if (!this.started) {
      this.firstStartTime = startAt
      this.started = true
    }
    this.totalSources++
    this.liveSources.add(source)
    source.onended = () => {
      // A source cut by `interrupt()` is already untracked; its counters were
      // cleared with it, so double-counting here would corrupt progress.
      if (!this.liveSources.delete(source)) return
      this.endedSources++
      this.emitProgress()
      this.maybeFinish()
    }
    source.start(startAt)
    this.nextStartTime = startAt + duration
    this.scheduledDuration += duration
    if (this.state === "idle") this.state = "playing"
  }

  /** Signal that no more deltas will arrive. */
  end(): void {
    this.inputEnded = true
    this.maybeFinish()
  }

  pause(): void {
    if (this.state !== "playing" || !this.ctx) return
    this.state = "paused"
    void this.ctx.suspend()
  }

  resume(): void {
    if (this.state !== "paused" || !this.ctx) return
    this.state = "playing"
    void this.ctx.resume()
  }

  stop(): void {
    this.state = "ended"
    this.liveSources.clear()
    if (this.ctx) {
      void this.ctx.close()
      this.ctx = null
      this.gain = null
    }
  }

  /**
   * Cut playback immediately but keep the player usable — the barge-in
   * primitive. Every scheduled source is stopped and the schedule rewinds to
   * "now", so the next `enqueue()` starts speaking without waiting out audio
   * the user already talked over.
   *
   * Unlike {@link stop} this leaves the audio context open: re-opening one per
   * interruption would burn through Chromium's concurrent-context cap and
   * re-trigger autoplay gating mid-conversation.
   */
  interrupt(): void {
    if (this.state === "ended") return
    for (const source of this.liveSources) {
      try {
        source.stop(0)
      } catch {
        // Already finished between the last event-loop turn and now.
      }
    }
    this.liveSources.clear()
    this.resetSchedule()
  }

  /**
   * Seconds of audio actually played since the current utterance started.
   *
   * Barge-in needs this: the provider must be told how much of its own
   * response the user really heard (`conversation.item.truncate`), or its
   * transcript diverges from the conversation the user experienced.
   */
  playedSeconds(): number {
    if (!this.ctx || !this.started) return 0
    const played = this.ctx.currentTime - this.firstStartTime
    return Math.max(0, Math.min(played, this.scheduledDuration))
  }

  getState(): PlayerState {
    return this.state
  }

  /** Rewind scheduling state to "nothing queued", keeping the context open. */
  private resetSchedule(): void {
    this.nextStartTime = this.ctx?.currentTime ?? 0
    this.firstStartTime = 0
    this.started = false
    this.scheduledDuration = 0
    this.endedSources = 0
    this.totalSources = 0
    this.inputEnded = false
    if (this.state !== "paused") this.state = "idle"
  }

  private ensureContext(): AudioContextLike {
    if (!this.ctx) {
      this.ctx = this.factory()
      this.gain = this.ctx.createGain()
      this.gain.gain.value = this.volume
      this.gain.connect(this.ctx.destination)
      this.nextStartTime = this.ctx.currentTime
    }
    return this.ctx
  }

  private emitProgress(): void {
    if (!this.ctx || this.scheduledDuration <= 0) return
    const played = Math.min(this.ctx.currentTime - this.firstStartTime, this.scheduledDuration)
    this.onProgress?.(Math.max(0, Math.min(1, played / this.scheduledDuration)))
  }

  private maybeFinish(): void {
    if (this.state === "ended") return
    if (this.inputEnded && this.endedSources >= this.totalSources && this.totalSources > 0) {
      if (this.keepAlive) {
        // One assistant turn drained; the conversation continues.
        this.onProgress?.(1)
        this.resetSchedule()
        this.onEnded?.()
        return
      }
      this.state = "ended"
      this.onProgress?.(1)
      if (this.ctx) {
        void this.ctx.close()
        this.ctx = null
        this.gain = null
      }
      this.onEnded?.()
    }
  }
}
