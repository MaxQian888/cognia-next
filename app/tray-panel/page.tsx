"use client"

import { TrayPanelView } from "@/components/tray-panel/tray-panel-view"

// Transparent tray quick-panel route. Rendered inside the frameless,
// always-on-top "tray-panel" Tauri window that `open_tray_panel` opens when the
// user clicks the tray icon. The desktop shell bypasses this prefix (see
// `desktop-app-shell.tsx` BYPASS_PREFIXES) so no chrome paints, and
// TrayPanelView marks <html> with `data-pet-overlay` for a transparent page.
export default function TrayPanelPage() {
  return <TrayPanelView />
}
