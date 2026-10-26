import {
  clearRecorderAvailability,
  getRecorderAvailability,
  setRecorderAvailability,
  subscribeRecorderAvailability,
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
import { openRecorder, recorderStatusSnapshot } from "@/stores/skills/recorder-store"
import type { PluginRecorderAPI } from "@cognia/plugin-contract/lib/plugin/api/recorder-api"
export type { PluginRecorderAPI } from "@cognia/plugin-contract/lib/plugin/api/recorder-api"

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
