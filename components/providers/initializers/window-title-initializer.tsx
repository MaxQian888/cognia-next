"use client"

import { useWindowTitle } from "@/hooks/desktop/use-window-title"

/**
 * Headless initializer that keeps the OS / document window title in sync with
 * the active conversation. Mounted once in the root providers tree so it
 * covers every shell (browser, Tauri desktop, Capacitor mobile). Renders
 * nothing.
 */
export function WindowTitleInitializer() {
  useWindowTitle()
  return null
}
