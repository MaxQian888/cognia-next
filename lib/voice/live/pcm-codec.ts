/**
 * Audio wire-format helpers for live voice.
 *
 * AI SDK 7 already ships the three conversions we'd otherwise hand-roll, so we
 * re-export them under intent-revealing names rather than reimplementing:
 *   - `encodeRealtimeAudio`  Float32 → PCM16 LE → base64  (uplink append)
 *   - `decodeRealtimeAudio`  base64 → Float32             (when callers want samples)
 *   - `resampleAudio`        linear interpolation          (sample-rate fallback)
 *
 * What the SDK does NOT provide, and what lives here:
 *
 * 1. `base64ToPcm16Buffer` — the downlink path feeds `PcmPlayer` (from
 *    `@cognia/tts`), whose `enqueue()` takes raw PCM16 bytes and runs its own
 *    `pcm16ToFloat32`. Going base64 → ArrayBuffer directly skips a pointless
 *    Float32 round-trip, and avoids `decodeRealtimeAudio`'s `new Int16Array(
 *    bytes.buffer)`, which throws on an odd byte length.
 *
 * 2. `createFrameAccumulator` — an AudioWorklet delivers fixed 128-sample render
 *    quanta, but realtime providers want ~20 ms frames (480 samples @ 24 kHz).
 *    Appending 128-sample frames works but triples the message rate for no gain.
 */

import {
  experimental_decodeRealtimeAudio,
  experimental_encodeRealtimeAudio,
  experimental_resampleAudio,
} from "ai"

/** Float32 samples in [-1, 1] → base64-encoded PCM16 LE, ready for an append event. */
export const encodeUplinkAudio = experimental_encodeRealtimeAudio

/** base64-encoded PCM16 LE → Float32 samples in [-1, 1]. */
export const decodeDownlinkAudio = experimental_decodeRealtimeAudio

/** Linear-interpolation resample. Returns the input unchanged when rates match. */
export const resampleAudio = experimental_resampleAudio

/** 20 ms at 24 kHz — the default uplink frame size. */
export const FRAME_SAMPLES_20MS_24KHZ = 480

/**
 * Decode a base64 PCM16 payload into its raw little-endian bytes.
 *
 * An odd byte length would leave a dangling half-sample, so it is truncated:
 * `PcmPlayer` floors on sample count anyway, and a torn sample is inaudible
 * next to the alternative of throwing mid-stream.
 */
export function base64ToPcm16Buffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const usableLength = binary.length - (binary.length % 2)
  const bytes = new Uint8Array(usableLength)
  for (let i = 0; i < usableLength; i++) {
    bytes[i] = binary.charCodeAt(i) & 0xff
  }
  return bytes.buffer
}

/** Root-mean-square level of a sample block, in [0, 1]. Drives the level meter. */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

export interface FrameAccumulator {
  /** Buffer `chunk` and return every whole frame it completed (often empty). */
  push(chunk: Float32Array): Float32Array[]
  /** Emit any buffered remainder as a short frame, then reset. */
  flush(): Float32Array | null
  /** Drop buffered samples without emitting — used when the mic is re-gated. */
  reset(): void
  /** How many samples are buffered but not yet emitted. */
  readonly pending: number
}

/**
 * Repack a stream of arbitrarily-sized sample blocks into fixed-size frames.
 *
 * Emitted frames are always freshly allocated, so a caller may retain or
 * transfer one without it being overwritten by subsequent pushes.
 */
export function createFrameAccumulator(frameSamples: number): FrameAccumulator {
  if (!Number.isInteger(frameSamples) || frameSamples <= 0) {
    throw new Error(`frameSamples must be a positive integer, received ${frameSamples}`)
  }

  let buffer = new Float32Array(frameSamples)
  let filled = 0

  return {
    push(chunk: Float32Array): Float32Array[] {
      const frames: Float32Array[] = []
      let offset = 0
      while (offset < chunk.length) {
        const take = Math.min(frameSamples - filled, chunk.length - offset)
        buffer.set(chunk.subarray(offset, offset + take), filled)
        filled += take
        offset += take
        if (filled === frameSamples) {
          frames.push(buffer)
          buffer = new Float32Array(frameSamples)
          filled = 0
        }
      }
      return frames
    },

    flush(): Float32Array | null {
      if (filled === 0) return null
      const remainder = buffer.slice(0, filled)
      buffer = new Float32Array(frameSamples)
      filled = 0
      return remainder
    },

    reset(): void {
      buffer = new Float32Array(frameSamples)
      filled = 0
    },

    get pending(): number {
      return filled
    },
  }
}
