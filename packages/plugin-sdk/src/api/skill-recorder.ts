/** Portable recorder contracts. Runtime operations are mounted on `ctx.recorder`. */
export type { PluginRecorderAPI } from "@/lib/plugin/api/recorder-api"
export type { RecorderAvailability } from "@/lib/skills/recording/recorder-availability"
export type {
  AssetId,
  AssetPayload,
  CaptureTarget,
  RecordEvent,
  RecordPreflight,
  RecordStartArgs,
  RecordStatus,
  RecordingBundle,
  RecordingId,
  RecoverableBundle,
} from "@/lib/skills/recording/types"
export type { RecorderEntrySource } from "@/lib/skills/recording/state-machine"
