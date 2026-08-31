import type { Platform } from "@/lib/platform/detect"

/**
 * Which of the two app shells owns the layout right now.
 *
 * `MobileShellWrapper` and `DesktopAppShell` are both mounted on every route
 * (`components/runtime/platform-shell.tsx`) and exactly one of them must draw
 * the frame. They used to agree by both testing `platform === "mobile"`, which
 * is why a 375px browser got the desktop three-pane workspace with `GuildRail`
 * hidden below `md` and therefore no navigation at all.
 *
 * The rule now has two parts, and the second one is not a rounding error:
 *
 *  - **Narrow and not Tauri: the compact shell wins.** A phone-width browser
 *    tab, and a native Capacitor shell at any width, get the phone frame.
 *  - **Tauri always keeps the desktop frame.** The desktop window is
 *    `decorations: false` (`src-tauri/tauri.conf.json`), so our own `TitleBar`
 *    carries the close / minimise / maximise controls. Handing the frame to
 *    the compact shell there would take the window controls away. The window's
 *    `minWidth` is 800, so this only comes up under heavy zoom, and keeping
 *    the desktop frame is the right answer in that corner.
 *
 * Both shells import this so they cannot drift into double-owning or
 * un-owning the layout.
 */
export function usesCompactShell(platform: Platform, compact: boolean): boolean {
  if (platform === "mobile") return true
  // Tauri for the window-controls reason above. `headless` has no webview at
  // all, so it renders neither shell; answering `false` keeps it on the branch
  // that expects a real viewport rather than letting an SSR-shaped snapshot
  // decide.
  if (platform === "tauri" || platform === "headless") return false
  return compact
}
