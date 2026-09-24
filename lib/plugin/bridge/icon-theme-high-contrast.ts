/**
 * Whether an a11y high-contrast palette is painted — the one appearance fact a
 * file-icon theme needs beyond light/dark, to pick its `highContrast`
 * association overrides (VS Code's layering).
 *
 * The app theme applier owns that decision (it stands down under a plugin
 * colour theme, which paints no high-contrast palette), so it publishes here
 * and `FileTypeIcon` subscribes. The icon is a leaf rendered in every file tree
 * and chip; reading the setting itself would drag the whole settings store —
 * and the keyring and speech modules behind it — into each of those.
 *
 * Dependency-free on purpose, and apart from the icon-theme registry.
 */

let painted = false
const listeners = new Set<() => void>()

/** Called by the app theme applier whenever it (re)paints the palette. */
export function setIconThemeHighContrast(next: boolean): void {
  if (painted === next) return
  painted = next
  for (const listener of listeners) listener()
}

export function isIconThemeHighContrast(): boolean {
  return painted
}

export function subscribeIconThemeHighContrast(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function __resetIconThemeHighContrastForTesting(): void {
  painted = false
  listeners.clear()
}
