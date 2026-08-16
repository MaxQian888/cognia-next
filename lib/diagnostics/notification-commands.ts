/**
 * Executors for the `global` diagnostic actions when they are clicked from a
 * persisted notification row.
 *
 * `toNotificationActions` projects every global {@link DiagnosticAction} onto a
 * `NotificationAction` whose `command` is `diagnostic.<kind>` — but nothing
 * ever registered those commands, so the notification center rendered buttons
 * that logged "no handler" and did nothing. This module is the other half of
 * that projection: one handler per global kind that has a real, surface-free
 * executor. Kinds that need live host state (`retry`, `reset-boundary`, …) are
 * never projected, and kinds whose global executor does not exist yet
 * (`reauth`, `reconnect-*`, `locate-binary`) are deliberately NOT registered —
 * `toNotificationActions` now drops unregistered kinds so the row never shows
 * a dead button.
 *
 * `copy-report` / `report-issue` build the unified support report from the
 * notification's own record (its diagnostic code + body), so a report filed
 * from a row days later still names the failure it came from.
 */

import type { DiagnosticActionKind } from "@cognia/diagnostics"
import {
  registerNotificationCommand,
  type NotificationActionContext,
} from "@/lib/notifications/action-registry"
import type { buildSupportReport } from "@/lib/support-report/build"
import type { deliverSupportReport } from "@/lib/support-report/channels"
import type { NotificationRecord } from "@/types/notifications"

import { diagnosticActionCommand } from "./actions"

export interface DiagnosticCommandDeps {
  /** Route navigation — supplied by the mounting hook, which owns the router. */
  navigate: (path: string) => void
  openSettings: (section: string) => void
  reload: () => void
  exportCrashLog: () => Promise<void>
  openExternal: (url: string) => Promise<void>
  writeClipboard: (text: string) => Promise<void>
  restartSidecar: () => Promise<void>
  getNotification: (id: string) => Promise<NotificationRecord | undefined>
  removeNotification: (id: string) => Promise<void>
  buildReport: typeof buildSupportReport
  deliverReport: typeof deliverSupportReport
}

/** Everything but `navigate` has a shell-neutral default; tests inject fakes. */
export type DiagnosticCommandOptions = Pick<DiagnosticCommandDeps, "navigate"> &
  Partial<Omit<DiagnosticCommandDeps, "navigate">>

const defaultDeps: Omit<DiagnosticCommandDeps, "navigate"> = {
  openSettings: (section) => {
    void import("@/stores/ui").then(({ useUIStore }) =>
      useUIStore.getState().requestOpenSettings(section)
    )
  },
  reload: () => {
    window.location.reload()
  },
  exportCrashLog: async () => {
    const { exportCrashLogBundleNow } = await import("@/lib/logging/crash-log")
    await exportCrashLogBundleNow()
  },
  openExternal: async (url) => {
    const { openExternal } = await import("@/lib/tauri/opener")
    await openExternal(url)
  },
  writeClipboard: async (text) => {
    const { writeClipboardText } = await import("@/lib/tauri/clipboard")
    await writeClipboardText(text)
  },
  restartSidecar: async () => {
    const { restartSidecar } = await import("@/lib/claude/ipc")
    await restartSidecar()
  },
  getNotification: async (id) => {
    const { getNotification } = await import("@/lib/db/notifications")
    return getNotification(id)
  },
  removeNotification: async (id) => {
    const { useNotificationStore } = await import("@/stores/notifications/notification-store")
    await useNotificationStore.getState().remove(id)
  },
  buildReport: async (options) => {
    const { buildSupportReport } = await import("@/lib/support-report/build")
    return buildSupportReport(options)
  },
  deliverReport: async (channelId, report, deps) => {
    const { deliverSupportReport } = await import("@/lib/support-report/channels")
    await deliverSupportReport(channelId, report, deps)
  },
}

/** The kinds this module can execute — the only `diagnostic.*` commands that exist. */
export const EXECUTABLE_DIAGNOSTIC_ACTION_KINDS = [
  "open-settings",
  "view-logs",
  "reload-app",
  "export-crash-log",
  "open-external",
  "copy-install-command",
  "restart-sidecar",
  "copy-report",
  "report-issue",
  "dismiss",
] as const satisfies readonly DiagnosticActionKind[]

export type ExecutableDiagnosticActionKind = (typeof EXECUTABLE_DIAGNOSTIC_ACTION_KINDS)[number]

async function reportFromNotification(
  deps: DiagnosticCommandDeps,
  notificationId: string,
  channelId: "copy" | "issue"
): Promise<void> {
  const record = await deps.getNotification(notificationId)
  const code = record?.meta?.diagnosticCode
  const report = await deps.buildReport({
    context: {
      surface: "notification",
      diagnostic: {
        code: typeof code === "string" && code.length > 0 ? code : "unknown",
        ...(record?.source ? { source: record.source } : {}),
        ...(record?.body ? { message: record.body } : {}),
      },
    },
  })
  await deps.deliverReport(channelId, report)
}

type Handler = (deps: DiagnosticCommandDeps, ctx: NotificationActionContext) => void | Promise<void>

/** Total over {@link EXECUTABLE_DIAGNOSTIC_ACTION_KINDS} — adding a kind there without a handler is a compile error. */
const HANDLERS: Record<ExecutableDiagnosticActionKind, Handler> = {
  "open-settings": (deps, { args }) => {
    const section = args?.section
    deps.openSettings(typeof section === "string" && section.length > 0 ? section : "general")
  },
  "view-logs": (deps) => {
    deps.navigate("/logs")
  },
  "reload-app": (deps) => {
    deps.reload()
  },
  "export-crash-log": async (deps) => {
    await deps.exportCrashLog()
  },
  "open-external": async (deps, { args }) => {
    const url = args?.url
    if (typeof url === "string" && url.length > 0) await deps.openExternal(url)
  },
  "copy-install-command": async (deps, { args }) => {
    const command = args?.command
    if (typeof command === "string" && command.length > 0) await deps.writeClipboard(command)
  },
  "restart-sidecar": async (deps) => {
    await deps.restartSidecar()
  },
  "copy-report": async (deps, { notificationId }) => {
    await reportFromNotification(deps, notificationId, "copy")
  },
  "report-issue": async (deps, { notificationId }) => {
    await reportFromNotification(deps, notificationId, "issue")
  },
  dismiss: async (deps, { notificationId }) => {
    await deps.removeNotification(notificationId)
  },
}

/**
 * Register every executable `diagnostic.*` command. Returns the disposer that
 * unregisters all of them; the mounting hook calls it on unmount.
 */
export function installDiagnosticNotificationCommands(
  options: DiagnosticCommandOptions
): () => void {
  const deps: DiagnosticCommandDeps = { ...defaultDeps, ...options }
  const disposers = EXECUTABLE_DIAGNOSTIC_ACTION_KINDS.map((kind) =>
    registerNotificationCommand(diagnosticActionCommand(kind), (ctx) => HANDLERS[kind](deps, ctx))
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
}
