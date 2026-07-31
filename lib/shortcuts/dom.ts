// Shared target guards for the shortcut dispatcher and every renderer keydown
// hook. Consolidates the ~7 near-identical copies that used to live inline in
// `use-search-hotkey`, `use-observability-hotkeys`, `terminal-toggle-shortcut`,
// etc. Two orthogonal concerns:
//
//   - `isEditableTarget` — a plain editable control (form field / contenteditable)
//     the user is typing into. Most shortcuts must not hijack these.
//   - `isInsideEditorSurface` — a code editor (Monaco, CodeMirror) that owns its
//     own keymap. Shortcuts must NEVER steal these, even ones that otherwise
//     fire while a plain field is focused (e.g. the Canvas rail toggles).

/**
 * True when a keyboard event originated from a plain editable control we must
 * not hijack: a form field (`input` / `textarea` / `select`) or a
 * `contenteditable` region.
 *
 * The `contenteditable` check reads both the `isContentEditable` getter and the
 * raw attribute, because jsdom does not derive the getter from the attribute the
 * way browsers do (the terminal-toggle guard depended on this).
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false

  const tag = target.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true

  if (target.isContentEditable === true) return true
  const contentEditable = target.getAttribute?.("contenteditable")
  return contentEditable === "true" || contentEditable === ""
}

/**
 * True when the event originated inside one of the given editor surfaces
 * (e.g. `.monaco-editor`, `.cm-editor`). Used to refuse chords that would
 * otherwise clash with a code editor's own keybindings.
 */
export function isInsideEditorSurface(target: EventTarget | null, selectors: string[]): boolean {
  if (!(target instanceof HTMLElement)) return false
  return selectors.some((selector) => Boolean(target.closest?.(selector)))
}
