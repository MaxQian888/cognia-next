"use client"

import { IslandView } from "@/components/fleet/island-view"

// Transparent fleet-island overlay route. Rendered inside the frameless,
// always-on-top "island" Tauri window (fleet/island_window.rs). The desktop
// shell bypasses this prefix (desktop-app-shell.tsx BYPASS_PREFIXES) so no
// chrome paints, and IslandView marks <html data-island-overlay> to make the
// page background transparent.
export default function IslandPage() {
  return <IslandView />
}
