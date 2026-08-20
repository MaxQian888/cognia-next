/**
 * Report channels: where a finished report can go.
 *
 * Built-ins are the three destinations every surface used to hand-roll —
 * clipboard, a Markdown download, and a pre-filled issue on the tracker. A
 * plugin or subsystem can add more via {@link registerSupportReportChannel}
 * (a team inbox, a vendor ticket API) and the dialog will render a button for
 * it.
 *
 * Shell IO is imported lazily inside `deliver()` so the static error boundary
 * chunk stays free of the Tauri plugins until a button is actually pressed.
 */

import { isCapacitor, isTauri } from "@/lib/platform/detect"

import { buildIssueUrl, resolveIssueTrackerUrl } from "./issue-url"
import type { SupportReport, SupportReportChannelSpec } from "./types"

/** Seams for the built-in channels; production passes nothing. */
export interface SupportReportChannelDeps {
  writeClipboard?: (text: string) => Promise<void>
  download?: (filename: string, content: string, mimeType: string) => void
  openExternal?: (url: string) => Promise<void>
  issueTrackerUrl?: string
}

async function defaultWriteClipboard(text: string): Promise<void> {
  const { writeClipboardText } = await import("@/lib/tauri/clipboard")
  await writeClipboardText(text)
}

async function defaultDownload(filename: string, content: string, mimeType: string): Promise<void> {
  const { downloadFile } = await import("@/lib/files/download")
  downloadFile(filename, content, mimeType)
}

async function defaultOpenExternal(url: string): Promise<void> {
  const { openExternal } = await import("@/lib/tauri/opener")
  await openExternal(url)
}

/** True when some clipboard backend exists, so the button is never a silent no-op. */
function clipboardAvailable(): boolean {
  if (isTauri() || isCapacitor()) return true
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function"
}

/** Build the three built-in channels, optionally over injected IO. */
export function createBuiltinSupportReportChannels(
  deps: SupportReportChannelDeps = {}
): SupportReportChannelSpec[] {
  const writeClipboard = deps.writeClipboard ?? defaultWriteClipboard
  const download = deps.download ?? defaultDownload
  const openExternal = deps.openExternal ?? defaultOpenExternal
  return [
    {
      id: "copy",
      labelKey: "copy",
      isAvailable: clipboardAvailable,
      deliver: async (report: SupportReport) => {
        await writeClipboard(report.markdown)
      },
    },
    {
      id: "download",
      labelKey: "download",
      isAvailable: () => typeof document !== "undefined",
      deliver: async (report: SupportReport) => {
        await download(report.filename, report.markdown, "text/markdown;charset=utf-8")
      },
    },
    {
      id: "issue",
      labelKey: "issue",
      primary: true,
      isAvailable: () => true,
      deliver: async (report: SupportReport) => {
        const base = deps.issueTrackerUrl ?? resolveIssueTrackerUrl()
        await openExternal(buildIssueUrl(base, report.title, report.markdown))
      },
    },
  ]
}

const builtins = createBuiltinSupportReportChannels()
const registered = new Map<string, SupportReportChannelSpec>()

/**
 * Bumped on every registration change.
 *
 * The registry is a module singleton, so a React surface that read it during
 * render had no way to learn that a channel appeared afterwards — which is
 * exactly what happens when a channel is registered from an effect. Exposing a
 * version plus a subscription makes the promise in this module's own header
 * ("the dialog will render a button for it") true for late registrations too.
 */
let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}

/** Current registry version — a `useSyncExternalStore` snapshot. */
export function supportReportChannelsVersion(): number {
  return version
}

/** Subscribe to registration changes. Returns the unsubscribe function. */
export function subscribeSupportReportChannels(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Contribute a channel. Duplicate ids throw. Returns the unregister function. */
export function registerSupportReportChannel(spec: SupportReportChannelSpec): () => void {
  if (registered.has(spec.id) || builtins.some((c) => c.id === spec.id)) {
    throw new Error(`Support report channel "${spec.id}" is already registered.`)
  }
  registered.set(spec.id, spec)
  notify()
  return () => {
    if (registered.get(spec.id) === spec) {
      registered.delete(spec.id)
      notify()
    }
  }
}

/**
 * Built-ins first, then registrations in registration order. Passing `deps`
 * swaps the built-ins for ones bound to those seams (test IO, the error page's
 * configured tracker) while leaving registered channels untouched.
 */
export function listSupportReportChannels(
  deps?: SupportReportChannelDeps
): SupportReportChannelSpec[] {
  return [...(deps ? createBuiltinSupportReportChannels(deps) : builtins), ...registered.values()]
}

/** Channels that can deliver in the current shell. */
export function listAvailableSupportReportChannels(
  deps?: SupportReportChannelDeps
): SupportReportChannelSpec[] {
  return listSupportReportChannels(deps).filter((channel) => channel.isAvailable())
}

/**
 * Deliver through a channel by id. Built-in ids honour `deps` (test seams and
 * the error page's configured tracker); registered channels ignore it.
 */
export async function deliverSupportReport(
  channelId: string,
  report: SupportReport,
  deps?: SupportReportChannelDeps
): Promise<void> {
  const channel = listSupportReportChannels(deps).find((c) => c.id === channelId)
  if (!channel) throw new Error(`Unknown support report channel "${channelId}".`)
  await channel.deliver(report)
}

/** Test-only: drop every registration. */
export function __resetSupportReportChannelsForTesting(): void {
  registered.clear()
  notify()
}
