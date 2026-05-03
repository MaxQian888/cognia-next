/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

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
    expect(screen.getByText("manual")).toBeInTheDocument()
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

  it("restore + delete buttons call into the client", async () => {
    const restore = jest.fn(async () => undefined)
    const deleteBackup = jest.fn(async () => true)
    __resetPluginBackupClientForTests({
      createBackup: jest.fn(),
      restore,
      getBackups: () => [sampleBackup],
      deleteBackup,
    })
    render(<PluginBackupPanel pluginId="alpha" />)
    const restoreBtn = screen.getByLabelText("restore")
    const deleteBtn = screen.getByLabelText("delete")
    await act(async () => {
      fireEvent.click(restoreBtn)
    })
    await act(async () => {
      fireEvent.click(deleteBtn)
    })
    expect(restore).toHaveBeenCalledWith(sampleBackup.id)
    expect(deleteBackup).toHaveBeenCalledWith(sampleBackup.id)
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
