"use client"

import { NavBadgeProbes } from "@/components/shell/nav-badge-probes"
import { useAppAttentionCount, useAppBadge } from "@/hooks/desktop/use-app-badge"
import { useWindowTitle } from "@/hooks/desktop/use-window-title"
import { isMainAppWindow } from "@/lib/pet/window-role"

/**
 * Headless initializer that keeps the OS / document window title in sync with
 * the active conversation. Mounted once in the root providers tree so it
 * covers every shell (browser, Tauri desktop, Capacitor mobile). Renders
 * nothing visible.
 *
 * The main app window (the only window in a browser) also owns the app's
 * attention count: it mounts the navigation's badge probes
 * (`NavBadgeProbes`), pushes the total to the OS badge (`useAppBadge`) and
 * prefixes it to the browser tab's title. The auxiliary Tauri windows — pet,
 * island, selection toolbar — load this same layout, and none of them has a
 * navigation to badge or a dock tile of its own, so they only keep a title.
 * Which window this is never changes over its life, so the branch is stable.
 */
export function WindowTitleInitializer() {
  return isMainAppWindow() ? <MainWindowAttention /> : <AuxiliaryWindowTitle />
}

function MainWindowAttention() {
  const attention = useAppAttentionCount()
  useAppBadge(attention)
  useWindowTitle(attention)
  return <NavBadgeProbes />
}

function AuxiliaryWindowTitle() {
  useWindowTitle()
  return null
}
