/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"
import { BackupDetail } from "./backup-detail"

const getSettings = jest.fn()
const mockRuns: UnifiedExecutionRun[] = []

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/db/settings", () => ({ getSettings: () => getSettings() }))
jest.mock("@/hooks/scheduler/use-unified-recent-runs", () => ({
  useUnifiedRecentRuns: () => ({ runs: mockRuns }),
}))
jest.mock("../backup-schedule-dialog", () => ({
  BackupScheduleDialog: () => <button type="button">backup settings</button>,
}))

describe("BackupDetail", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRuns.length = 0
    getSettings.mockResolvedValue({
      backupAutoSchedule: {
        enabled: true,
        intervalDays: 2,
        retainCount: 4,
        dirPath: "/tmp/backups",
      },
    })
  })

  it("renders settings and dispatches a selected run from a shadcn button", async () => {
    const onSelectRun = jest.fn()
    const run = {
      unifiedId: "backup:run-1",
      kind: "backup",
      itemName: "Backup",
      status: "succeeded",
      startedAt: "2026-08-10T01:00:00.000Z",
      origin: { nativeId: "run-1" },
    } as UnifiedExecutionRun
    mockRuns.push(run)

    render(<BackupDetail onSelectRun={onSelectRun} />)

    await waitFor(() => expect(screen.getByText("/tmp/backups")).toBeInTheDocument())
    const row = screen.getByTestId("backup-run-run-1")
    expect(row).toHaveAttribute("data-slot", "button")
    fireEvent.click(row)
    expect(onSelectRun).toHaveBeenCalledWith(run)
  })
})
