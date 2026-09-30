"use client"

import { makeDefaultLoader, withPlugin, type ValueOutcome } from "./_shared"

/**
 * Runtime microphone permission on the native shell, through the
 * `capacitor-voice-recorder` plugin that the mobile workspace already ships.
 *
 * Why the composer needs it: dictation runs on the Web Speech API, and inside
 * the Android WebView that API never raises a permission prompt of its own
 * (it does not go through `WebChromeClient.onPermissionRequest`). The app
 * declares `RECORD_AUDIO` but nothing ever requested it at runtime, so on a
 * fresh install the mic button did nothing at all. Asking through the plugin
 * shows the real system dialog and tells us the answer.
 *
 * On web / Tauri the loader short-circuits to `unsupported` (the browser owns
 * the prompt there), exactly like the sibling wrappers.
 */

interface MicrophonePermissionShape {
  hasAudioRecordingPermission(): Promise<{ value: boolean }>
  requestAudioRecordingPermission(): Promise<{ value: boolean }>
}

export type MicrophoneLoader = () => Promise<MicrophonePermissionShape>

const defaultLoader: MicrophoneLoader = makeDefaultLoader<MicrophonePermissionShape>(
  "capacitor-voice-recorder",
  "VoiceRecorder"
)

export type MicrophonePermission = "granted" | "denied"

/**
 * Resolve the microphone permission, showing the system prompt when it has not
 * been granted yet. `denied` covers both "tapped Deny" and "denied forever"
 * (Android no longer re-prompts); the caller should point at app settings.
 */
export async function ensureMicrophonePermission(
  loader: MicrophoneLoader = defaultLoader
): Promise<ValueOutcome<MicrophonePermission>> {
  return withPlugin(loader, async (recorder) => {
    const has = await recorder.hasAudioRecordingPermission()
    if (has.value) return { kind: "ok" as const, value: "granted" as const }
    const requested = await recorder.requestAudioRecordingPermission()
    return {
      kind: "ok" as const,
      value: requested.value ? ("granted" as const) : ("denied" as const),
    }
  })
}
