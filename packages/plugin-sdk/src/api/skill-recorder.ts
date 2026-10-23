/** Portable recorder contracts. Runtime operations are mounted on `ctx.recorder`. */
export type { PluginRecorderAPI } from "@cognia/plugin-contract/lib/plugin/api/recorder-api"
export type { RecorderAvailability } from "@cognia/plugin-contract/lib/skills/recording/recorder-availability"
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
} from "@cognia/plugin-contract/lib/skills/recording/types"
export type { RecorderEntrySource } from "@cognia/plugin-contract/lib/skills/recording/state-machine"
