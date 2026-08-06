/**
 * Type definitions for terminal session recording.
 *
 * Follows the asciicast v2 format (https://docs.asciinema.org/manual/asciicast/v2/)
 * for compatibility with the asciinema ecosystem, while adding Cognia-specific
 * metadata extensions for richer playback.
 */

/** asciicast v2 header — first line of a .cast file. */
export interface AsciicastHeader {
  /** Format version (always 2). */
  version: 2
  /** Terminal width in columns. */
  width: number
  /** Terminal height in rows. */
  height: number
  /** Unix timestamp when recording started. */
  timestamp?: number
  /** Total duration in seconds (set after recording ends). */
  duration?: number
  /** Shell that was active during recording. */
  env?: {
    SHELL?: string
    TERM?: string
  }
  /** Cognia-specific metadata. */
  title?: string
  /** Theme colours used during recording (for accurate playback). */
  theme?: {
    fg?: string
    bg?: string
    palette?: string
  }
}

/**
 * A single frame in the recording (asciicast v2 event line).
 * Format: [time, type, data]
 *   - time: seconds since recording start (float)
 *   - type: "o" for output, "i" for input
 *   - data: the text content
 */
export type AsciicastFrame = [number, "o" | "i", string]

/** A complete terminal recording. */
export interface TerminalRecording {
  /** Unique recording id (nanoid). */
  id: string
  /** Terminal session id that was recorded. */
  sessionId: string
  /** Recording title (user-editable). */
  title: string
  /** asciicast header with terminal dimensions + metadata. */
  header: AsciicastHeader
  /** All frames captured during the recording. */
  frames: AsciicastFrame[]
  /** Total duration in seconds. */
  duration: number
  /** When the recording was created (ms since epoch). */
  createdAt: number
  /** File size estimate in bytes (frames serialized). */
  sizeBytes: number
}

/** Recording state machine states. */
export type RecordingStatus =
  | "idle" // not recording
  | "recording" // actively capturing
  | "paused" // temporarily paused
  | "stopped" // recording complete, data available

/** Recorder configuration options. */
export interface RecorderOptions {
  /** Maximum recording duration in seconds (safety cap). Defaults to 600 (10 min). */
  maxDurationSec?: number
  /** Whether to capture input events ("i" frames). Defaults to false. */
  captureInput?: boolean
  /** Title for the recording. */
  title?: string
}

/** Playback state. */
export interface PlaybackState {
  /** Current playback position in seconds. */
  position: number
  /** Whether playback is running. */
  playing: boolean
  /** Playback speed multiplier (1 = realtime). */
  speed: number
  /** Total duration of the recording. */
  duration: number
}

/** GIF export options. */
export interface GifExportOptions {
  /** Output width in pixels. Defaults to 800. */
  width?: number
  /** Output height in pixels (auto-calculated from aspect ratio if omitted). */
  height?: number
  /** Font size in pixels for rendering. Defaults to 14. */
  fontSize?: number
  /** Frame rate cap (frames per second). Defaults to 10. */
  fps?: number
  /** Maximum duration to export in seconds (for trimming). */
  maxDurationSec?: number
  /** Theme override for export. */
  theme?: "dark" | "light"
}
