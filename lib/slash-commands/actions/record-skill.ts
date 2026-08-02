/**
 * `/record-skill` — open the skill recorder.
 *
 * The plugin declares this command in its manifest and handles it there; this
 * built-in exists so the command works the same way from the composer's slash
 * menu, which resolves against the built-in registry.
 *
 * Both paths end at the same `openRecorder`, so there is one flow and one live
 * session no matter which surface the user reached for.
 */

import { isTauri } from "@/lib/tauri"
import { getRecorderAvailability } from "@/lib/skills/recording/recorder-availability"

export interface RecordSkillOutcome {
  opened: boolean
  /** Stable code the caller maps to localized copy. */
  reason?: "desktopOnly" | "pluginDisabled"
}

/**
 * The two failure modes are distinct on purpose. "Desktop only" and "you turned
 * the plugin off" call for different things from the user, and collapsing them
 * into one message sends half of them to the wrong place.
 */
export async function runRecordSkillCommand(): Promise<RecordSkillOutcome> {
  if (!isTauri()) return { opened: false, reason: "desktopOnly" }
  if (!getRecorderAvailability().available) {
    return { opened: false, reason: "pluginDisabled" }
  }
  const { openRecorder } = await import("@/stores/skills/recorder-store")
  openRecorder("slash-command")
  return { opened: true }
}
