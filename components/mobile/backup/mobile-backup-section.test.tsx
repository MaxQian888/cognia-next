/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// The component now delegates the platform write + feedback to the unified
// saver; mock those seams (their internals are covered by save-export.test.ts
// and export-feedback.test.ts). `mockSaveExport` stands in for "the export
// write ran".
const mockSaveExport = jest.fn()
const mockNotify = jest.fn()
const mockBuildBackupPackage = jest.fn()
const mockEncryptBackupPackage = jest.fn()
const mockDecryptBackupPackage = jest.fn()
const mockApplyBackupPackage = jest.fn()
const mockMigrateEnvelope = jest.fn()

jest.mock("@/lib/files/save-export", () => ({
  saveExport: (...args: unknown[]) => mockSaveExport(...args),
}))

jest.mock("@/lib/files/export-feedback", () => ({
  notifyExportOutcome: (...args: unknown[]) => mockNotify(...args),
}))

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}))

jest.mock("@/lib/data/build-package", () => ({
  buildBackupPackage: (...args: unknown[]) => mockBuildBackupPackage(...args),
}))

jest.mock("@/lib/data/crypto", () => ({
  encryptBackupPackage: (...args: unknown[]) => mockEncryptBackupPackage(...args),
  decryptBackupPackage: (...args: unknown[]) => mockDecryptBackupPackage(...args),
}))

jest.mock("@/lib/data/apply-package", () => ({
  applyBackupPackage: (...args: unknown[]) => mockApplyBackupPackage(...args),
}))

jest.mock("@/lib/data/migrate", () => ({
  migrateEnvelope: (...args: unknown[]) => mockMigrateEnvelope(...args),
  // Mirror the real structural sniff (lib/data/migrate.ts:isEncryptedEnvelope)
  // — the import path branches on it. Inlined rather than requireActual'd:
  // spreading the actual module's interop exports proved unreliable here.
  isEncryptedEnvelope: (input: unknown) => {
    if (!input || typeof input !== "object") return false
    const obj = input as { version?: unknown; ciphertext?: unknown; kdf?: unknown }
    return (
      obj.version === "enc-v1" &&
      typeof obj.ciphertext === "string" &&
      !!obj.kdf &&
      typeof obj.kdf === "object"
    )
  },
}))

jest.mock("@/lib/db/backup-history", () => ({
  listBackupHistory: jest.fn(async () => []),
}))

// The WebDAV card has its own suite; stub it here so this section test stays
// focused on export/import/auto/history.
jest.mock("@/components/settings/data/webdav-sync-card", () => ({
  WebDavSyncCard: () => <div data-testid="webdav-sync-card" />,
}))

jest.mock("@/lib/capacitor/local-notifications", () => ({
  ensureChannel: jest.fn(),
  schedule: jest.fn(),
}))

jest.mock("@/lib/capacitor/_shared", () => ({
  // Preserve the real exports (makeDefaultLoader, withPlugin, …) — they're
  // pulled in at module-init time through companion-storage.ts via the
  // lib/utils → lib/tauri chain. Only detectNativePlatform is stubbed.
  ...jest.requireActual("@/lib/capacitor/_shared"),
  detectNativePlatform: jest.fn().mockReturnValue("mobile"),
}))

