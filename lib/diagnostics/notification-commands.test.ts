/** @jest-environment jsdom */

const shell = {
  requestOpenSettings: jest.fn((_section: string) => undefined),
  exportCrashLogBundleNow: jest.fn(async () => undefined),
  openExternal: jest.fn(async (_url: string) => undefined),
  writeClipboardText: jest.fn(async (_text: string) => undefined),
  restartSidecar: jest.fn(async () => undefined),
  getNotification: jest.fn(async (_id: string) => undefined),
  remove: jest.fn(async (_id: string) => undefined),
  buildSupportReport: jest.fn(async (_options: unknown) => report),
  deliverSupportReport: jest.fn(async (..._args: unknown[]) => undefined),
}
jest.mock("@/stores/ui", () => ({
  useUIStore: { getState: () => ({ requestOpenSettings: shell.requestOpenSettings }) },
}))
jest.mock("@/lib/logging/crash-log", () => ({
  exportCrashLogBundleNow: () => shell.exportCrashLogBundleNow(),
}))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: (u: string) => shell.openExternal(u) }))
jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: (t: string) => shell.writeClipboardText(t),
}))
jest.mock("@/lib/claude/ipc", () => ({ restartSidecar: () => shell.restartSidecar() }))
jest.mock("@/lib/db/notifications", () => ({
  getNotification: (id: string) => shell.getNotification(id),
}))
jest.mock("@/stores/notifications/notification-store", () => ({
  useNotificationStore: { getState: () => ({ remove: shell.remove }) },
}))
jest.mock("@/lib/support-report/build", () => ({
  buildSupportReport: (o: unknown) => shell.buildSupportReport(o),
}))
jest.mock("@/lib/support-report/channels", () => ({
  deliverSupportReport: (...a: unknown[]) => shell.deliverSupportReport(...a),
}))

import type { DiagnosticActionKind } from "@cognia/diagnostics"

import {
  __resetNotificationCommandsForTesting,
  dispatchNotificationCommand,
  hasNotificationCommand,
} from "@/lib/notifications/action-registry"
import type { NotificationRecord } from "@/types/notifications"

import { DIAGNOSTIC_ACTION_SPECS, diagnosticActionCommand } from "./actions"
import {
  EXECUTABLE_DIAGNOSTIC_ACTION_KINDS,
  installDiagnosticNotificationCommands,
  type DiagnosticCommandOptions,
} from "./notification-commands"

const report = {
  title: "[system] sidecarCrashed",
  markdown: "## Cognia support report\n",
  filename: "cognia-support-report.md",
  generatedAt: "2026-08-16T00:00:00.000Z",
  sectionIds: ["diagnostic"],
}

function fakeDeps(): Required<DiagnosticCommandOptions> {
  return {
    navigate: jest.fn(),
    openSettings: jest.fn(),
    reload: jest.fn(),
    exportCrashLog: jest.fn(async () => undefined),
    openExternal: jest.fn(async () => undefined),
    writeClipboard: jest.fn(async () => undefined),
    restartSidecar: jest.fn(async () => undefined),
    getNotification: jest.fn(async () => undefined as NotificationRecord | undefined),
    removeNotification: jest.fn(async () => undefined),
    buildReport: jest.fn(async () => report),
    deliverReport: jest.fn(async () => undefined),
  }
}

const dispatch = (kind: DiagnosticActionKind, args?: Record<string, unknown>, id = "n1") =>
  dispatchNotificationCommand({ notificationId: id, command: diagnosticActionCommand(kind), args })

beforeEach(() => __resetNotificationCommandsForTesting())

