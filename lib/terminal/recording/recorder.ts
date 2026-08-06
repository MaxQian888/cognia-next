/**
 * Terminal session recorder.
 *
 * Captures terminal output (and optionally input) as timestamped frames
 * in the asciicast v2 format. The recorder attaches to a live terminal
 * session's data stream and produces a `TerminalRecording` object.
 *
 * Lifecycle: idle → recording → (paused ↔ recording) → stopped
 */

import type {
  AsciicastFrame,
  AsciicastHeader,
  RecorderOptions,
  RecordingStatus,
  TerminalRecording,
} from "./types"

/** Default max recording duration (10 minutes). */
export const DEFAULT_MAX_DURATION_SEC = 600

/** Default recording title. */
export const DEFAULT_TITLE = "Terminal Recording"

/** Callback for state changes. */
export type RecorderStateCallback = (status: RecordingStatus, elapsed: number) => void

/** Dependencies injected for testability. */
export interface RecorderDeps {
  /** Clock function. Defaults to `Date.now`. */
  now?: () => number
  /** ID generator. Defaults to a timestamp-based id. */
  generateId?: () => string
}

let idCounter = 0
function defaultGenerateId(): string {
  return `rec-${Date.now()}-${++idCounter}`
}

/**
 * Terminal recorder — captures frames from a data stream.
 *
 * Usage:
 *   const recorder = createRecorder({ title: "My Session" })
 *   recorder.start(80, 24)
 *   recorder.pushOutput("Hello\r\n")
 *   recorder.pushOutput("World\r\n")
 *   const recording = recorder.stop("session-123")
 */
export interface Recorder {
  /** Current status. */
  readonly status: RecordingStatus
  /** Elapsed time in seconds since recording started. */
  readonly elapsed: number
  /** Number of frames captured. */
  readonly frameCount: number

  /** Start recording with the given terminal dimensions. */
  start(cols: number, rows: number): void
  /** Pause recording (frames are discarded while paused). */
  pause(): void
  /** Resume recording after a pause. */
  resume(): void
  /** Push an output frame (data written to the terminal). */
  pushOutput(data: string): void
  /** Push an input frame (data typed by the user). */
  pushInput(data: string): void
  /** Stop recording and return the completed TerminalRecording. */
  stop(sessionId: string): TerminalRecording
  /** Register a callback for state changes. Returns unsubscribe. */
  onStateChange(cb: RecorderStateCallback): () => void
  /** Discard the recording without producing a result. */
  discard(): void
}

export function createRecorder(options?: RecorderOptions, deps?: RecorderDeps): Recorder {
  const clock = deps?.now ?? Date.now
  const generateId = deps?.generateId ?? defaultGenerateId
  const maxDurationSec = options?.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC
  const captureInput = options?.captureInput ?? false
  const title = options?.title ?? DEFAULT_TITLE

  let status: RecordingStatus = "idle"
  let startTime = 0
  let pauseTime = 0
  let pausedDuration = 0
  let frames: AsciicastFrame[] = []
  let cols = 80
  let rows = 24
  const listeners = new Set<RecorderStateCallback>()
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null

  function getElapsed(): number {
    if (status === "idle" || status === "stopped") return 0
    if (status === "paused") return (pauseTime - startTime - pausedDuration) / 1000
    return (clock() - startTime - pausedDuration) / 1000
  }

  function notify() {
    const elapsed = getElapsed()
    for (const cb of listeners) cb(status, elapsed)
  }

  function frameTime(): number {
    return (clock() - startTime - pausedDuration) / 1000
  }

  const recorder: Recorder = {
    get status() {
      return status
    },
    get elapsed() {
      return getElapsed()
    },
    get frameCount() {
      return frames.length
    },

    start(c: number, r: number) {
      if (status !== "idle") return
      cols = c
      rows = r
      startTime = clock()
      pausedDuration = 0
      frames = []
      status = "recording"
      notify()

      // Safety cap — auto-stop after max duration
      maxDurationTimer = setTimeout(() => {
        if (status === "recording" || status === "paused") {
          // Force stop by transitioning to stopped
          status = "stopped"
          notify()
        }
      }, maxDurationSec * 1000)
    },

    pause() {
      if (status !== "recording") return
      pauseTime = clock()
      status = "paused"
      notify()
    },

    resume() {
      if (status !== "paused") return
      pausedDuration += clock() - pauseTime
      status = "recording"
      notify()
    },

    pushOutput(data: string) {
      if (status !== "recording") return
      frames.push([frameTime(), "o", data])
    },

    pushInput(data: string) {
      if (status !== "recording" || !captureInput) return
      frames.push([frameTime(), "i", data])
    },

    stop(sessionId: string): TerminalRecording {
      if (status === "idle") {
        throw new Error("Cannot stop: recorder was never started")
      }
      if (maxDurationTimer) {
        clearTimeout(maxDurationTimer)
        maxDurationTimer = null
      }

      const duration = getElapsed()
      status = "stopped"
      notify()

      const header: AsciicastHeader = {
        version: 2,
        width: cols,
        height: rows,
        timestamp: Math.floor(startTime / 1000),
        duration,
        title,
      }

      const id = generateId()
      const sizeBytes = estimateSize(frames)

      return {
        id,
        sessionId,
        title,
        header,
        frames,
        duration,
        createdAt: clock(),
        sizeBytes,
      }
    },

    onStateChange(cb: RecorderStateCallback) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },

    discard() {
      if (maxDurationTimer) {
        clearTimeout(maxDurationTimer)
        maxDurationTimer = null
      }
      frames = []
      status = "idle"
      notify()
    },
  }

  return recorder
}

/** Estimate the byte size of serialized frames. */
function estimateSize(frames: AsciicastFrame[]): number {
  let size = 0
  for (const [, , data] of frames) {
    // Each frame: [time, "o", "data"]\n → ~15 bytes overhead + data length
    size += 15 + data.length
  }
  return size
}

/** Serialize a recording to asciicast v2 format (for export). */
export function serializeAsciicast(recording: TerminalRecording): string {
  const headerLine = JSON.stringify(recording.header)
  const frameLines = recording.frames.map((frame) => JSON.stringify(frame))
  return [headerLine, ...frameLines].join("\n") + "\n"
}

/** Parse an asciicast v2 string back into frames + header. */
export function parseAsciicast(content: string): {
  header: AsciicastHeader
  frames: AsciicastFrame[]
} {
  const trimmed = content.trim()
  if (!trimmed) throw new Error("Empty asciicast content")
  const lines = trimmed.split("\n")

  const header = JSON.parse(lines[0]) as AsciicastHeader
  const frames: AsciicastFrame[] = []

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const frame = JSON.parse(lines[i]) as AsciicastFrame
    frames.push(frame)
  }

  return { header, frames }
}

/** Reset the id counter (for testing). */
export function __resetRecorderIdCounterForTesting(): void {
  idCounter = 0
}
