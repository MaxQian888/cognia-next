// "About ▸" submenu contents — the help / diagnostics cluster mature trays
// keep behind an About entry (version line, docs, issue tracker, data folder,
// copy-diagnostics, check-for-updates). The renderer's builder swaps the
// empty `tray.about` placeholder for what this module returns.
//
// Action rows carry native actions whose Rust handlers re-emit a `tray://*`
// event; `hooks/system/use-tauri-events.ts` does the renderer-side work
// (OS opener, clipboard, autostart plugin). The version row is a disabled
// literal — "Cognia v1.2.3" needs no translation.

import { APP_NAME } from "@/lib/app-metadata"
import type { TrayMenuItem, TrayStateSnapshot } from "./types"

/**
 * Build the About submenu children. `version` comes from the snapshot so the
 * row stays in lockstep with the running build without importing the version
 * constant at every call site.
 */
export function buildAboutSection(snapshot: TrayStateSnapshot): TrayMenuItem[] {
  return [
    {
      kind: "action",
      id: "tray.about.version",
      label: `${APP_NAME} v${snapshot.app.version}`,
      disabled: true,
      payload: { kind: "native", action: "noop" },
    },
    { kind: "separator", id: "tray.about.sep-1" },
    {
      kind: "action",
      id: "tray.about.check-updates",
      label: "tray.about.checkUpdates",
      payload: { kind: "native", action: "check-updates" },
    },
    {
      kind: "action",
      id: "tray.about.docs",
      label: "tray.about.docs",
      payload: { kind: "native", action: "open-docs" },
    },
    {
      kind: "action",
      id: "tray.about.report-issue",
      label: "tray.about.reportIssue",
      payload: { kind: "native", action: "report-issue" },
    },
    { kind: "separator", id: "tray.about.sep-2" },
    {
      kind: "action",
      id: "tray.about.open-data-folder",
      label: "tray.about.openDataFolder",
      payload: { kind: "native", action: "open-data-folder" },
    },
    {
      kind: "action",
      id: "tray.about.copy-diagnostics",
      label: "tray.about.copyDiagnostics",
      payload: { kind: "native", action: "copy-diagnostics" },
    },
  ]
}
