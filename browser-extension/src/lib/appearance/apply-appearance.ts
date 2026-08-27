/**
 * Paint the panel with the Host's palette.
 *
 * Fifteen lines because there is nothing to decide here: the Host already
 * resolved presets, custom themes, imported VSCode themes, plugin themes and
 * a11y patches into concrete values, and the names it sends are the ones
 * `app/globals.css` reads. Anything cleverer on this side would be a second
 * opinion about a palette this process cannot see.
 */

/** Mirrors `BrowserCompanionAppearanceV1` from `@cognia/companion-client`. */
export interface AppliedAppearance {
  mode: "light" | "dark"
  cssVars: Record<string, string>
  radiusBaseRem: number
  pillRadiusPx: number
  density: "compact" | "comfortable" | "spacious"
}

/**
 * Write an appearance onto `root`, returning the property names written.
 *
 * The class is toggled in both directions rather than only added: a Host that
 * switches to light must un-dark the panel, and a stale `.dark` over a light
 * palette is the one combination that produces unreadable text.
 */
export function applyAppearance(root: HTMLElement, appearance: AppliedAppearance): string[] {
  const written: string[] = []
  for (const [name, value] of Object.entries(appearance.cssVars)) {
    if (typeof value !== "string" || value.trim() === "") continue
    root.style.setProperty(name, value)
    written.push(name)
  }
  root.style.setProperty("--radius", `${appearance.radiusBaseRem}rem`)
  root.style.setProperty("--pill-radius", `${appearance.pillRadiusPx}px`)
  written.push("--radius", "--pill-radius")

  root.classList.toggle("dark", appearance.mode === "dark")
  root.classList.toggle("light", appearance.mode === "light")
  root.dataset.density = appearance.density
  return written
}

/**
 * Whether a stored value is an appearance we can apply.
 *
 * `chrome.storage.local` survives extension updates, so a value written by an
 * older build can arrive here shaped differently. Applying half of one leaves
 * the panel in a palette that is neither the Host's nor the fallback.
 */
export function isAppliedAppearance(value: unknown): value is AppliedAppearance {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    (candidate.mode === "light" || candidate.mode === "dark") &&
    typeof candidate.cssVars === "object" &&
    candidate.cssVars !== null &&
    typeof candidate.radiusBaseRem === "number" &&
    typeof candidate.pillRadiusPx === "number" &&
    (candidate.density === "compact" ||
      candidate.density === "comfortable" ||
      candidate.density === "spacious")
  )
}
