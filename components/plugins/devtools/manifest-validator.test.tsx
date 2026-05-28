import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: jest.fn(),
}))

jest.mock("@/lib/native/utils", () => ({
  canUseTauriInvoke: jest.fn(() => true),
}))

jest.mock("@/lib/plugin/local/install-from-directory", () => ({
  previewLocalManifest: jest.fn(),
}))

jest.mock("@/lib/plugin/core/validation", () => ({
  validatePluginManifest: jest.fn(),
}))

import * as dialogPlugin from "@tauri-apps/plugin-dialog"
import { canUseTauriInvoke } from "@/lib/native/utils"
import { previewLocalManifest } from "@/lib/plugin/local/install-from-directory"
import { validatePluginManifest } from "@/lib/plugin/core/validation"
import { ManifestValidator } from "./manifest-validator"

const mockOpen = dialogPlugin.open as jest.MockedFunction<typeof dialogPlugin.open>
const mockCanUse = canUseTauriInvoke as jest.MockedFunction<typeof canUseTauriInvoke>
const mockPreview = previewLocalManifest as jest.MockedFunction<typeof previewLocalManifest>
const mockValidate = validatePluginManifest as jest.MockedFunction<typeof validatePluginManifest>

function renderWithIntl(node: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mockOpen.mockReset()
  mockCanUse.mockReset()
  mockCanUse.mockReturnValue(true)
  mockPreview.mockReset()
  mockValidate.mockReset()
})

describe("ManifestValidator", () => {
  it("renders title + description + pick button", () => {
    renderWithIntl(<ManifestValidator />)
    expect(screen.getByText(enMessages.plugins.devtools.validator.title)).toBeInTheDocument()
    expect(screen.getByTestId("manifest-validator-pick")).toBeInTheDocument()
  })

  it("shows the valid verdict + permissions on a clean manifest", async () => {
    mockOpen.mockResolvedValueOnce("C:/plugins/demo/plugin.json")
    mockPreview.mockResolvedValueOnce({
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      type: "frontend",
      permissions: ["filesystem:read"],
      capabilities: ["tools"],
    } as never)
    mockValidate.mockReturnValueOnce({ valid: true, errors: [], warnings: [] })

    renderWithIntl(<ManifestValidator />)
    await act(async () => {
      await userEvent.click(screen.getByTestId("manifest-validator-pick"))
    })
    expect(screen.getByTestId("manifest-validator-result")).toBeInTheDocument()
    expect(screen.getByText(enMessages.plugins.devtools.validator.valid)).toBeInTheDocument()
    expect(screen.getByText("filesystem:read")).toBeInTheDocument()
  })

  it("lists errors when validation fails", async () => {
    mockOpen.mockResolvedValueOnce("C:/plugins/broken/plugin.json")
    mockPreview.mockResolvedValueOnce({
      id: "broken",
      name: "Broken",
      version: "bad-semver",
      type: "frontend",
    } as never)
    mockValidate.mockReturnValueOnce({
      valid: false,
      errors: ["version must be valid semver", "missing main entry"],
      warnings: [],
    })

    renderWithIntl(<ManifestValidator />)
    await act(async () => {
      await userEvent.click(screen.getByTestId("manifest-validator-pick"))
    })
    expect(screen.getByText("version must be valid semver")).toBeInTheDocument()
    expect(screen.getByText("missing main entry")).toBeInTheDocument()
  })

  it("surfaces a read error when the manifest can't be parsed", async () => {
    mockOpen.mockResolvedValueOnce("C:/plugins/broken/plugin.json")
    mockPreview.mockRejectedValueOnce(new Error("invalid plugin.json: trailing comma"))

    renderWithIntl(<ManifestValidator />)
    await act(async () => {
      await userEvent.click(screen.getByTestId("manifest-validator-pick"))
    })
    expect(screen.getByTestId("manifest-validator-read-error")).toHaveTextContent("trailing comma")
    expect(mockValidate).not.toHaveBeenCalled()
  })

  it("shows the tauri-required hint on web", async () => {
    mockCanUse.mockReturnValue(false)
    renderWithIntl(<ManifestValidator />)
    await act(async () => {
      await userEvent.click(screen.getByTestId("manifest-validator-pick"))
    })
    expect(screen.getByTestId("manifest-validator-read-error")).toHaveTextContent(
      enMessages.plugins.devtools.validator.tauriRequiredError
    )
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it("noops silently when the picker is cancelled", async () => {
    mockOpen.mockResolvedValueOnce(null as never)
    renderWithIntl(<ManifestValidator />)
    await act(async () => {
      await userEvent.click(screen.getByTestId("manifest-validator-pick"))
    })
    expect(screen.queryByTestId("manifest-validator-result")).not.toBeInTheDocument()
    expect(mockPreview).not.toHaveBeenCalled()
  })
})
