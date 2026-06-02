/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    return key
  },
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

const decryptMock = jest.fn()
const encryptMock = jest.fn()
const buildPackageMock = jest.fn()

jest.mock("@/lib/subscription/core/encrypted-package", () => {
  class FakePassphraseError extends Error {
    constructor() {
      super("wrong passphrase")
      this.name = "SubscriptionPassphraseError"
    }
  }
  return {
    buildSubscriptionPackage: (...args: unknown[]) => buildPackageMock(...args),
    encryptSubscriptionPackage: (...args: unknown[]) => encryptMock(...args),
    decryptSubscriptionPackage: (...args: unknown[]) => decryptMock(...args),
    SubscriptionPassphraseError: FakePassphraseError,
  }
})

import { SubscriptionPassphraseError as FakePassphraseError } from "@/lib/subscription/core/encrypted-package"

const applyMocks = {
  saveAccount: jest.fn(async (..._args: unknown[]) => undefined),
  setActiveAccount: jest.fn(async (..._args: unknown[]) => undefined),
  setProviderPreset: jest.fn(async (..._args: unknown[]) => undefined),
}

jest.mock("@/lib/subscription/core/transport", () => ({
  getActiveAccount: jest.fn(async () => ({ activeAccountId: null })),
  getProviderPreset: jest.fn(async () => null),
  listAccounts: jest.fn(async () => []),
  getAccount: jest.fn(async () => null),
  saveAccount: (...args: unknown[]) => applyMocks.saveAccount(...args),
  setActiveAccount: (...args: unknown[]) => applyMocks.setActiveAccount(...args),
  setProviderPreset: (...args: unknown[]) => applyMocks.setProviderPreset(...args),
}))

jest.mock("@/types/subscription", () => ({
  ALL_PROVIDER_IDS: ["anthropic", "codex", "opencode"],
}))

import { ImportExportButtons } from "./import-export-buttons"

beforeEach(() => {
  decryptMock.mockReset()
  encryptMock.mockReset()
  buildPackageMock.mockReset()
  applyMocks.saveAccount.mockClear()
  applyMocks.setActiveAccount.mockClear()
  applyMocks.setProviderPreset.mockClear()
})

describe("ImportExportButtons import flow", () => {
  const openImportDialog = () => {
    fireEvent.click(screen.getByText("importButton"))
  }

  const selectFile = async () => {
    const fileInput = screen.getByLabelText("fileField") as HTMLInputElement
    const file = new File(["{}"], "backup.cogniabak.json", { type: "application/json" })
    // jsdom doesn't implement Blob.text() reliably — stub the file's text()
    // so the component's `await file.text()` resolves to a parseable JSON.
    ;(file as unknown as { text: () => Promise<string> }).text = () => Promise.resolve("{}")
    await userEvent.upload(fileInput, file)
  }

  it("renders the export and import buttons", () => {
    render(<ImportExportButtons />)
    expect(screen.getByText("exportButton")).toBeInTheDocument()
    expect(screen.getByText("importButton")).toBeInTheDocument()
  })

  it("shows the preview step after a successful decrypt", async () => {
    decryptMock.mockResolvedValueOnce({
      manifest: { exportedAt: 0, schemaVersion: 2 },
      vaults: {
        anthropic: {
          schemaVersion: 2,
          accounts: [{ id: "a1", label: "Personal", email: "x@x", source: "oauth" }],
          activeAccountId: "a1",
          preset: undefined,
        },
      },
    })
    render(<ImportExportButtons />)
    openImportDialog()
    await selectFile()
    fireEvent.click(screen.getByText("preview.unlock"))
    await waitFor(() => {
      expect(screen.getByTestId("import-preview")).toBeInTheDocument()
    })
    expect(screen.getByText(/Personal/)).toBeInTheDocument()
  })

  it("shows the preset badge when a vault has a preset", async () => {
    decryptMock.mockResolvedValueOnce({
      manifest: { exportedAt: 0, schemaVersion: 2 },
      vaults: {
        codex: {
          schemaVersion: 2,
          accounts: [],
          activeAccountId: null,
          preset: { id: "p1", label: "AWS", baseUrl: "https://aws" },
        },
      },
    })
    render(<ImportExportButtons />)
    openImportDialog()
    await selectFile()
    fireEvent.click(screen.getByText("preview.unlock"))
    await waitFor(() => {
      expect(screen.getByText("preview.hasPreset")).toBeInTheDocument()
      expect(screen.getByText("preview.noAccounts")).toBeInTheDocument()
    })
  })

  it("applies the vaults only after the user clicks Apply on the preview", async () => {
    decryptMock.mockResolvedValueOnce({
      manifest: { exportedAt: 0, schemaVersion: 2 },
      vaults: {
        anthropic: {
          schemaVersion: 2,
          accounts: [{ id: "a1", label: "Personal", email: "x@x", source: "oauth" }],
          activeAccountId: "a1",
          preset: undefined,
        },
      },
    })
    render(<ImportExportButtons />)
    openImportDialog()
    await selectFile()
    fireEvent.click(screen.getByText("preview.unlock"))
    await waitFor(() => {
      expect(screen.getByText("preview.apply")).toBeInTheDocument()
    })
    expect(applyMocks.saveAccount).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText("preview.apply"))
    await waitFor(() => {
      expect(applyMocks.saveAccount).toHaveBeenCalledTimes(1)
    })
  })

  it("surfaces a passphrase error and stays in idle on wrong passphrase", async () => {
    decryptMock.mockRejectedValueOnce(new FakePassphraseError())
    render(<ImportExportButtons />)
    openImportDialog()
    await selectFile()
    fireEvent.click(screen.getByText("preview.unlock"))
    await waitFor(() => {
      expect(screen.getByText("passphraseWrong")).toBeInTheDocument()
    })
    expect(screen.queryByTestId("import-preview")).not.toBeInTheDocument()
  })

  it("renders an empty-vault preview when the file has no providers", async () => {
    decryptMock.mockResolvedValueOnce({
      manifest: { exportedAt: 0, schemaVersion: 2 },
      vaults: {},
    })
    render(<ImportExportButtons />)
    openImportDialog()
    await selectFile()
    fireEvent.click(screen.getByText("preview.unlock"))
    await waitFor(() => {
      expect(screen.getByText("preview.empty")).toBeInTheDocument()
    })
  })
})
