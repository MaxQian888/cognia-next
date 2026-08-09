/**
 * Assistant audio playback for live voice.
 *
 * A thin adapter over `PcmPlayer` from `@cognia/tts` — the repo's existing
 * progressive PCM16 scheduler, already used by streaming TTS. Reusing it gives
 * us its Web Audio clock scheduling (each delta queued back to back, never in
 * the past) and its injectable context for tests, so the only new behaviour
 * here is live-voice framing:
 *
 * - `keepAlive` is on, because one conversation spans many assistant turns and
 *   re-opening a context per turn would hit Chromium's concurrent-context cap
 *   and re-trigger autoplay gating.
 * - Deltas arrive base64-encoded, so they are decoded straight to PCM16 bytes
 *   rather than round-tripped through Float32.
 * - `interrupt()` plus `playedMs()` are the barge-in pair: cut the audio, then
 *   tell the provider exactly how much of its reply the user actually heard.
 */

import { PcmPlayer, type AudioContextLike } from "@cognia/tts/streaming/pcm-player"

import { base64ToPcm16Buffer } from "./pcm-codec"

export interface LiveVoicePlaybackOptions {
  /** Provider downlink rate, e.g. 24000. */
  sampleRate: number
  /** 0..1 output gain. */
  volume?: number
  /** Injectable AudioContext factory (tests pass a fake). */
  audioContextFactory?: () => AudioContextLike
  /** Reports a delta that could not be decoded; playback continues. */
  onError?: (error: Error) => void
  /** Fires only after the provider ended the turn and queued audio fully drained. */
  onEnded?: () => void
}

export class LiveVoicePlayback {
  private readonly player: PcmPlayer
  private readonly onError?: (error: Error) => void

  constructor(options: LiveVoicePlaybackOptions) {
    this.onError = options.onError
    this.player = new PcmPlayer({
      sampleRate: options.sampleRate,
      volume: options.volume,
      audioContextFactory: options.audioContextFactory,
      keepAlive: true,
      onEnded: options.onEnded,
    })
  }

  /**
   * Queue one base64 PCM16 audio delta.
   *
   * A malformed delta is reported and skipped rather than thrown: one bad
   * frame must not tear down a live conversation.
   */
  enqueueBase64(base64: string): void {
    let pcm16: ArrayBuffer
    try {
      pcm16 = base64ToPcm16Buffer(base64)
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (pcm16.byteLength === 0) return
    this.player.enqueue(pcm16)
  }

  /**
   * Cut playback for barge-in. Read {@link playedMs} *before* calling this —
   * the played clock rewinds as part of the cut.
   */
  interrupt(): void {
    this.player.interrupt()
  }

  /** Milliseconds of the current assistant turn the user actually heard. */
  playedMs(): number {
    return Math.round(this.player.playedSeconds() * 1000)
  }

  /** Mark the current turn's audio complete so progress can settle. */
  endTurn(): void {
    this.player.end()
  }

  /** Tear down the audio context. The playback object is done after this. */
  stop(): void {
    this.player.stop()
  }

  get state(): string {
    return this.player.getState()
  }
}

export function createLiveVoicePlayback(options: LiveVoicePlaybackOptions): LiveVoicePlayback {
  return new LiveVoicePlayback(options)
}
