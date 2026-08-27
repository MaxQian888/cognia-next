/**
 * Platform shell seam — the single place `app/layout.tsx` asks for "whatever
 * chrome this build target needs" instead of naming both shells itself.
 *
 * This file is the DEFAULT variant, resolved by the browser build and by the
 * Tauri desktop build (they consume the same `out/`, so they must resolve the
 * same module). It mounts both shells, exactly as the layout used to: they are
 * mutually exclusive at RUNTIME — `MobileShellWrapper` collapses to a
 * `display:contents` pass-through off Capacitor, and `DesktopAppShell` returns
 * bare children on it — so one bundle serves web and desktop correctly.
 *
 * `platform-shell.mobile.tsx` beside this file is the Capacitor variant. It is
 * selected by the `.mobile.tsx` platform extension that `next.config.ts`
 * prepends to `resolve.extensions` when `NEXT_PUBLIC_PLATFORM=mobile` (the
 * React Native / metro convention, applied to webpack). The runtime gates stay
 * in place either way; the variant exists so the phone bundle does not carry
 * the desktop chrome's module graph — title bar, guild rail, status bar,
 * command palette, terminal dock, extension-host bar — that can never run
 * there.
 *
 * Do NOT slim this variant down to the desktop shell alone. `tests/e2e/mobile/**`
 * runs against the WEB build and fakes Capacitor at runtime with
 * `injectCapacitor`, so `MobileShellWrapper` has to be in this tree for the
 * mobile layout, tab bar and keyboard-avoidance specs to have anything to
 * assert against.
 */

import { DesktopAppShell } from "@/components/desktop/desktop-app-shell"
import { MobileShellWrapper } from "@/components/mobile/shell/mobile-shell-wrapper"

export function PlatformShell({ children }: { children: React.ReactNode }) {
  return (
    <MobileShellWrapper>
      <DesktopAppShell>{children}</DesktopAppShell>
    </MobileShellWrapper>
  )
}
