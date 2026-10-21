/**
 * The plugin contract's share of `lib/plugin/api/recorder-api.ts`, which re-exports these.
 */
import type {
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
} from "../../skills/recording/types"
import type { RecorderAvailability } from "../../skills/recording/recorder-availability"
import type { RecorderEntrySource } from "../../skills/recording/state-machine"

export interface PluginRecorderAPI {
  publishAvailability(): () => void
  getAvailability(): RecorderAvailability
  subscribeAvailability(listener: () => void): () => void
  preflight(): Promise<RecordPreflight>
  listCaptureTargets(): Promise<CaptureTarget[]>
  start(args: RecordStartArgs): Promise<RecordStatus>
  pause(): Promise<RecordStatus>
  resume(): Promise<RecordStatus>
  undoLast(): Promise<RecordStatus>
  stop(): Promise<RecordingBundle>
  interrupt(): Promise<void>
  status(): Promise<RecordStatus>
  listRecoverable(): Promise<RecoverableBundle[]>
  loadBundle(recordingId: RecordingId): Promise<RecordingBundle>
  readAsset(recordingId: RecordingId, assetId: AssetId): Promise<AssetPayload>
  deleteBundle(recordingId: RecordingId): Promise<void>
  onEvent(handler: (event: RecordEvent) => void): () => void
  open(source: RecorderEntrySource): void
  statusSnapshot(): { recording: boolean; phase: string; stepCount: number }
}
