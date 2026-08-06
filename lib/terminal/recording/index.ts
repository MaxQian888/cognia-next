/**
 * Terminal recording — barrel export.
 *
 *  - **types** — shared type definitions
 *  - **recorder** — captures terminal frames into asciicast v2 format
 *  - **player** — replays recordings with timing, speed, seek
 */

export type {
  AsciicastHeader,
  AsciicastFrame,
  TerminalRecording,
  RecordingStatus,
  RecorderOptions,
  PlaybackState,
  GifExportOptions,
} from "./types"

export {
  createRecorder,
  serializeAsciicast,
  parseAsciicast,
  DEFAULT_MAX_DURATION_SEC,
  DEFAULT_TITLE,
} from "./recorder"
export type { Recorder, RecorderDeps, RecorderStateCallback } from "./recorder"

export { createPlayer } from "./player"
export type { Player, PlayerDeps, FrameEmitter, PlaybackStateCallback } from "./player"
