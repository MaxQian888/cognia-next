/**
 * Capacitor variant of the platform shell — see `platform-shell.tsx` for how
 * the `.mobile.tsx` extension is selected and why the seam exists.
 *
 * `DesktopAppShell` returns bare children whenever `usePlatform()` is
 * `"mobile"` (`components/desktop/desktop-app-shell.tsx`), so on the phone it
 * is a pure pass-through. It is left out of this build entirely rather than
 * bundled in order to be short-circuited: dropping it takes the whole desktop
 * chrome graph out of the Capacitor bundle.
 */

import { MobileShellWrapper } from "@/components/mobile/shell/mobile-shell-wrapper"

export function PlatformShell({ children }: { children: React.ReactNode }) {
  return <MobileShellWrapper>{children}</MobileShellWrapper>
}
