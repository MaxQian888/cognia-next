/**
 * Source text for the microphone capture AudioWorklet.
 *
 * Shipped as a string and loaded via `URL.createObjectURL(new Blob([...]))`
 * rather than a separate asset, because that is the only form that resolves
 * identically under `tauri://localhost`, `capacitor://localhost` and
 * `http://localhost:3000` without a build-time copy step or cache-busting.
 * The desktop CSP already allows it: `script-src 'self' 'wasm-unsafe-eval' blob:`.
 *
 * The processor batches the 128-sample render quanta the Web Audio graph hands
 * it into whole frames before posting. At 24 kHz a 20 ms frame is 480 samples,
 * so this turns ~187 messages/second into ~50. It posts Float32 frames (not
 * Int16) so the main thread can hand them straight to the AI SDK's
 * `encodeRealtimeAudio`, keeping exactly one PCM16 conversion in the codebase.
 *
 * RMS is computed here too: it rides along with a frame the worklet already
 * has in cache, which is cheaper than an `AnalyserNode` and — unlike one —
 * still works on the ScriptProcessor fallback path.
 */

/** Name the processor registers under, shared by the builder and the loader. */
export const CAPTURE_PROCESSOR_NAME = "cognia-live-voice-capture"

export interface CaptureWorkletOptions {
  /** Samples per emitted frame. 480 = 20 ms @ 24 kHz. */
  frameSamples: number
}

/**
 * Build the worklet source for a given frame size.
 *
 * The returned string is standalone: it closes over nothing and only touches
 * `AudioWorkletProcessor`, `registerProcessor` and `currentTime`-free APIs, so
 * a test can evaluate it against stubbed globals and drive `process()` directly.
 */
export function buildCaptureWorkletSource({ frameSamples }: CaptureWorkletOptions): string {
  if (!Number.isInteger(frameSamples) || frameSamples <= 0) {
    throw new Error(`frameSamples must be a positive integer, received ${frameSamples}`)
  }

  return `
class CogniaLiveVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frameSamples = ${frameSamples}
    this.buffer = new Float32Array(this.frameSamples)
    this.filled = 0
    this.muted = false
    this.port.onmessage = (event) => {
      const data = event && event.data
      if (!data) return
      if (data.type === 'mute') this.muted = !!data.muted
      else if (data.type === 'reset') this.filled = 0
    }
  }

  process(inputs) {
    const channel = inputs && inputs[0] && inputs[0][0]
    // No input yet (or the node was disconnected) — stay alive and wait.
    if (!channel || channel.length === 0) return true
    // While muted we keep the graph running but emit nothing, so the level
    // meter reads zero and no partial utterance reaches the server.
    if (this.muted) { this.filled = 0; return true }

    let offset = 0
    while (offset < channel.length) {
      const take = Math.min(this.frameSamples - this.filled, channel.length - offset)
      this.buffer.set(channel.subarray(offset, offset + take), this.filled)
      this.filled += take
      offset += take
      if (this.filled === this.frameSamples) {
        const frame = this.buffer
        let sum = 0
        for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
        this.port.postMessage(
          { type: 'frame', samples: frame, rms: Math.sqrt(sum / frame.length) },
          [frame.buffer]
        )
        // The buffer was transferred, so it must be replaced, not reused.
        this.buffer = new Float32Array(this.frameSamples)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor(${JSON.stringify(CAPTURE_PROCESSOR_NAME)}, CogniaLiveVoiceCapture)
`
}
