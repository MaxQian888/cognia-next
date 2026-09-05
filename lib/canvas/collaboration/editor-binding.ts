/**
 * Binding the editors to the shared document.
 *
 * # What was missing
 *
 * The CRDT could receive. It could not be fed. `applyLocalUpdate` was the only
 * thing that produced an operation to broadcast, and it had no production
 * caller: every real edit went from the editor to the artifact store and
 * stopped there, so the `Y.Doc` only ever moved when a peer moved it. Two
 * people editing one document would have seen each other's changes arrive and
 * none of their own leave.
 *
 * The bindings close that. Monaco and CodeMirror write into the `Y.Text`
 * directly, `crdt-store`'s document-level update bus notices, and the provider
 * broadcasts. Because the bus watches the document rather than any one call
 * site, an AI apply, a model tool write and a plugin write travel the same way
 * without knowing collaboration exists.
 *
 * # Presence is settings-driven, and the settings now mean something
 *
 * Six collaboration settings had no reader at all. Rather than describe them
 * as dormant a second time, they are wired here: `showCursors`,
 * `showSelections` and `cursorSmoothing` become the stylesheet the remote
 * decorations are drawn with, and `presenceTimeout` becomes the awareness
 * protocol's own idle cutoff, which is what actually removes a participant who
 * stopped talking.
 *
 * Hiding a decoration in CSS rather than withholding awareness is deliberate.
 * The peer's cursor still exists and still moves, so turning the setting back
 * on shows where they are now, rather than nothing until they next type.
 */

import type { Awareness } from "y-protocols/awareness"
import type * as Y from "yjs"
import type { editor as MonacoEditor } from "monaco-editor"
import type { Extension } from "@codemirror/state"

import type { Participant } from "@/types/canvas/collaboration"
import type { CanvasCollaborationSettings } from "@/types/canvas/settings"

/** The subset of the collaboration settings that changes what is drawn. */
export type CanvasPresenceSettings = Pick<
  CanvasCollaborationSettings,
  "showCursors" | "showSelections" | "cursorSmoothing" | "presenceTimeout"
>

/**
 * What this peer publishes about itself.
 *
 * `user` is the field name both `y-monaco` and `y-codemirror.next` read for a
 * remote participant's name and colour. Renaming it would mean every remote
 * cursor rendered untitled and grey.
 */
export interface CanvasAwarenessUser {
  name: string
  color: string
  participantId: string
}

export function awarenessUserFrom(participant: Participant): CanvasAwarenessUser {
  return {
    name: participant.name,
    color: participant.color,
    participantId: participant.id,
  }
}

/**
 * How long a silent peer stays in the roster.
 *
 * Clamped rather than trusted: the protocol drops a peer that has not spoken
 * within this window, so a zero would evict everybody the moment they stopped
 * typing, and an enormous one would keep ghosts forever. The floor is above
 * the provider's own heartbeat so a connected peer is never evicted between
 * two beats.
 */
export const MIN_PRESENCE_TIMEOUT_MS = 5_000
export const MAX_PRESENCE_TIMEOUT_MS = 600_000

export function resolvePresenceTimeout(requested: number): number {
  if (!Number.isFinite(requested)) return 30_000
  return Math.min(MAX_PRESENCE_TIMEOUT_MS, Math.max(MIN_PRESENCE_TIMEOUT_MS, Math.round(requested)))
}

/** Stable id for the injected stylesheet, so a re-render replaces rather than stacks. */
export const CANVAS_PRESENCE_STYLE_ID = "cognia-canvas-presence"

/**
 * The stylesheet the remote decorations are drawn with.
 *
 * Pure, so what each setting does is a value a test can read rather than
 * something only a browser can show.
 */
export function presenceStylesheet(settings: CanvasPresenceSettings): string {
  const rules: string[] = []
  if (!settings.showSelections) {
    // The highlight behind a peer's selected range.
    rules.push(".yRemoteSelection, .cm-ySelection { background-color: transparent !important; }")
  }
  if (!settings.showCursors) {
    // The caret itself, and CodeMirror's name flag above it.
    rules.push(
      ".yRemoteSelectionHead, .cm-ySelectionCaret { display: none !important; }",
      ".cm-ySelectionCaretDot, .cm-ySelectionInfo { display: none !important; }"
    )
  }
  if (settings.cursorSmoothing) {
    // Only the caret moves between positions. Transitioning the selection
    // highlight makes a range change smear rather than glide.
    rules.push(
      ".yRemoteSelectionHead, .cm-ySelectionCaret { transition: left 90ms ease-out, top 90ms ease-out; }"
    )
  }
  return rules.join("\n")
}

/** Everything a binding needs, whichever editor it is for. */
export interface CanvasBindingContext {
  ytext: Y.Text
  awareness: Awareness
  settings: CanvasPresenceSettings
}

/**
 * Attach Monaco to the shared text.
 *
 * Returns the teardown. The caller must run it before the model is disposed:
 * a binding that outlives its model keeps observing a `Y.Text` and writing
 * into a model nobody can see, which reads as a document that silently stops
 * accepting remote edits.
 */
export async function bindMonacoEditor(
  context: CanvasBindingContext,
  editor: MonacoEditor.IStandaloneCodeEditor
): Promise<() => void> {
  const model = editor.getModel()
  if (!model) return () => {}
  // Loaded on demand: `y-monaco` pulls in Monaco's own types and is dead
  // weight in the mobile bundle, which renders CodeMirror instead.
  const { MonacoBinding } = await import("y-monaco")
  const binding = new MonacoBinding(
    context.ytext,
    model,
    new Set([editor]),
    // Awareness is always passed. Which decorations are visible is the
    // stylesheet's business, so toggling a setting does not cost the peer's
    // position.
    context.awareness
  )
  return () => binding.destroy()
}

/**
 * The CodeMirror extensions that make an editor collaborative.
 *
 * Returned rather than applied, because `LightCodeEditor` composes its own
 * extension list and is shared with surfaces that must stay non-collaborative.
 */
export async function codeMirrorCollabExtensions(
  context: CanvasBindingContext
): Promise<Extension[]> {
  const { yCollab } = await import("y-codemirror.next")
  return [yCollab(context.ytext, context.awareness)]
}
