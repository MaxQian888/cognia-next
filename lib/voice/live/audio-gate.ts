/**
 * Reference-counted microphone/playback gate for tool execution.
 *
 * A realtime model can emit several function calls inside one response, so
 * several approvals can be outstanding at the same time. If each of them
 * toggled the microphone directly, the *first* one to finish would unmute while
 * the others were still waiting, and the user's answer to a pending dialog
 * would be recorded into the conversation. The gate makes suspension a count:
 * only the 0→1 and 1→0 transitions touch audio.
 *
 * Two further rules, both learned from how these sessions actually fail:
 *
 * - **Cancel the response before muting.** Suspending the microphone while the
 *   model is mid-sentence leaves it talking over a modal dialog. `response-cancel`
 *   goes first so the model stops, then audio is stilled.
 *
 * - **Releasing restores the user's intent, not "on".** If the user muted
 *   themselves before a tool ran, the last release must leave them muted.
 *
 * The epoch guards the case where the user ends a session and immediately
 * starts another: a release from the old session must not unmute the new one.
 * `track.enabled` is what gets toggled — never `track.stop()`, which would drop
 * the device and re-trigger the permission prompt.
 */

export interface LiveVoiceAudioGateDeps {
  /** Toggle `track.enabled`. Never stops the track. */
  setMicrophoneEnabled(enabled: boolean): void
  /** Send `response-cancel` so the model stops talking over the dialog. */
  cancelResponse(): void
  /** Stop and flush queued assistant audio. */
  interruptPlayback(): void
  /** Whether the user muted themselves, so a release does not override them. */
  isUserMuted(): boolean
}

/** Undo a single `suspend()`. Idempotent, and inert once the epoch moves on. */
export type ReleaseAudioGate = () => void

export class LiveVoiceAudioGate {
  private held = 0
  private epoch = 0

  constructor(private readonly deps: LiveVoiceAudioGateDeps) {}

  /** Number of outstanding holds. Exposed for assertions and diagnostics. */
  get holds(): number {
    return this.held
  }

  /** Whether audio is currently suspended by at least one holder. */
  get suspended(): boolean {
    return this.held > 0
  }

  /**
   * Take a hold on the microphone. The first hold stops the model and mutes;
   * subsequent holds only increment. Returns the matching release.
   */
  suspend(): ReleaseAudioGate {
    const epoch = this.epoch
    this.held += 1

    if (this.held === 1) {
      this.deps.cancelResponse()
      this.deps.interruptPlayback()
      this.deps.setMicrophoneEnabled(false)
    }

    let released = false
    return () => {
      // A double release would under-count and unmute while another tool is
      // still waiting on the user.
      if (released) return
      // A release belonging to a session that has already ended must not touch
      // the microphone of the session that replaced it.
      if (epoch !== this.epoch) return
      released = true
      this.held -= 1
      if (this.held === 0) {
        this.deps.setMicrophoneEnabled(!this.deps.isUserMuted())
      }
    }
  }

  /**
   * Abandon every outstanding hold, e.g. because the session ended.
   *
   * Deliberately does not touch audio: the session this gate belonged to is
   * over, and its microphone is being torn down by the controller.
   */
  reset(): void {
    this.epoch += 1
    this.held = 0
  }
}

export function createLiveVoiceAudioGate(deps: LiveVoiceAudioGateDeps): LiveVoiceAudioGate {
  return new LiveVoiceAudioGate(deps)
}
