/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

interface SettingsState {
  settings: {
    backupReminderDays?: number
    backupReminderDismissedAt?: number
  } | null
  save: jest.Mock
}
const settingsState: SettingsState = {
  settings: { backupReminderDays: 7 },
  save: jest.fn(async () => undefined),
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T>(selector: (s: SettingsState) => T): T => selector(settingsState),
}))

const latestBackupRef: { current: { completedAt: number } | undefined } = {
  current: undefined,
}
jest.mock("./use-backup-history", () => ({
  useLatestSuccessfulBackup: () => latestBackupRef.current,
}))

const shouldShowMock = jest.fn()
jest.mock("@/lib/data/scheduler", () => ({
  shouldShowReminder: (...args: unknown[]) => shouldShowMock(...args),
}))

import { useBackupReminder } from "./use-backup-reminder"

beforeEach(() => {
  settingsState.settings = { backupReminderDays: 7 }
  settingsState.save.mockClear().mockResolvedValue(undefined)
  latestBackupRef.current = undefined
  shouldShowMock.mockReset()
})

describe("useBackupReminder", () => {
  it("forwards settings + latest backup to shouldShowReminder", () => {
    settingsState.settings = {
      backupReminderDays: 14,
      backupReminderDismissedAt: 100,
    }
    latestBackupRef.current = { completedAt: 200 }
    shouldShowMock.mockReturnValue(true)
    const { result } = renderHook(() => useBackupReminder())
    expect(shouldShowMock).toHaveBeenCalledWith({
      reminderDays: 14,
      lastSuccessAt: 200,
      dismissedAt: 100,
    })
    expect(result.current.visible).toBe(true)
  })

  it("dismiss persists the timestamp via settings.save", () => {
    shouldShowMock.mockReturnValue(true)
    const { result } = renderHook(() => useBackupReminder())
    const before = Date.now()
    act(() => result.current.dismiss())
    const lastCall = settingsState.save.mock.calls[0][0] as {
      backupReminderDismissedAt: number
    }
    expect(lastCall.backupReminderDismissedAt).toBeGreaterThanOrEqual(before)
  })
})
