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
/**
 * Minimum height for a page body that has to paint the compact shell's whole
 * visible area.
 *
 * NOT `min-h-[100dvh]`. `MobileShellWrapper`'s scrolling branch is
 * `min-h-[100dvh]` PLUS `pb-[calc(theme(spacing.14)+env(safe-area-inset-bottom))]`,
 * and `box-sizing: border-box` puts that padding inside the min-height. A child
 * asking for a whole viewport therefore forces the wrapper's content box to
 * 100dvh and the wrapper itself to 100dvh + the reserve, so the document scrolls
 * exactly one tab bar past the end of the page and the surplus reads as a strip
 * of bare background under it.
 *
 * The space a body can actually fill is the viewport minus that reserve, which
 * is what this says. Exported rather than inlined so the three bodies that need
 * it cannot drift from each other or from the bar they are clearing, and so a
 * grep for the reserve finds every claim about it in one pass.
 *
 * Safe off the compact shell too: without the wrapper's padding the body is
 * merely one tab bar shorter than the viewport, and every one of these is a
 * `flex-col` that grows past it the moment it holds content.
 */
export const COMPACT_PAGE_MIN_H =
  "min-h-[calc(100dvh-theme(spacing.14)-env(safe-area-inset-bottom))]"

/**
 * `bottom` for a viewport-anchored control that has to sit ABOVE the compact
 * shell's tab bar.
 *
 * `MobileTabBar` is `fixed inset-x-0 bottom-0` at
 * `h-[calc(theme(spacing.14)+env(safe-area-inset-bottom))]`. The usual spelling
 * for a floating control — `bottom-[max(1rem,env(safe-area-inset-bottom))]` —
 * only clears the safe area, so under the compact shell it renders INSIDE that
 * band and covers the bottom navigation. Same reserve as `COMPACT_PAGE_MIN_H`,
 * plus a 1rem gap so the control doesn't sit flush on the bar's border.
 *
 * A complete class literal, like `COMPACT_PAGE_MIN_H` above: Tailwind scans
 * source text, so an expression assembled from fragments generates no CSS.
 *
 * The `,0px` fallback is the one deliberate difference from the tab bar's own
 * declaration. An unsupported `env()` with no fallback invalidates the whole
 * property, and losing `bottom` drops a `fixed` control back to its static
 * offset; the bar only loses the inset off its height.
 *
 * Compact shell only — the desktop shell has no tab bar, so the lift would
 * leave a stray gap there. Pass it from the compact caller rather than baking a
 * platform check into a component both shells mount.
 */
export const COMPACT_ABOVE_TAB_BAR_BOTTOM =
  "bottom-[calc(theme(spacing.14)+env(safe-area-inset-bottom,0px)+1rem)]"

export function usesCompactShell(platform: Platform, compact: boolean): boolean {
  if (platform === "mobile") return true
  // Tauri for the window-controls reason above. `headless` has no webview at
  // all, so it renders neither shell; answering `false` keeps it on the branch
  // that expects a real viewport rather than letting an SSR-shaped snapshot
  // decide.
  if (platform === "tauri" || platform === "headless") return false
  return compact
}
