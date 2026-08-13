import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BackupRestoreTab } from "./backup-restore-tab"

const mockRun = jest.fn()
const mockRequireBiometric = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/hooks/data/use-full-backup", () => ({
  useFullBackup: () => ({ run: mockRun, busy: false }),
}))
jest.mock("@/hooks/scheduler", () => ({ useScheduler: () => ({ tasks: [] }) }))
jest.mock("@/lib/biometric/prompt", () => ({
  requireBiometric: (options: unknown) => mockRequireBiometric(options),
}))
jest.mock("@/components/data/shared/encryption-options", () => ({
  EncryptionOptions: ({ onModeChange }: { onModeChange: (mode: string) => void }) => (
    <button type="button" onClick={() => onModeChange("plaintext")}>
      choose-plaintext
    </button>
  ),
}))
jest.mock("@/components/data/import/full-restore-dialog", () => ({ FullRestoreDialog: () => null }))
jest.mock("@/components/data/export/batch-export-dialog", () => ({
  BatchExportDialog: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}))
jest.mock("@/components/data/export/schedule-card", () => ({ ScheduleCard: () => null }))
jest.mock("@/components/scheduler/backup-schedule-dialog", () => ({
  BackupScheduleDialog: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}))
jest.mock("@/components/share/share-settings-card", () => ({ ShareSettingsCard: () => null }))
jest.mock("@/components/share/share-link-dialog", () => ({
  ShareLinkDialog: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}))
jest.mock("@/components/settings/data/webdav-sync-card", () => ({ WebDavSyncCard: () => null }))

beforeEach(() => {
  mockRun.mockReset().mockResolvedValue({ ok: true, canceled: false })
  mockRequireBiometric.mockReset()
})

it("requires an explicit warning confirmation before plaintext backup", async () => {
  const user = userEvent.setup()
  mockRequireBiometric.mockResolvedValue({
    ok: true,
    bioVerified: false,
    via: "browser-confirm",
  })
  render(<BackupRestoreTab />)

  await user.click(screen.getByRole("button", { name: "choose-plaintext" }))
  await user.click(screen.getByRole("button", { name: "exportButton" }))

  expect(mockRequireBiometric).toHaveBeenCalledWith({
    title: "backup.plaintextConfirmTitle",
    message: "backup.plaintextConfirmBody",
    confirmLabel: "backup.plaintextConfirmAction",
    cancelLabel: "cancel",
  })
  expect(mockRun).toHaveBeenCalledWith(
    expect.objectContaining({ encryption: "plaintext", plaintextConfirmed: true })
  )
})

it("does not start plaintext backup when the user cancels", async () => {
  const user = userEvent.setup()
  mockRequireBiometric.mockResolvedValue({
    ok: false,
    bioVerified: false,
    via: "browser-confirm",
  })
  render(<BackupRestoreTab />)

  await user.click(screen.getByRole("button", { name: "choose-plaintext" }))
  await user.click(screen.getByRole("button", { name: "exportButton" }))

  expect(mockRun).not.toHaveBeenCalled()
})
