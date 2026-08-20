/**
 * PII screening for a live {@link ActiveEditorContext}, in one place.
 *
 * "What the user is looking at" is the single richest accidental-PII surface in
 * the app: the selected text, the open file paths, and the diagnostic messages
 * are all free-form and all come from whatever the user happens to have on
 * screen. Every consumer of that snapshot — the `read_active_editor` agent tool,
 * the `action.editor.readActive` workflow node — must withhold exactly the same
 * fields for exactly the same reason, or the gate becomes a suggestion.
 *
 * So the *decision* (which fields survive, and what the user is told) lives
 * here, and each consumer only maps the result into its own output shape.
 *
 * The gate itself is injected rather than imported: `@cognia/redact` is lazily
 * loaded at the call sites that already do so, and passing it in keeps this
 * module a pure leaf that tests can drive with a stub gate.
 */
import type { ActiveEditorContext } from "./project-editor-bridge"

/** What the user is told when the snapshot is withheld. */
export const ACTIVE_EDITOR_REDACTED_REASON =
  "The editor context was withheld because it may contain PII (emails, keys, IPs, cards, …)."

/**
 * A screened snapshot. `redacted: false` carries the context through untouched;
 * `redacted: true` keeps only the non-text-bearing shape, so a consumer still
 * knows an editor is focused and roughly what is open without seeing content.
 */
export type ScreenedActiveEditorContext =
  | ({ redacted: false } & ActiveEditorContext)
  | {
      redacted: true
      reason: string
      /** Ranges are positions, not content — safe to keep. */
      selection: ActiveEditorContext["selection"]
      /** A count rather than the paths, which are themselves text. */
      openEditorCount: number
    }

/**
 * Screen `active` through `gate`, withholding the text-bearing fields when it
 * trips.
 *
 * Withholding rather than redacting in place is deliberate: a partially
 * rewritten selection would still be presented as "what the user is looking
 * at", and a consumer acting on placeholder-substituted code would produce
 * edits against text that does not exist in the file.
 */
export function screenActiveEditorContext(
  active: ActiveEditorContext,
  gate: (payload: unknown) => boolean
): ScreenedActiveEditorContext {
  if (gate(active)) return { redacted: false, ...active }
  return {
    redacted: true,
    reason: ACTIVE_EDITOR_REDACTED_REASON,
    selection: active.selection,
    openEditorCount: active.openEditors.length,
  }
}