describe("installDiagnosticNotificationCommands", () => {
  it("registers exactly the executable kinds, all of them global, and disposes them together", () => {
    const off = installDiagnosticNotificationCommands(fakeDeps())
    for (const kind of EXECUTABLE_DIAGNOSTIC_ACTION_KINDS) {
      expect(hasNotificationCommand(diagnosticActionCommand(kind))).toBe(true)
      expect(DIAGNOSTIC_ACTION_SPECS[kind].availability).toBe("global")
    }
    expect(hasNotificationCommand(diagnosticActionCommand("retry"))).toBe(false)
    expect(hasNotificationCommand(diagnosticActionCommand("reauth"))).toBe(false)
    off()
    for (const kind of EXECUTABLE_DIAGNOSTIC_ACTION_KINDS) {
      expect(hasNotificationCommand(diagnosticActionCommand(kind))).toBe(false)
    }
  })

  it("routes the simple kinds to their executors", async () => {
    const deps = fakeDeps()
    installDiagnosticNotificationCommands(deps)

    await dispatch("open-settings", { section: "providers" })
    await dispatch("open-settings", {})
    expect(deps.openSettings).toHaveBeenNthCalledWith(1, "providers")
    expect(deps.openSettings).toHaveBeenNthCalledWith(2, "general")

    await dispatch("view-logs")
    expect(deps.navigate).toHaveBeenCalledWith("/logs")

    await dispatch("reload-app")
    expect(deps.reload).toHaveBeenCalledTimes(1)

    await dispatch("export-crash-log")
    expect(deps.exportCrashLog).toHaveBeenCalledTimes(1)

    await dispatch("open-external", { url: "https://docs.test" })
    await dispatch("open-external", { url: "" })
    await dispatch("open-external")
    expect(deps.openExternal).toHaveBeenCalledTimes(1)
    expect(deps.openExternal).toHaveBeenCalledWith("https://docs.test")

    await dispatch("copy-install-command", { command: "npm i -g codex" })
    await dispatch("copy-install-command", { command: 42 })
    expect(deps.writeClipboard).toHaveBeenCalledTimes(1)
    expect(deps.writeClipboard).toHaveBeenCalledWith("npm i -g codex")

    await dispatch("restart-sidecar")
    expect(deps.restartSidecar).toHaveBeenCalledTimes(1)

    await dispatch("dismiss", undefined, "n42")
    expect(deps.removeNotification).toHaveBeenCalledWith("n42")
  })

  it("builds the report from the notification record and delivers it", async () => {
    const deps = fakeDeps()
    deps.getNotification = jest.fn(
      async () =>
        ({
          id: "n1",
          source: "system",
          body: "The sidecar exited",
          meta: { diagnosticCode: "sidecarCrashed" },
        }) as unknown as NotificationRecord
    )
    installDiagnosticNotificationCommands(deps)

    await dispatch("copy-report")
    expect(deps.buildReport).toHaveBeenCalledWith({
      context: {
        surface: "notification",
        diagnostic: {
          code: "sidecarCrashed",
          source: "system",
          message: "The sidecar exited",
        },
      },
    })
    expect(deps.deliverReport).toHaveBeenCalledWith("copy", report)

    await dispatch("report-issue")
    expect(deps.deliverReport).toHaveBeenLastCalledWith("issue", report)
  })

  it("still files a report when the record is gone or carries no code", async () => {
    const deps = fakeDeps()
    installDiagnosticNotificationCommands(deps)
    await dispatch("report-issue", undefined, "missing")
    expect(deps.buildReport).toHaveBeenCalledWith({
      context: { surface: "notification", diagnostic: { code: "unknown" } },
    })

    deps.getNotification = jest.fn(
      async () =>
        ({
          id: "n2",
          source: "session",
          meta: { diagnosticCode: "" },
        }) as unknown as NotificationRecord
    )
    __resetNotificationCommandsForTesting()
    installDiagnosticNotificationCommands(deps)
    await dispatch("copy-report", undefined, "n2")
    expect(deps.buildReport).toHaveBeenLastCalledWith({
      context: { surface: "notification", diagnostic: { code: "unknown", source: "session" } },
    })
  })
})

describe("default executors", () => {
  it("resolve the real shell modules lazily", async () => {
    installDiagnosticNotificationCommands({ navigate: jest.fn() })

    await dispatch("open-settings", { section: "logs" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(shell.requestOpenSettings).toHaveBeenCalledWith("logs")

    await dispatch("export-crash-log")
    expect(shell.exportCrashLogBundleNow).toHaveBeenCalledTimes(1)

    await dispatch("open-external", { url: "https://docs.test" })
    expect(shell.openExternal).toHaveBeenCalledWith("https://docs.test")

    await dispatch("copy-install-command", { command: "brew install x" })
    expect(shell.writeClipboardText).toHaveBeenCalledWith("brew install x")

    await dispatch("restart-sidecar")
    expect(shell.restartSidecar).toHaveBeenCalledTimes(1)

    await dispatch("dismiss", undefined, "n9")
    expect(shell.remove).toHaveBeenCalledWith("n9")

    await dispatch("copy-report", undefined, "n9")
    expect(shell.getNotification).toHaveBeenCalledWith("n9")
    expect(shell.buildSupportReport).toHaveBeenCalledTimes(1)
    expect(shell.deliverSupportReport).toHaveBeenCalledWith("copy", report, undefined)
  })
})