jest.mock("@/hooks/use-biometric-guard", () => ({
  useBiometricGuard: jest.fn().mockReturnValue(
    jest.fn(async (_gate: unknown, action: () => Promise<unknown>) => {
      const value = await action()
      return { kind: "ok" as const, value }
    })
  ),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: jest.fn((selector: (s: unknown) => unknown) =>
    selector({
      settings: {
        biometricRequiredFor: { exportBackup: false },
      },
    })
  ),
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn().mockReturnValue([]),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      title: "Backup & sync",
      description: "Export all local data encrypted to this device.",
      exportNow: "Back up now",
      exporting: "Packaging…",
      exportSuccess: `Written to ${(vars?.path as string) ?? ""}`,
      exportFailed: `Backup failed: ${(vars?.message as string) ?? ""}`,
      shareFile: "Share file",
      shareTitle: "Cognia Backup",
      importPick: "Import backup file",
      importStrategy: "Merge strategy",
      strategySkip: "Keep local",
      strategyOverwrite: "Overwrite",
      strategyDuplicate: "Duplicate",
      importing: "Restoring…",
      importSuccess: "Restore complete",
      importFailed: `Restore failed: ${(vars?.message as string) ?? ""}`,
      importPassphraseRequired: "Enter the backup passphrase before importing",
      importWrongPassphrase: "Wrong passphrase",
      autoBackup: "Auto backup",
      autoBackupHint: "Back up automatically.",
      autoBackupInterval: "Interval (days)",
      historyHeader: "History",
      historyEmpty: "No history yet.",
      historyFailedLabel: "Failed",
      passphraseLabel: "Passphrase",
      exportBiometricTitle: "Confirm export",
      exportBiometricReason: "Authenticate to export.",
      biometricBlocked: "Biometric failed.",
      passphraseRequiredHint: "Required.",
      webModeNote: "Web mode note.",
    }
    return map[key] ?? key
  },
}))

import { toast } from "sonner"
import { MobileBackupSection } from "./mobile-backup-section"

const mockToastSuccess = toast.success as jest.Mock
const mockToastError = toast.error as jest.Mock

const useSettingsStoreMock = jest.requireMock("@/stores/settings").useSettingsStore
const useBiometricGuardMock = jest.requireMock("@/hooks/use-biometric-guard").useBiometricGuard
const useLiveQueryMock = jest.requireMock("dexie-react-hooks").useLiveQuery
const detectNativePlatformMock = jest.requireMock("@/lib/capacitor/_shared").detectNativePlatform

