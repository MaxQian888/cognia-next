// Shared first-paint reveal for the transparent desktop overlay windows (pet
// sprite, pet click popup, and fleet island). Rust creates these windows
// `visible(false)` and never shows them on the create path, because on Windows
// a `transparent(true)` window shown before its WebView commits a first paint
// renders an opaque (black) rectangle until a recomposite — the "invisible /
// black until I click it" bug. The renderer calls this after mount; two rAFs
// (layout, then post-commit) guarantee the transparent, background-free frame
// is on screen before the window appears. Mirrors the main window's
// `WindowShowInitializer` contract.

import { isTauri } from "@/lib/platform/detect"
import { isMacPlatform } from "@/lib/tauri/os"
import { revealIslandWindow, revealPetWindow } from "@/lib/tauri/pet-window"
import { getPetWindowRole, PET_POPUP_WINDOW_LABEL, PET_WINDOW_LABEL } from "@/lib/pet/window-role"

export interface PetWindowRevealOptions {
  /**
   * Also focus the window right after showing it. The click popup needs this:
   * its native blur-to-close handler (Rust `WindowEvent::Focused(false)`) can
   * only fire once the window has held focus, exactly like a context menu.
   */
  focus?: boolean
}

/**
 * Schedule the current pet window's reveal after its first painted frame.
 * Returns a cancel function for the effect cleanup. No-op off Tauri (web /
 * tests never open these windows).
 *
 * Windows transparent-window quirk (tauri-apps/tauri#8632, #10318): a frameless
 * `transparent(true)` window composites OPAQUE (black) until its surface is
 * invalidated by a resize — the "black until I resize / click" bug. After
 * showing, nudge the physical height by 1px and restore it to force the
 * transparent recomposite immediately. Both pet windows are created
 * `resizable(false)`, which pins min=max and clamps a programmatic resize, so
 * briefly re-enable resizing across the nudge. Awaiting each step round-trips
 * through the OS event loop, so the two resizes aren't coalesced into a no-op.
 * Restoring the exact size + `resizable(false)` leaves the layout untouched.
 */
export function schedulePetWindowReveal(options: PetWindowRevealOptions = {}): () => void {
  if (!isTauri()) return () => {}
  let raf1 = 0
  let raf2 = 0
  let cancelled = false
  const reveal = () => {
    void (async () => {
      try {
        if (cancelled) return
        if (isMacPlatform()) {
          const role = getPetWindowRole()
          if (role === "island") {
            await revealIslandWindow(Boolean(options.focus))
          } else if (role === "overlay" || role === "popup") {
            await revealPetWindow(
              Boolean(options.focus),
              role === "popup" ? PET_POPUP_WINDOW_LABEL : PET_WINDOW_LABEL
            )
          }
          return
        }
        const [{ getCurrentWindow }, { PhysicalSize }] = await Promise.all([
          import("@tauri-apps/api/window"),
          import("@tauri-apps/api/dpi"),
        ])
        if (cancelled) return
        const win = getCurrentWindow()
        await win.show()
        if (options.focus) await win.setFocus()
        const size = await win.innerSize()
        if (cancelled) return
        await win.setResizable(true)
        await win.setSize(new PhysicalSize(size.width, size.height + 1))
        await win.setSize(new PhysicalSize(size.width, size.height))
        await win.setResizable(false)
      } catch {
        // Best-effort: if the reveal fails the window stays hidden, and
        // re-toggling it reopens via the already-painted re-show path.
      }
    })()
  }
  // A hidden macOS NSPanel may not receive animation frames until it is made
  // visible, creating a deadlock with the renderer-driven reveal. The native
  // panel path has no Windows transparent-surface resize requirement, so a
  // post-effect microtask is sufficient and remains cancellable on unmount.
  if (isMacPlatform()) {
    queueMicrotask(reveal)
    return () => {
      cancelled = true
    }
  }
  raf1 = requestAnimationFrame(() => {
    raf2 = requestAnimationFrame(reveal)
  })
  return () => {
    cancelled = true
    cancelAnimationFrame(raf1)
    cancelAnimationFrame(raf2)
  }
}
