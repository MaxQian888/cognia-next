/**
 * The plugin contract's share of `lib/session-import/codec-types.ts`, which re-exports these.
 */
import type {
  CanonicalSession,
  SessionFidelity,
  SessionLossReport,
} from "@cognia/agent-config-types/canonical-session"
import type { ImportedConversation } from "../data/importers/types"

export interface SessionCodecConversion {
  session: CanonicalSession
  loss: SessionLossReport
}

export interface SessionCodec {
  /** Fidelity of `toCanonical` for this source's transcripts. */
  importFidelity: SessionFidelity
  /** Convert one parsed conversation into the canonical record + loss report. */
  toCanonical(conversation: ImportedConversation): SessionCodecConversion
  /**
   * Reverse direction, when a PUBLIC runtime path exists. Absent =
   * materialization unsupported (import-only source) — callers must not
   * fake it.
   *
   * DORMANT AT RUNTIME. `buildReplayPrompt` has no production caller: the only
   * exercisers are `tests/conformance/cases/session-materialize.test.mjs` and
   * this module's own unit test. It is kept because ADR-0090 §8 makes it part
   * of the recovery design (canonical history may seed a new runtime session)
   * and because the byte-pinned conformance case is the tripwire for an SDK
   * that later grows a real import API. The dormancy is LABELLED in the UI —
   * `FidelityReport`'s `reverseFidelity` line — so it cannot be mistaken for a
   * capability the app actually offers, and pinned by the "no production
   * caller" assertion in `codec-types.test.ts`.
   */
  materialize?: {
    fidelity: SessionFidelity
    /**
     * Build the replay prompt that seeds a NEW runtime session with the
     * canonical history (the `contextual` path — the only one the R1 spike
     * sanctions for claude-code).
     */
    buildReplayPrompt(session: CanonicalSession): string
  }
}
