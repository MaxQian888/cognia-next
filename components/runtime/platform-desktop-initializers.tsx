/**
 * Desktop boot initializers seam — DEFAULT variant (browser + Tauri).
 *
 * `DesktopOnlyInitializers` already carries its own runtime gate (`isTauri()`
 * plus the `desktop-tools` boot capability and the pet-window role) and loads
 * every child through `next/dynamic`, so the browser dev server never compiles
 * their subsystem graphs and the desktop build loads them at runtime. That
 * gate is what makes web and Tauri able to share one `out/`, and this variant
 * must keep mounting it for BOTH — including `pnpm tauri dev`, which builds
 * the default variant.
 *
 * `platform-desktop-initializers.mobile.tsx` is the Capacitor variant: it
 * renders nothing, so `next build` emits none of those dynamic chunks into the
 * `out/` that Capacitor copies into the app bundle.
 */

import { DesktopOnlyInitializers } from "@/components/providers/initializers/desktop-only-initializers"

export function PlatformDesktopInitializers() {
  return <DesktopOnlyInitializers />
}
