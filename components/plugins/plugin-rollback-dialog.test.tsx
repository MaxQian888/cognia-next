/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars) return `${key}(${JSON.stringify(vars)})`
    return key
  },
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

import { PluginRollbackDialog, __resetPluginRollbackClientForTests } from "./plugin-rollback-dialog"
import { isTauri } from "@/lib/tauri"

beforeEach(() => {
  __resetPluginRollbackClientForTests(null)
  ;(isTauri as jest.Mock).mockReturnValue(true)
})

const sampleInfo = {
  pluginId: "alpha",
  currentVersion: "1.2.0",
  hasBackups: true,
  availableVersions: [
    {
      version: "1.0.0",
      source: "backup" as const,
      date: new Date("2026-04-01T00:00:00.000Z"),
      size: 100,
      canRollback: true,
      reason: "before update",
    },
  ],
  lastBackup: undefined,
}

describe("PluginRollbackDialog", () => {
  it("shows empty hint when there are no snapshots", async () => {
    __resetPluginRollbackClientForTests({
      getRollbackInfo: async () => ({
        pluginId: "alpha",
        currentVersion: "1.0.0",
        availableVersions: [],
        hasBackups: false,
      }),
      rollback: async () => ({
        success: true,
        pluginId: "alpha",
        fromVersion: "",
        toVersion: "",
        duration: 0,
        migrationApplied: false,
        requiresRestart: false,
      }),
    })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("empty")).toBeInTheDocument())
  })

  it("renders version rows and triggers rollback on click", async () => {
    const rollback = jest.fn(async () => ({
      success: true,
      pluginId: "alpha",
      fromVersion: "1.2.0",
      toVersion: "1.0.0",
      duration: 1,
      migrationApplied: false,
      requiresRestart: false,
    }))
    const onClose = jest.fn()
    __resetPluginRollbackClientForTests({
      getRollbackInfo: async () => sampleInfo,
      rollback,
    })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={onClose} />)
    await waitFor(() => expect(screen.getByText(/v1\.0\.0/)).toBeInTheDocument())
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/rollbackAria.*1\.0\.0/))
    })
    expect(rollback).toHaveBeenCalledWith("alpha", "1.0.0")
    expect(onClose).toHaveBeenCalled()
  })

  it("surfaces a non-success result error", async () => {
    __resetPluginRollbackClientForTests({
      getRollbackInfo: async () => sampleInfo,
      rollback: async () => ({
        success: false,
        pluginId: "alpha",
        fromVersion: "1.2.0",
        toVersion: "1.0.0",
        duration: 0,
        migrationApplied: false,
        requiresRestart: false,
        error: "lockfile mismatch",
      }),
    })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/v1\.0\.0/)).toBeInTheDocument())
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/rollbackAria.*1\.0\.0/))
    })
    await waitFor(() => expect(screen.getByText("lockfile mismatch")).toBeInTheDocument())
  })

  it("warns when no version is rollback-able", async () => {
    __resetPluginRollbackClientForTests({
      getRollbackInfo: async () => ({
        pluginId: "alpha",
        currentVersion: "1.0.0",
        hasBackups: true,
        availableVersions: [
          {
            version: "0.9.0",
            source: "backup" as const,
            date: undefined,
            size: 0,
            canRollback: false,
            reason: "missing migration",
          },
        ],
      }),
      rollback: jest.fn(),
    })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("canNotRollback")).toBeInTheDocument())
  })

  it("disables actions and shows hint when not in Tauri", async () => {
    ;(isTauri as jest.Mock).mockReturnValue(false)
    __resetPluginRollbackClientForTests({
      getRollbackInfo: async () => sampleInfo,
      rollback: jest.fn(),
    })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={() => {}} />)
    expect(await screen.findByText("desktopOnlyHint")).toBeInTheDocument()
    // Wait for the async getRollbackInfo to resolve so the version list mounts.
    const button = (await screen.findByLabelText(/rollbackAria.*1\.0\.0/)) as HTMLButtonElement
    expect(button).toBeDisabled()
  })
})
