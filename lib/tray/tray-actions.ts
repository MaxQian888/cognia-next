// Renderer-side handlers for the tray's About / diagnostics actions. Rust
// re-emits each as a `tray://*` event (see `src-tauri/src/tray/mod.rs`); the
// `hooks/system/use-tauri-events.ts` listeners call straight into here.
//
// Logic lives here (not inline in the hook) so it stays unit-testable without
// mounting the whole Tauri-event harness. Every function takes an optional
// `deps` bag whose members default to the real implementations — tests pass
// fakes, production passes nothing.

"use client"

import { DOCS_URL } from "@/lib/constants/external-urls"
import {
  gatherDiagnostics,
  formatDiagnostics,
  type DiagnosticsFacts,
} from "@/lib/support-report/app-facts"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { openExternal, revealInExplorer } from "@/lib/tauri/opener"
import { checkForUpdate, type AvailableUpdate } from "@/lib/tauri/updater"

import { toggleTrayAutostart } from "./autostart-control"

/** Resolve the OS-level app-data directory (where Dexie / keyring live). */
async function defaultAppDataDir(): Promise<string> {
  const { appDataDir } = await import("@tauri-apps/api/path")
  return appDataDir()
}

export interface TrayActionDeps {
  openExternal?: (url: string) => Promise<void>
  reveal?: (path: string) => Promise<void>
  appDataDir?: () => Promise<string>
  writeClipboard?: (text: string) => Promise<void>
  gather?: () => Promise<DiagnosticsFacts>
  toggleAutostart?: () => Promise<boolean>
  check?: () => Promise<AvailableUpdate | null>
  requestReport?: () => void
}

/**
 * Result of the tray "Check for updates" action, rendered by the
 * `use-tauri-events` listener (which owns the toast + Settings navigation). The
 * lib stays i18n-free so it remains a pure unit.
 */
export type TrayUpdateOutcome =
  { kind: "available"; version: string } | { kind: "upToDate" } | { kind: "error"; message: string }

/** Reveal the app-data folder in the OS file explorer. */
export async function openDataFolder(deps: TrayActionDeps = {}): Promise<void> {
  const dir = await (deps.appDataDir ?? defaultAppDataDir)()
  await (deps.reveal ?? revealInExplorer)(dir)
}

/** Build the diagnostics blob and copy it to the clipboard. Returns the text. */
export async function copyDiagnostics(deps: TrayActionDeps = {}): Promise<string> {
  const facts = await (deps.gather ?? gatherDiagnostics)()
  const text = formatDiagnostics(facts)
  await (deps.writeClipboard ?? writeClipboardText)(text)
  return text
}

/** Open the public documentation site. */
export async function openDocs(deps: TrayActionDeps = {}): Promise<void> {
  await (deps.openExternal ?? openExternal)(DOCS_URL)
}

/** Open the in-app "Report a problem" dialog (Rust brings the main window forward first). */
async function defaultRequestReport(): Promise<void> {
  const { useUIStore } = await import("@/stores/ui")
  useUIStore.getState().requestReportProblem({ surface: "tray" })
}

/**
 * "Report issue" — opens the unified report dialog rather than a bare tracker
 * link, so a tray-initiated report carries the same redacted sections and
 * pre-filled issue as every other surface.
 */
export async function reportIssue(deps: TrayActionDeps = {}): Promise<void> {
  if (deps.requestReport) {
    deps.requestReport()
    return
  }
  await defaultRequestReport()
}

/**
 * "Check for updates". Runs the same in-app updater check as the About card and
 * command palette (no longer just opening the Releases page) so every surface
 * behaves identically. Returns the outcome for the caller to surface — the
 * download + relaunch still happens in Settings → About.
 */
export async function checkUpdates(deps: TrayActionDeps = {}): Promise<TrayUpdateOutcome> {
  try {
    const update = await (deps.check ?? checkForUpdate)()
    return update ? { kind: "available", version: update.version } : { kind: "upToDate" }
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) }
  }
}

/** Flip the OS launch-at-login entry; returns the new on/off state. */
export async function toggleAutostartAction(deps: TrayActionDeps = {}): Promise<boolean> {
  return (deps.toggleAutostart ?? toggleTrayAutostart)()
}
