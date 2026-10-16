/**
 * What runs in a tab's isolated world just before the overlay (ADR-0228 §6).
 *
 * `overlay.injected.js` was written for the embedded webview, where Rust
 * intercepts navigations to `https://cognia.invalid/…` sentinel URLs. In a real
 * tab nothing intercepts them, so each of its outbound channels must be
 * replaced before it loads — it checks for these overrides and prefers them:
 *
 * - selection, navigation, load and push signals become no-ops (the agent
 *   reads state by asking, not by being told);
 * - an in-page "open in new tab" (a `target="_blank"` link the overlay
 *   intercepts) is forwarded to the extension, which opens it in the
 *   conversation's tab group — the link still opens, where it belongs.
 */
type PreludeWindow = Window & Record<string, unknown>

export function installOverlayPrelude(win: PreludeWindow, openTab: (url: string) => void): void {
  if (win.__cogniaPreludeInstalled) return
  win.__cogniaPreludeInstalled = true
  const quiet = () => undefined
  win.__cogniaSignal = quiet
  win.__cogniaSignalNav = quiet
  win.__cogniaSignalLoaded = quiet
  win.__cogniaSignalPush = quiet
  win.__cogniaNavTo = (url: unknown) => {
    if (typeof url === "string") openTab(url)
  }
}
