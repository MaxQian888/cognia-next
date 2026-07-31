/**
 * OSC-8 terminal hyperlinks. Modern terminals render
 * `ESC ]8;;URL BEL LABEL ESC ]8;; BEL` as a clickable link showing only LABEL.
 * Terminals that do not support it usually print just LABEL (the escapes are
 * ignored), but some older/unknown ones show raw bytes — so we emit it ONLY on
 * terminals with confirmed support (an allow-list).
 */

/** OSC-8 opener: ESC ] 8 ; ; */
const OSC8_OPEN = "]8;;"
/** BEL terminator for the URL and the closing sequence. */
const BEL = ""

/**
 * Wrap `label` in an OSC-8 hyperlink to `url`. The visible text is exactly
 * `label`, so display width is unchanged (the escapes are zero-width).
 */
export function osc8Link(url: string, label: string): string {
  return `${OSC8_OPEN}${url}${BEL}${label}${OSC8_OPEN}${BEL}`
}

/**
 * Conservative allow-list detection of OSC-8 hyperlink support. We only return
 * true for terminals with confirmed support, because a false positive prints
 * raw escape bytes. Honours an explicit `FORCE_HYPERLINK` override (a non-"0"/
 * non-"false" value forces on, "0"/"false" forces off) for unlisted terminals.
 *
 * @param env Environment to inspect (e.g. `process.env`).
 */
export function supportsHyperlinks(env: Record<string, string | undefined> = process.env): boolean {
  const force = env.FORCE_HYPERLINK
  if (force !== undefined && force !== "") return force !== "0" && force.toLowerCase() !== "false"

  // CI rarely renders OSC-8 usefully and often logs raw bytes — stay off.
  if (env.CI) return false

  // Windows Terminal (sets WT_SESSION) supports OSC-8.
  if (env.WT_SESSION) return true

  // kitty and ghostty.
  if (env.KITTY_WINDOW_ID || (env.TERM ?? "").toLowerCase().includes("kitty")) return true
  if (env.GHOSTTY_RESOURCES_DIR || (env.TERM_PROGRAM ?? "").toLowerCase() === "ghostty") return true

  const program = (env.TERM_PROGRAM ?? "").toLowerCase()
  if (
    program === "iterm.app" ||
    program === "wezterm" ||
    program === "vscode" ||
    program === "hyper"
  ) {
    return true
  }

  // VTE-based terminals (GNOME Terminal, Tilix, …) added OSC-8 in 0.50.x → the
  // VTE_VERSION env is a build number; 5000+ is safe.
  const vte = Number.parseInt(env.VTE_VERSION ?? "", 10)
  if (Number.isFinite(vte) && vte >= 5000) return true

  return false
}