describe("<MobileBackupSection />", () => {
  const origCreateObjectURL = globalThis.URL.createObjectURL
  const origRevokeObjectURL = globalThis.URL.revokeObjectURL
  const origFileText = (File.prototype as { text?: unknown }).text

  beforeAll(() => {
    globalThis.URL.createObjectURL = jest.fn(() => "blob:test")
    globalThis.URL.revokeObjectURL = jest.fn()
    Object.defineProperty(File.prototype, "text", {
      value: jest.fn().mockResolvedValue("{}"),
      writable: true,
      configurable: true,
    })
  })

  afterAll(() => {
    globalThis.URL.createObjectURL = origCreateObjectURL
    globalThis.URL.revokeObjectURL = origRevokeObjectURL
    if (origFileText !== undefined) {
      Object.defineProperty(File.prototype, "text", {
        value: origFileText,
        writable: true,
        configurable: true,
      })
    } else {
      delete (File.prototype as { text?: unknown }).text
    }
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockBuildBackupPackage.mockResolvedValue({ manifest: { version: "test" } })
    mockEncryptBackupPackage.mockResolvedValue({})

    // Reset mocks to default state
    useSettingsStoreMock.mockImplementation((selector: (s: unknown) => unknown) =>
      selector({
        settings: {
          biometricRequiredFor: { exportBackup: false },
        },
      })
    )
    useBiometricGuardMock.mockReturnValue(
      jest.fn(async (_gate: unknown, action: () => Promise<unknown>) => {
        const value = await action()
        return { kind: "ok" as const, value }
      })
    )
    useLiveQueryMock.mockReturnValue([])
    detectNativePlatformMock.mockReturnValue("mobile")
  })

  describe("export flow", () => {
    it("delegates the encrypted backup to saveExport and reports the outcome", async () => {
      const outcome = {
        kind: "saved" as const,
        platform: "mobile" as const,
        location: "file://documents/cognia/backups/test.cog.bak",
        uri: "file://documents/cognia/backups/test.cog.bak",
        filename: "test.cog.bak",
      }
      mockSaveExport.mockResolvedValue(outcome)

      render(<MobileBackupSection />)

      fireEvent.change(screen.getByTestId("backup-passphrase"), {
        target: { value: "password123" },
      })
      fireEvent.click(screen.getByTestId("backup-export"))

      await waitFor(() => {
        expect(mockSaveExport).toHaveBeenCalledTimes(1)
      })

      // Backup goes to the dedicated backups subdir as an opaque binary blob.
      const arg = mockSaveExport.mock.calls[0][0] as {
        filename: string
        mimeType: string
        mobileSubdir: string
      }
      expect(arg.mobileSubdir).toBe("cognia/backups")
      expect(arg.mimeType).toBe("application/octet-stream")
      expect(arg.filename).toMatch(/\.cog\.bak$/)

      // Feedback (location toast + share action) is delegated to notifyExportOutcome.
      expect(mockNotify).toHaveBeenCalledWith(
        outcome,
        expect.objectContaining({ shareTitle: "Cognia Backup" })
      )
    })

    it("still notifies (web download path) when saveExport falls back to web", async () => {
      const outcome = {
        kind: "saved" as const,
        platform: "web" as const,
        location: "downloads",
        filename: "test.cog.bak",
      }
      mockSaveExport.mockResolvedValue(outcome)

      render(<MobileBackupSection />)

      fireEvent.change(screen.getByTestId("backup-passphrase"), {
        target: { value: "password123" },
      })
      fireEvent.click(screen.getByTestId("backup-export"))

      await waitFor(() => {
        expect(mockNotify).toHaveBeenCalledWith(outcome, expect.anything())
      })
    })

    it("disables the export button when passphrase is too short", () => {
      render(<MobileBackupSection />)
      const button = screen.getByTestId("backup-export")
      expect(button).toBeDisabled()
    })

    it("enables the export button once passphrase meets minimum length", () => {
      render(<MobileBackupSection />)
      fireEvent.change(screen.getByTestId("backup-passphrase"), {
        target: { value: "password123" },
      })
      expect(screen.getByTestId("backup-export")).not.toBeDisabled()
    })
  })

  describe("import flow", () => {
    it("shows success toast after importing a valid backup file", async () => {
      mockMigrateEnvelope.mockResolvedValue({})
      mockApplyBackupPackage.mockResolvedValue(undefined)

      render(<MobileBackupSection />)

      const file = new File(["{}"], "test.cog.bak", { type: "application/octet-stream" })
      const input = screen.getByTestId("backup-import-input")

      await userEvent.upload(input, file)

      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith("Restore complete")
      })
    })

    it("shows error toast when import fails", async () => {
      mockMigrateEnvelope.mockRejectedValue(new Error("Corrupted file"))

      render(<MobileBackupSection />)

      const file = new File(["bad"], "test.cog.bak", { type: "application/octet-stream" })
      const input = screen.getByTestId("backup-import-input")

      await userEvent.upload(input, file)

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(
          "Restore failed: Corrupted file"
        )
      })
    })

    // jsdom's File/Blob text() is unreliable in this environment (it returns
    // constant content regardless of the blob parts), so the encrypted-import
    // tests dispatch the change event with a minimal file stub exposing the
    // one member the handler reads: text().
    const uploadStub = (content: string) => {
      const input = screen.getByTestId("backup-import-input")
      fireEvent.change(input, {
        target: { files: [{ text: async () => content }] },
      })
    }
    const encryptedEnvelopeJson = JSON.stringify({
      version: "enc-v1",
      ciphertext: "abc",
      kdf: { salt: "s" },
    })

    it("decrypts an encrypted envelope with the passphrase field before applying", async () => {
      // Mobile exports are always encrypted; the import path must round-trip
      // them (this exact flow used to throw IsEncryptedError unconditionally).
      mockDecryptBackupPackage.mockResolvedValue(JSON.stringify({ decrypted: true }))
      mockMigrateEnvelope.mockResolvedValue({})
      mockApplyBackupPackage.mockResolvedValue(undefined)

      render(<MobileBackupSection />)
      await userEvent.type(screen.getByTestId("backup-passphrase"), "hunter2-passphrase")
      uploadStub(encryptedEnvelopeJson)

      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith("Restore complete")
      })
      expect(mockDecryptBackupPackage).toHaveBeenCalledWith(
        expect.objectContaining({ version: "enc-v1" }),
        "hunter2-passphrase"
      )
      expect(mockMigrateEnvelope).toHaveBeenCalledWith({ decrypted: true })
    })

    it("refuses to import an encrypted envelope without a valid passphrase", async () => {
      render(<MobileBackupSection />)
      uploadStub(encryptedEnvelopeJson)

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith("Enter the backup passphrase before importing")
      })
      expect(mockDecryptBackupPackage).not.toHaveBeenCalled()
      expect(mockApplyBackupPackage).not.toHaveBeenCalled()
    })

    it("maps a wrong-passphrase OperationError to actionable copy", async () => {
      const opError = new Error("The operation failed")
      opError.name = "OperationError"
      mockDecryptBackupPackage.mockRejectedValue(opError)

      render(<MobileBackupSection />)
      await userEvent.type(screen.getByTestId("backup-passphrase"), "wrong-passphrase")
      uploadStub(encryptedEnvelopeJson)

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith("Wrong passphrase")
      })
      expect(mockApplyBackupPackage).not.toHaveBeenCalled()
    })

    it("shows error toast with stringified non-Error throw", async () => {
      mockMigrateEnvelope.mockRejectedValue("plain string error")

      render(<MobileBackupSection />)

      const file = new File(["bad"], "test.cog.bak", { type: "application/octet-stream" })
      const input = screen.getByTestId("backup-import-input")

      await userEvent.upload(input, file)

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith(
          "Restore failed: plain string error"
        )
      })
    })

    it("ignores import when already importing", async () => {
      mockMigrateEnvelope.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 500))
      )
      mockApplyBackupPackage.mockResolvedValue(undefined)

      render(<MobileBackupSection />)

      const file = new File(["{}"], "test.cog.bak", { type: "application/octet-stream" })
      const input = screen.getByTestId("backup-import-input")

      // First upload starts importing
      await userEvent.upload(input, file)

      // Second upload while importing should be ignored
      const file2 = new File(["{}"], "test2.cog.bak", { type: "application/octet-stream" })
      await userEvent.upload(input, file2)

      // Should still succeed once, not twice
      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe("biometric guard", () => {
    it("shows biometric blocked toast when guard returns blocked", async () => {
      mockSaveExport.mockResolvedValue({
        kind: "ok" as const,
        value: { uri: "file://test" },
      })
      useSettingsStoreMock.mockImplementation((selector: (s: unknown) => unknown) =>
        selector({
          settings: {
            biometricRequiredFor: { exportBackup: true },
          },
        })
      )
      useBiometricGuardMock.mockReturnValue(
        jest.fn(async () => ({ kind: "blocked" as const, reason: "unavailable" }))
      )

      render(<MobileBackupSection />)

      fireEvent.change(screen.getByTestId("backup-passphrase"), {
        target: { value: "password123" },
      })
      fireEvent.click(screen.getByTestId("backup-export"))

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith("Biometric failed.")
      })
    })

    it("passes through biometric guard when cancelled", async () => {
      useSettingsStoreMock.mockImplementation((selector: (s: unknown) => unknown) =>
        selector({
          settings: {
            biometricRequiredFor: { exportBackup: true },
          },
        })
      )
      useBiometricGuardMock.mockReturnValue(
        jest.fn(async () => ({ kind: "blocked" as const, reason: "cancelled" }))
      )

      render(<MobileBackupSection />)

      fireEvent.change(screen.getByTestId("backup-passphrase"), {
        target: { value: "password123" },
      })
      fireEvent.click(screen.getByTestId("backup-export"))

      // Give time for the async onExport to settle
      await waitFor(() => {
        expect(screen.getByTestId("backup-export")).not.toBeDisabled()
      })

      // cancelled should NOT trigger toast.error for biometric blocked
      expect(mockToastError).not.toHaveBeenCalledWith("Biometric failed.")
      // runExport should NOT have been called
      expect(mockSaveExport).not.toHaveBeenCalled()
    })
  })

  describe("web mode", () => {
    it("shows web mode note when not on mobile", () => {
      detectNativePlatformMock.mockReturnValue("web")
      render(<MobileBackupSection />)
      expect(screen.getByText("Web mode note.")).toBeInTheDocument()
    })

    it("does not show web mode note on mobile", () => {
      detectNativePlatformMock.mockReturnValue("mobile")
      render(<MobileBackupSection />)
      expect(screen.queryByText("Web mode note.")).not.toBeInTheDocument()
    })
  })

  describe("history rendering", () => {
    it("renders history items when data exists", () => {
      useLiveQueryMock.mockReturnValue([
        { id: 1, completedAt: Date.now(), success: true },
        { id: 2, completedAt: Date.now(), success: false, errorMessage: "Disk full" },
      ])
      render(<MobileBackupSection />)

      expect(screen.getByTestId("backup-history-1")).toBeInTheDocument()
      expect(screen.getByTestId("backup-history-2")).toBeInTheDocument()
    })

    it("shows failed badge for unsuccessful history entries", () => {
      useLiveQueryMock.mockReturnValue([
        { id: 1, completedAt: Date.now(), success: false, errorMessage: "Disk full" },
      ])
      render(<MobileBackupSection />)

      expect(screen.getByTestId("backup-history-1")).toHaveTextContent("Disk full")
    })

    it("shows default failed label when error message is absent", () => {
      useLiveQueryMock.mockReturnValue([
        { id: 1, completedAt: Date.now(), success: false },
      ])
      render(<MobileBackupSection />)

      expect(screen.getByTestId("backup-history-1")).toHaveTextContent("Failed")
    })
  })

  describe("auto backup", () => {
    it("shows interval input when auto backup is enabled", async () => {
      render(<MobileBackupSection />)

      const toggle = screen.getByTestId("backup-auto-toggle")
      await userEvent.click(toggle)

      expect(screen.getByTestId("backup-auto-interval")).toBeInTheDocument()
    })

    it("hides interval input when auto backup is disabled", async () => {
      render(<MobileBackupSection />)

      const toggle = screen.getByTestId("backup-auto-toggle")
      await userEvent.click(toggle)
      expect(screen.getByTestId("backup-auto-interval")).toBeInTheDocument()

      await userEvent.click(toggle)
      expect(screen.queryByTestId("backup-auto-interval")).not.toBeInTheDocument()
    })

    it("fires auto-backup useEffect when enabled with valid passphrase", async () => {
      jest.useFakeTimers()
      mockSaveExport.mockResolvedValue({
        kind: "ok" as const,
        value: { uri: "file://test" },
      })

      render(<MobileBackupSection />)

      fireEvent.change(screen.getByTestId("backup-passphrase"), {
        target: { value: "password123" },
      })

      const toggle = screen.getByTestId("backup-auto-toggle")
      fireEvent.click(toggle)

      // The useEffect sets up an interval; advance timers to trigger it.
      jest.advanceTimersByTime(24 * 60 * 60 * 1000 + 100)

      await waitFor(() => {
        expect(mockSaveExport).toHaveBeenCalled()
      })

      jest.useRealTimers()
    })

    it("respects last success time when checking overdue backup", async () => {
      jest.useFakeTimers()
      mockSaveExport.mockResolvedValue({
        kind: "ok" as const,
        value: { uri: "file://test" },
      })
      useLiveQueryMock.mockReturnValue([
        { id: 1, completedAt: Date.now(), success: true },
      ])

      render(<MobileBackupSection />)

      fireEvent.change(screen.getByTestId("backup-passphrase"), {
        target: { value: "password123" },
      })

      const toggle = screen.getByTestId("backup-auto-toggle")
      fireEvent.click(toggle)

      // With a recent success, the due date is in the future,
      // so advancing one day should still not trigger export
      // (since lastSuccessAt + intervalDays * MS_PER_DAY > now).
      jest.advanceTimersByTime(24 * 60 * 60 * 1000 - 1000)

      // Export should NOT be called because it's not yet overdue
      expect(mockSaveExport).not.toHaveBeenCalled()

      jest.useRealTimers()
    })
  })

  describe("error handling", () => {
    it("shows export failed toast when runExport throws", async () => {
      mockBuildBackupPackage.mockRejectedValue(new Error("Build failed"))

      render(<MobileBackupSection />)

      fireEvent.change(screen.getByTestId("backup-passphrase"), {
        target: { value: "password123" },
      })
      fireEvent.click(screen.getByTestId("backup-export"))

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith("Backup failed: Build failed")
      })
    })
  })

  describe("edge cases", () => {
    it("ignores second click while export is in progress", async () => {
      // Make writeFile hang so exporting stays true
      const resolver: { resolve: ((v: unknown) => void) | null } = { resolve: null }
      mockSaveExport.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolver.resolve = resolve
          })
      )

      render(<MobileBackupSection />)

      fireEvent.change(screen.getByTestId("backup-passphrase"), {
        target: { value: "password123" },
      })

      // First click starts export
      fireEvent.click(screen.getByTestId("backup-export"))

      await waitFor(() => {
        expect(mockSaveExport).toHaveBeenCalledTimes(1)
      })

      // Second click while still exporting should bail out early
      fireEvent.click(screen.getByTestId("backup-export"))

      // Resolve the hanging saveExport inside act
      await waitFor(async () => {
        expect(resolver.resolve).not.toBeNull()
        resolver.resolve!({
          kind: "saved" as const,
          platform: "mobile" as const,
          location: "file://test",
          uri: "file://test",
          filename: "x.cog.bak",
        })
      })

      await waitFor(() => {
        expect(mockNotify).toHaveBeenCalledTimes(1)
      })

      // saveExport should only be called once (second click was ignored)
      expect(mockSaveExport).toHaveBeenCalledTimes(1)
    })

    it("cancels auto-backup interval on unmount", async () => {
      jest.useFakeTimers()
      mockSaveExport.mockResolvedValue({
        kind: "ok" as const,
        value: { uri: "file://test" },
      })

      const { unmount } = render(<MobileBackupSection />)

      fireEvent.change(screen.getByTestId("backup-passphrase"), {
        target: { value: "password123" },
      })

      fireEvent.click(screen.getByTestId("backup-auto-toggle"))

      // Unmount before interval fires
      unmount()

      // Advance timers — should not throw and writeFile should not be called
      jest.advanceTimersByTime(24 * 60 * 60 * 1000 + 100)
      expect(mockSaveExport).not.toHaveBeenCalled()

      jest.useRealTimers()
    })

    it("does not fire auto-backup when intervalDays is zero or negative", async () => {
      jest.useFakeTimers()
      mockSaveExport.mockResolvedValue({
        kind: "ok" as const,
        value: { uri: "file://test" },
      })

      render(<MobileBackupSection />)

      fireEvent.change(screen.getByTestId("backup-passphrase"), {
        target: { value: "password123" },
      })

      fireEvent.click(screen.getByTestId("backup-auto-toggle"))

      // Change interval to 0
      const intervalInput = screen.getByTestId("backup-auto-interval")
      fireEvent.change(intervalInput, { target: { value: "0" } })

      jest.advanceTimersByTime(24 * 60 * 60 * 1000 + 100)
      expect(mockSaveExport).not.toHaveBeenCalled()

      jest.useRealTimers()
    })
  })

  describe("lifecycle", () => {
    it("unmounts cleanly without errors", () => {
      const { unmount } = render(<MobileBackupSection />)
      expect(() => unmount()).not.toThrow()
    })
  })
})
