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
  EncryptionOptions: ({
    onModeChange,
    onPassphraseChange,
  }: {
    onModeChange: (mode: string) => void
    onPassphraseChange: (value: string) => void
  }) => (
    <>
      <button type="button" onClick={() => onModeChange("plaintext")}>
        choose-plaintext
      </button>
      <button type="button" onClick={() => onModeChange("passphrase")}>
        choose-passphrase
      </button>
      <button type="button" onClick={() => onPassphraseChange("hunter2")}>
        type-passphrase
      </button>
    </>
  ),
}))
const mockToastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args), success: jest.fn() },
}))
const mockBuildBackupPackage = jest.fn()
jest.mock("@/lib/data/build-package", () => ({
  buildBackupPackage: (...args: unknown[]) => mockBuildBackupPackage(...args),
  serializePackage: (pkg: unknown) => JSON.stringify(pkg),
  defaultExportFileName: (_now: Date, mode: string) => `backup.${mode}`,
}))
const mockDefaultPassphrase = jest.fn()
jest.mock("@/lib/data/backup-key", () => ({
  rotateBackupKey: jest.fn(),
  getDefaultBackupPassphrase: () => mockDefaultPassphrase(),
}))
const mockEncrypt = jest.fn()
jest.mock("@/lib/data/crypto", () => ({
  encryptBackupPackage: (...args: unknown[]) => mockEncrypt(...args),
}))
jest.mock("@/lib/data/retrieval-key-backup", () => ({
  attachPortableRetrievalKeys: async (pkg: unknown) => pkg,
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
interface StubPayload {
  data: string
  title: string
}
jest.mock("@/components/share/share-link-dialog", () => ({
  ShareLinkDialog: ({
    open,
    buildPayload,
    artifactSummary,
  }: {
    open: boolean
    buildPayload: () => StubPayload
    artifactSummary?: React.ReactNode
  }) =>
    open ? (
      <div
        data-testid="stub-share-dialog"
        data-title={buildPayload().title}
        data-payload={buildPayload().data}
      >
        {artifactSummary}
      </div>
    ) : null,
}))
jest.mock("@/components/settings/data/webdav-sync-card", () => ({ WebDavSyncCard: () => null }))
jest.mock("@/components/settings/data/github-backup-card", () => ({ GithubBackupCard: () => null }))
jest.mock("@/components/settings/data/google-drive-backup-card", () => ({
  GoogleDriveBackupCard: () => null,
}))

function packageWith(payload: Record<string, unknown>) {
  return {
    version: "3.0",
    manifest: {
      version: "3.0",
      schemaVersion: 3,
      traceId: "trace",
      exportedAt: "2026-09-02T00:00:00.000Z",
      appVersion: "test",
      backend: "web-dexie",
      integrity: { algorithm: "SHA-256", checksum: "abc" },
    },
    payload,
  }
}

beforeEach(() => {
  mockRun.mockReset().mockResolvedValue({ ok: true, canceled: false })
  mockRequireBiometric.mockReset()
  mockToastError.mockReset()
  mockBuildBackupPackage.mockReset().mockResolvedValue(packageWith({ settings: { theme: "dark" } }))
  mockDefaultPassphrase.mockReset().mockResolvedValue(null)
  mockEncrypt.mockReset().mockImplementation(async (_plain: string, _pass: string, manifest) => ({
    version: "enc-v1",
    algorithm: "AES-GCM",
    kdf: { algorithm: "PBKDF2", hash: "SHA-256", iterations: 1, salt: "c2FsdA==" },
    iv: "aXY=",
    ciphertext: "owner@example.com",
    manifest,
    checksum: "abc",
  }))
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

describe("share link PII gate", () => {
  it("shows the hit report and only opens the share dialog after the owner confirms", async () => {
    const user = userEvent.setup()
    mockBuildBackupPackage.mockResolvedValue(
      packageWith({
        messages: [{ id: "m1", content: "write to alice@example.com" }],
        settings: { contact: "bob@example.com" },
      })
    )
    render(<BackupRestoreTab />)

    await user.click(screen.getByRole("button", { name: "choose-plaintext" }))
    await user.click(screen.getByTestId("backup-share-button"))

    expect(await screen.findByTestId("backup-share-scan-dialog")).toBeInTheDocument()
    expect(screen.getByTestId("backup-share-scan-domain-sessions")).toBeInTheDocument()
    expect(screen.getByTestId("backup-share-scan-domain-settings")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-share-dialog")).toBeNull()

    const cont = screen.getByTestId("backup-share-scan-continue")
    expect(cont).toBeDisabled()
    await user.click(screen.getByTestId("backup-share-scan-confirm"))
    await user.click(cont)

    const dialog = await screen.findByTestId("stub-share-dialog")
    expect(dialog.getAttribute("data-title")).toBe("backup.plain")
    expect(dialog.getAttribute("data-payload")).toContain("alice@example.com")
    expect(screen.queryByTestId("backup-share-scan-dialog")).toBeNull()
  })

  it("cancelling the report never opens the share dialog", async () => {
    const user = userEvent.setup()
    mockBuildBackupPackage.mockResolvedValue(
      packageWith({ messages: [{ id: "m1", content: "alice@example.com" }] })
    )
    render(<BackupRestoreTab />)

    await user.click(screen.getByRole("button", { name: "choose-plaintext" }))
    await user.click(screen.getByTestId("backup-share-button"))
    await screen.findByTestId("backup-share-scan-dialog")
    await user.click(screen.getByTestId("backup-share-scan-cancel"))

    expect(screen.queryByTestId("stub-share-dialog")).toBeNull()
  })

  it("opens the share dialog directly with a quiet note when nothing is found", async () => {
    const user = userEvent.setup()
    render(<BackupRestoreTab />)

    await user.click(screen.getByRole("button", { name: "choose-plaintext" }))
    await user.click(screen.getByTestId("backup-share-button"))

    const dialog = await screen.findByTestId("stub-share-dialog")
    expect(screen.queryByTestId("backup-share-scan-dialog")).toBeNull()
    expect(screen.getByTestId("backup-share-note-clean").textContent).toBe("backup.shareScan.clean")
    expect(dialog.getAttribute("data-payload")).toContain('"theme":"dark"')
  })

  it("shares an encrypted envelope under passphrase mode and explains it cannot be scanned", async () => {
    const user = userEvent.setup()
    mockBuildBackupPackage.mockResolvedValue(
      packageWith({ messages: [{ id: "m1", content: "alice@example.com" }] })
    )
    render(<BackupRestoreTab />)

    await user.click(screen.getByRole("button", { name: "choose-passphrase" }))
    await user.click(screen.getByRole("button", { name: "type-passphrase" }))
    await user.click(screen.getByTestId("backup-share-button"))

    const dialog = await screen.findByTestId("stub-share-dialog")
    expect(mockEncrypt).toHaveBeenCalledWith(
      expect.stringContaining("alice@example.com"),
      "hunter2",
      expect.objectContaining({ encryption: { enabled: true, format: "encrypted-envelope-v1" } })
    )
    expect(dialog.getAttribute("data-title")).toBe("backup.encrypted")
    expect(dialog.getAttribute("data-payload")).toContain('"version": "enc-v1"')
    expect(screen.getByTestId("backup-share-note-encrypted").textContent).toBe(
      "backup.shareScan.encrypted"
    )
    expect(screen.queryByTestId("backup-share-scan-dialog")).toBeNull()
  })

  it("refuses passphrase mode without a passphrase", async () => {
    const user = userEvent.setup()
    render(<BackupRestoreTab />)

    await user.click(screen.getByRole("button", { name: "choose-passphrase" }))
    await user.click(screen.getByTestId("backup-share-button"))

    expect(mockToastError).toHaveBeenCalledWith("backup.passphraseRequired")
    expect(mockBuildBackupPackage).not.toHaveBeenCalled()
    expect(screen.queryByTestId("stub-share-dialog")).toBeNull()
  })

  it("refuses auto-key mode when the runtime has no key", async () => {
    const user = userEvent.setup()
    render(<BackupRestoreTab />)

    await user.click(screen.getByTestId("backup-share-button"))

    expect(mockToastError).toHaveBeenCalledWith("backup.shareScan.keyUnavailable")
    expect(mockBuildBackupPackage).not.toHaveBeenCalled()
  })
})
