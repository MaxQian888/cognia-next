/**
 * The keys that send and break lines in the composer, as the help shows them.
 *
 * The composer's key handler (`components/chat/composer.tsx`) reads the
 * `composerBehavior.sendOnEnter` setting: on, Enter sends and Shift+Enter is a
 * newline; off, Enter is a newline and ⌘/Ctrl+Enter sends. Every surface that
 * TELLS the user which key to press — the cheatsheet, the onboarding chip row,
 * the settings hint — derives its keycaps here, so help can no longer describe
 * the default while the setting says otherwise.
 */

export interface ComposerSendKeys {
  /** Keycaps that send, in press order. */
  send: readonly string[]
  /** Keycaps that insert a new line. */
  newline: readonly string[]
}

/** Keycaps for the current send setting and keyboard glyph family. */
export function composerSendKeys(options: {
  sendOnEnter: boolean
  /** Apple keyboards label the modifier ⌘; everything else says Ctrl. */
  appleGlyphs: boolean
}): ComposerSendKeys {
  if (options.sendOnEnter) return { send: ["⏎"], newline: ["⇧", "⏎"] }
  return { send: [options.appleGlyphs ? "⌘" : "Ctrl", "⏎"], newline: ["⏎"] }
}

/** One keycap sequence as inline text (`⇧⏎`, `Ctrl+⏎`). */
export function formatKeyCombo(combo: readonly string[]): string {
  // Glyph modifiers read as one chord when run together; a word modifier
  // needs the `+` to stay legible.
  return combo.every((cap) => [...cap].length === 1) ? combo.join("") : combo.join("+")
}
