import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))
jest.mock("@/lib/native/opener", () => ({
  openUrl: jest.fn(),
}))
jest.mock("@/lib/cli-bridge/download-release", () => ({
  downloadCogniaCli: jest.fn(),
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

import { isTauri } from "@/lib/tauri"
import { openUrl } from "@/lib/native/opener"
import { downloadCogniaCli } from "@/lib/cli-bridge/download-release"
import { CogniaCliInstallDialog } from "./cognia-cli-install-dialog"

const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
const mockOpenUrl = openUrl as jest.MockedFunction<typeof openUrl>
const mockDownload = downloadCogniaCli as jest.MockedFunction<typeof downloadCogniaCli>

function renderDialog(onInstalled?: () => void) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CogniaCliInstallDialog open onOpenChange={() => {}} onInstalled={onInstalled} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mockIsTauri.mockReset()
  mockIsTauri.mockReturnValue(true)
  mockOpenUrl.mockReset()
  mockDownload.mockReset()
  // jsdom lacks clipboard in some setups; stub it.
  Object.assign(navigator, {
    clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
  })
})

describe("CogniaCliInstallDialog", () => {
  it("shows the download tab + button in Tauri", () => {
    renderDialog()
    expect(screen.getByTestId("cognia-cli-install-dialog")).toBeInTheDocument()
    expect(screen.getByTestId("cognia-cli-download-button")).toBeInTheDocument()
  })

  it("runs the download and calls onInstalled on success", async () => {
    mockDownload.mockResolvedValueOnce({
      version: "latest",
      installDir: "/x",
      binaryPath: "/x/cognia",
      signatureVerified: false,
    })
    const onInstalled = jest.fn()
    renderDialog(onInstalled)
    await act(async () => {
      await userEvent.click(screen.getByTestId("cognia-cli-download-button"))
    })
    expect(mockDownload).toHaveBeenCalledTimes(1)
    expect(onInstalled).toHaveBeenCalled()
  })

  it("surfaces a download error inline", async () => {
    mockDownload.mockRejectedValueOnce(new Error("checksum mismatch"))
    renderDialog()
    await act(async () => {
      await userEvent.click(screen.getByTestId("cognia-cli-download-button"))
    })
    expect(screen.getByRole("alert")).toHaveTextContent("checksum mismatch")
  })

  it("copies the cargo command from the source tab", async () => {
    renderDialog()
    await userEvent.click(
      screen.getByRole("tab", { name: enMessages.plugins.cliInstall.tabSource })
    )
    await userEvent.click(screen.getByTestId("cognia-cli-copy-cargo"))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("cargo install")
    )
  })

  it("opens the releases page from the tarball tab", async () => {
    renderDialog()
    await userEvent.click(
      screen.getByRole("tab", { name: enMessages.plugins.cliInstall.tabTarball })
    )
    await userEvent.click(screen.getByTestId("cognia-cli-open-releases"))
    expect(mockOpenUrl).toHaveBeenCalledWith(expect.stringContaining("/releases"))
  })

  it("hides the download tab on web", () => {
    mockIsTauri.mockReturnValue(false)
    renderDialog()
    expect(screen.queryByTestId("cognia-cli-download-button")).not.toBeInTheDocument()
    expect(
      screen.getByRole("tab", { name: enMessages.plugins.cliInstall.tabSource })
    ).toBeInTheDocument()
  })
})
