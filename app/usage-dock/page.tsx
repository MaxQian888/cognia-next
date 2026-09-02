"use client"

import { UsageDockView } from "@/components/usage-dock/usage-dock-view"

// Transparent Capacity Dock route (ADR-0165). Rendered inside the frameless,
// always-on-top `usage-dock` Tauri window that `usage_dock_open` creates. The
// desktop shell bypasses this prefix (see `desktop-app-shell.tsx`
// BYPASS_PREFIXES) so no chrome paints, and `UsageDockView` marks <html> with
// `data-pet-overlay` for a transparent page.
export default function UsageDockPage() {
  return <UsageDockView />
}
