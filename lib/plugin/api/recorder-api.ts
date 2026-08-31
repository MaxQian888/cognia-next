import {
  clearRecorderAvailability,
  getRecorderAvailability,
  setRecorderAvailability,
  subscribeRecorderAvailability,
  type RecorderAvailability,
} from "@/lib/skills/recording/recorder-availability"
import {
  onRecordEvent,
  recordDeleteBundle,
  recordInterrupt,
  recordListCaptureTargets,
  recordListRecoverable,
  recordLoadBundle,
  recordPause,
  recordPreflight,
  recordReadAsset,
  recordResume,
  recordStart,
  recordStatus,
  recordStop,
  recordUndoLast,
} from "@/lib/skills/recording/recorder-client"
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
} from "@/lib/skills/recording/types"
import type { RecorderEntrySource } from "@/lib/skills/recording/state-machine"
import { openRecorder, recorderStatusSnapshot } from "@/stores/skills/recorder-store"

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

export function createRecorderAPI(pluginId: string): PluginRecorderAPI {
  return {
    publishAvailability: () => {
      setRecorderAvailability({ available: true, pluginId })
      return () => {
        if (getRecorderAvailability().pluginId === pluginId) clearRecorderAvailability()
      }
    },
    getAvailability: getRecorderAvailability,
    subscribeAvailability: subscribeRecorderAvailability,
    preflight: recordPreflight,
    listCaptureTargets: recordListCaptureTargets,
    start: recordStart,
    pause: recordPause,
    resume: recordResume,
    undoLast: recordUndoLast,
    stop: recordStop,
    interrupt: recordInterrupt,
    status: recordStatus,
    listRecoverable: recordListRecoverable,
    loadBundle: recordLoadBundle,
    readAsset: recordReadAsset,
    deleteBundle: recordDeleteBundle,
    onEvent: onRecordEvent,
    open: openRecorder,
    statusSnapshot: recorderStatusSnapshot,
  }
}
