/**
 * Read a system-wide text selection aloud.
 *
 * Runs in the main window even though the button lives in the selection-toolbar
 * overlay. Two reasons: overlay windows are deliberately least-privilege
 * presentation shells (`lib/pet/window-role.ts`, and the pet does the same
 * thing — `hooks/pet/use-pet-speak.ts` is main-window-only with the overlay
 * replaying through a bridge), and `ttsOrchestrator` owns an `<Audio>` element
 * per webview, so speaking from the overlay would open a *second* player that
 * talks over a chat message already being read.
 *
 * Progress and completion are pushed back to the toolbar window, which renders
 * the transport.
 */

import { ttsOrchestrator } from "@/lib/tts/tts-orchestrator"
import { selectSpeechSettings } from "@/lib/tts/speech-settings"
import { providerKeyMapToSettingsMap } from "@/lib/tts/keyring"
import { useSettingsStore } from "@/stores/settings"

export interface SpeakSelectionArgs {
  /** Candidate id — becomes the orchestrator's `activeSourceId`. */
  candidateId: string
  text: string
}

/**
 * Speak the selection. Resolves when playback finishes; rejects if synthesis
 * fails (the orchestrator raises its own toast in that case). A no-op for empty
 * text, and silently short-circuited by the orchestrator when TTS is disabled.
 */
export async function speakSelection({ candidateId, text }: SpeakSelectionArgs): Promise<void> {
  if (!text.trim()) return

  await useSettingsStore.getState().ensureProviderKeys()
  const store = useSettingsStore.getState()

  await ttsOrchestrator.speak(text, {
    source: "selection",
    sourceId: candidateId,
    speechSettings: selectSpeechSettings(store.settings),
    providerSettings: providerKeyMapToSettingsMap(store.providerKeys),
  })
}

/** Stop playback, but only if this candidate is the one currently speaking. */
export function stopSelectionSpeech(candidateId: string): void {
  const state = ttsOrchestrator.getState()
  if (state.activeSource !== "selection" || state.activeSourceId !== candidateId) return
  ttsOrchestrator.stop()
}

/**
 * Subscribe to playback for one candidate. Emits `{ playing, progress }` on
 * every orchestrator tick and a final `{ playing: false }` exactly once, so the
 * toolbar can drive its waveform and then release itself.
 */
export function watchSelectionSpeech(
  candidateId: string,
  onChange: (update: { playing: boolean; progress?: number }) => void
): () => void {
  let sawPlaying = false
  let settled = false
  const unsubscribe = ttsOrchestrator.subscribe((state) => {
    if (settled) return
    const isOurs = state.activeSource === "selection" && state.activeSourceId === candidateId
    if (isOurs && (state.isPlaying || state.isLoading)) {
      sawPlaying = true
      onChange({ playing: true, progress: state.progress })
      return
    }
    // The orchestrator clears `activeSourceId` on stop/end/error, so "was ours,
    // now isn't" is the completion signal — whether playback finished, the user
    // hit stop, or another surface took the player over.
    if (sawPlaying) {
      settled = true
      onChange({ playing: false })
    }
  })
  return unsubscribe
}
