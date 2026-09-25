/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useFormatter: () => ({
    dateTime: (d: Date) => `fmt:${d.toISOString()}`,
    number: (n: number) => `num:${n}`,
  }),
}))

// The shared index loader talks to the real backup manager; this suite injects
// its own client, so only the revision signal is needed.
jest.mock("@/hooks/plugins/use-plugin-rollback-availability", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react") as typeof import("react")
  let revision = 0
  const listeners = new Set<() => void>()
  return {
    usePluginBackupIndexRevision: () =>
      React.useSyncExternalStore(
        (l: () => void) => {
          listeners.add(l)
          return () => listeners.delete(l)
        },
        () => revision,
        () => 0
      ),
    notifyPluginBackupsChanged: () => {
      revision += 1
      for (const l of listeners) l()
    },
  }
})

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

import { PluginBackupPanel, __resetPluginBackupClientForTests } from "./plugin-backup-panel"
import { isTauri } from "@/lib/tauri"

const sampleBackup = {
  id: "snap1234567",
  pluginId: "alpha",
  version: "1.2.3",
  createdAt: new Date("2026-05-03T12:00:00.000Z"),
  reason: "manual" as const,
  size: 4096,
  path: "/tmp/x",
}

beforeEach(() => {
  __resetPluginBackupClientForTests(null)
  ;(isTauri as jest.Mock).mockReturnValue(true)
})

describe("PluginBackupPanel", () => {
  it("renders empty state when no backups exist", () => {
    __resetPluginBackupClientForTests({
      createBackup: jest.fn(),
      restore: jest.fn(),
      getBackups: () => [],
      deleteBackup: jest.fn(),
    })
    render(<PluginBackupPanel pluginId="alpha" />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders snapshot rows from getBackups", () => {
    __resetPluginBackupClientForTests({
      createBackup: jest.fn(),
      restore: jest.fn(),
      getBackups: () => [sampleBackup],
      deleteBackup: jest.fn(),
    })
    render(<PluginBackupPanel pluginId="alpha" />)
    expect(screen.getByText(/snap1234/)).toBeInTheDocument()
    expect(screen.getByText(/v1\.2\.3/)).toBeInTheDocument()
    expect(screen.getByText("reason.manual")).toBeInTheDocument()
    // Locale-formatted, not a raw ISO string.
    expect(screen.getByText("fmt:2026-05-03T12:00:00.000Z")).toBeInTheDocument()
  })

  it("create button invokes createBackup and refreshes the list", async () => {
    let listed: (typeof sampleBackup)[] = []
    const createBackup = jest.fn(async () => {
      listed = [sampleBackup]
      return { success: true, backup: sampleBackup, error: undefined }
    })
    __resetPluginBackupClientForTests({
      createBackup,
      restore: jest.fn(),
      getBackups: () => listed,
      deleteBackup: jest.fn(),
    })
    render(<PluginBackupPanel pluginId="alpha" />)
    await act(async () => {
      fireEvent.click(screen.getByText("create"))
    })
    expect(createBackup).toHaveBeenCalledWith("alpha")
    await waitFor(() => expect(screen.getByText(/snap1234/)).toBeInTheDocument())
  })

  it("surfaces createBackup error messages", async () => {
    __resetPluginBackupClientForTests({
      createBackup: async () => ({
        success: false,
        error: "disk full",
      }),
      restore: jest.fn(),
      getBackups: () => [],
      deleteBackup: jest.fn(),
    })
    render(<PluginBackupPanel pluginId="alpha" />)
    await act(async () => {
      fireEvent.click(screen.getByText("create"))
      // Allow the awaited createBackup microtask + the follow-up
      // setError + setBusy to settle inside this act block.
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText("disk full")).toBeInTheDocument()
  })

  // Restore overwrote the plugin's state and delete was permanent, each on a
  // single tap. Both confirm first now.
  it("restore + delete ask first, then call into the client", async () => {
    const restore = jest.fn(async () => undefined)
    const deleteBackup = jest.fn(async () => true)
    __resetPluginBackupClientForTests({
      createBackup: jest.fn(),
      restore,
      getBackups: () => [sampleBackup],
      deleteBackup,
    })
    render(<PluginBackupPanel pluginId="alpha" />)

    fireEvent.click(screen.getByLabelText(/^restoreAria/))
    expect(restore).not.toHaveBeenCalled()
    let confirm = await screen.findByRole("alertdialog")
    expect(confirm).toHaveTextContent("restoreConfirmTitle")
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "restore" }))
    })
    expect(restore).toHaveBeenCalledWith(sampleBackup.id)

    fireEvent.click(screen.getByLabelText(/^deleteAria/))
    confirm = await screen.findByRole("alertdialog")
    expect(confirm).toHaveTextContent("deleteConfirmTitle")
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "delete" }))
    })
    expect(deleteBackup).toHaveBeenCalledWith(sampleBackup.id)
  })

  it("cancelling the confirmation does nothing", async () => {
    const deleteBackup = jest.fn(async () => true)
    __resetPluginBackupClientForTests({
      createBackup: jest.fn(),
      restore: jest.fn(),
      getBackups: () => [sampleBackup],
      deleteBackup,
    })
    render(<PluginBackupPanel pluginId="alpha" />)
    fireEvent.click(screen.getByLabelText(/^deleteAria/))
    const confirm = await screen.findByRole("alertdialog")
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "cancel" }))
    })
    expect(deleteBackup).not.toHaveBeenCalled()
  })

  it("names each row action with the backup it acts on", () => {
    __resetPluginBackupClientForTests({
      createBackup: jest.fn(),
      restore: jest.fn(),
      getBackups: () => [sampleBackup],
      deleteBackup: jest.fn(),
    })
    render(<PluginBackupPanel pluginId="alpha" />)
    expect(
      screen.getByLabelText('restoreAria:{"version":"1.2.3","date":"fmt:2026-05-03T12:00:00.000Z"}')
    ).toHaveClass("pointer-coarse:size-9")
  })

  it("disables mutating actions and shows hint outside Tauri", () => {
    ;(isTauri as jest.Mock).mockReturnValue(false)
    __resetPluginBackupClientForTests({
      createBackup: jest.fn(),
      restore: jest.fn(),
      getBackups: () => [sampleBackup],
      deleteBackup: jest.fn(),
    })
    render(<PluginBackupPanel pluginId="alpha" />)
    expect(screen.getByText("desktopOnlyHint")).toBeInTheDocument()
    const createBtn = screen.getByLabelText("create") as HTMLButtonElement
    expect(createBtn).toBeDisabled()
  })
})
