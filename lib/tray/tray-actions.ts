// Renderer-side handlers for the tray's About / diagnostics actions. Rust
// re-emits each as a `tray://*` event (see `src-tauri/src/tray/mod.rs`); the
// `hooks/system/use-tauri-events.ts` listeners call straight into here.
//
// Logic lives here (not inline in the hook) so it stays unit-testable without
// mounting the whole Tauri-event harness. Every function takes an optional
// `deps` bag whose members default to the real implementations — tests pass
// fakes, production passes nothing.

"use client"

import {
  APP_NAME,
  APP_VERSION,
  getBuildInfo,
  getReleaseChannel,
  getRuntimeVersions,
} from "@/lib/app-metadata"
import { DOCS_URL, ISSUES_URL } from "@/lib/constants/external-urls"
import { writeClipboardText } from "@/lib/tauri/clipboard"
import { openExternal, revealInExplorer } from "@/lib/tauri/opener"
import { checkForUpdate, type AvailableUpdate } from "@/lib/tauri/updater"

import { toggleTrayAutostart } from "./autostart-control"

/** Flat, serialisable facts that go into the copied diagnostics blob. */
export interface DiagnosticsFacts {
  name: string
  version: string
  channel: string
  commit: string
  buildTime: string
  tauri: string | null
  react: string
  engine: string | null
  platform: string
}

/**
 * Render the diagnostics facts as a clipboard-friendly block. Pure — the
 * single most-tested unit in this module. Empty/unknown fields are shown as
 * "—" so a pasted report is never silently missing a line.
 */
export function formatDiagnostics(f: DiagnosticsFacts): string {
  const dash = (v: string | null | undefined) => (v && v.length ? v : "—")
  return [
    `${f.name} ${f.version} (${f.channel})`,
    `Commit:   ${dash(f.commit)}`,
    `Built:    ${dash(f.buildTime)}`,
    `Platform: ${dash(f.platform)}`,
    `Tauri:    ${dash(f.tauri)}`,
    `React:    ${dash(f.react)}`,
    `Engine:   ${dash(f.engine)}`,
  ].join("\n")
}

/** Read `navigator.platform` defensively (absent in node / SSR). */
function readPlatform(): string {
  return typeof navigator !== "undefined" && navigator.platform ? navigator.platform : ""
}

/** Gather the live diagnostics facts from the app-metadata helpers. */
export async function gatherDiagnostics(): Promise<DiagnosticsFacts> {
  const build = getBuildInfo()
  const runtime = await getRuntimeVersions()
  return {
    name: APP_NAME,
    version: APP_VERSION,
    channel: getReleaseChannel(),
    commit: build.commit,
    buildTime: build.buildTime,
    tauri: runtime.tauri,
    react: runtime.react,
    engine: runtime.engine,
    platform: readPlatform(),
  }
}

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

/** Open the GitHub issue tracker. */
export async function reportIssue(deps: TrayActionDeps = {}): Promise<void> {
  await (deps.openExternal ?? openExternal)(ISSUES_URL)
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
