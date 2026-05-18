/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const previewMock = jest.fn()
const installMock = jest.fn()
const isPublisherKeyTrustedMock = jest.fn()

jest.mock("@/lib/plugin/package/http-installer", () => ({
  previewBundleManifest: (...args: unknown[]) => previewMock(...args),
  installFromUrl: (...args: unknown[]) => installMock(...args),
  isPublisherKeyTrusted: (...args: unknown[]) => isPublisherKeyTrustedMock(...args),
}))

import { InstallFromUrlDialog } from "./install-from-url-dialog"

const baseManifest = {
  id: "demo.wasm",
  name: "Demo",
  version: "0.1.0",
  description: "x",
  type: "wasm" as const,
  capabilities: [],
  wasmMain: "main.wasm",
  wasm: { apiVersion: "0.1.0" },
  permissions: ["notification" as const],
  author: { name: "Alice", publicKey: "AAA=" },
}

beforeEach(() => {
  previewMock.mockReset()
  installMock.mockReset()
  isPublisherKeyTrustedMock.mockReset()
  isPublisherKeyTrustedMock.mockResolvedValue(false)
})

describe("InstallFromUrlDialog", () => {
  it("renders the URL input + preview button initially", () => {
    render(<InstallFromUrlDialog open onOpenChange={() => {}} />)
    expect(screen.getByLabelText("bundleUrlLabel")).toBeInTheDocument()
    const previewBtn = screen.getByTestId("install-from-url-preview-button")
    expect(previewBtn).toBeDisabled()
  })

  it("enables Preview when a URL is entered", () => {
    render(<InstallFromUrlDialog open onOpenChange={() => {}} />)
    fireEvent.change(screen.getByLabelText("bundleUrlLabel"), {
      target: { value: "https://example.com/p.zip" },
    })
    expect(screen.getByTestId("install-from-url-preview-button")).toBeEnabled()
  })

  it("disables Preview when signature URL set but public key missing", () => {
    render(<InstallFromUrlDialog open onOpenChange={() => {}} />)
    fireEvent.change(screen.getByLabelText("bundleUrlLabel"), {
      target: { value: "https://example.com/p.zip" },
    })
    fireEvent.change(screen.getByLabelText("signatureUrlLabel"), {
      target: { value: "https://example.com/p.zip.sig" },
    })
    expect(screen.getByTestId("install-from-url-preview-button")).toBeDisabled()
  })

  it("shows the manifest preview after a successful peek", async () => {
    previewMock.mockResolvedValueOnce({
      manifest: baseManifest,
      path: "/plugins/demo.wasm",
      signatureVerified: true,
      authorPublicKey: "AAA=",
      authorFingerprint: "9f3a112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
    })
    render(<InstallFromUrlDialog open onOpenChange={() => {}} />)
    fireEvent.change(screen.getByLabelText("bundleUrlLabel"), {
      target: { value: "https://example.com/p.zip" },
    })
    fireEvent.click(screen.getByTestId("install-from-url-preview-button"))
    await waitFor(() => {
      expect(screen.getByTestId("install-from-url-preview")).toBeInTheDocument()
    })
    expect(screen.getByText(/Demo/)).toBeInTheDocument()
    expect(screen.getByText("signatureVerified")).toBeInTheDocument()
  })

  it("renders 'already trusted' when the publisher key is known", async () => {
    previewMock.mockResolvedValueOnce({
      manifest: baseManifest,
      path: "/plugins/demo.wasm",
      signatureVerified: true,
      authorPublicKey: "AAA=",
      authorFingerprint: "deadbeef",
    })
    isPublisherKeyTrustedMock.mockResolvedValueOnce(true)
    render(<InstallFromUrlDialog open onOpenChange={() => {}} />)
    fireEvent.change(screen.getByLabelText("bundleUrlLabel"), {
      target: { value: "https://example.com/p.zip" },
    })
    fireEvent.click(screen.getByTestId("install-from-url-preview-button"))
    await waitFor(() => {
      expect(screen.getByText("alreadyTrusted")).toBeInTheDocument()
    })
  })

  it("surfaces preview errors in an alert", async () => {
    previewMock.mockRejectedValueOnce(new Error("download failed: 404"))
    render(<InstallFromUrlDialog open onOpenChange={() => {}} />)
    fireEvent.change(screen.getByLabelText("bundleUrlLabel"), {
      target: { value: "https://example.com/p.zip" },
    })
    fireEvent.click(screen.getByTestId("install-from-url-preview-button"))
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("download failed: 404")
    })
  })

  it("Cancel closes the dialog without calling install", () => {
    const onOpenChange = jest.fn()
    render(<InstallFromUrlDialog open onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByTestId("install-from-url-cancel"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(installMock).not.toHaveBeenCalled()
  })

  it("blocks Install when signed and the user has not confirmed trust", async () => {
    previewMock.mockResolvedValueOnce({
      manifest: baseManifest,
      path: "/plugins/demo.wasm",
      signatureVerified: true,
      authorPublicKey: "AAA=",
      authorFingerprint: "9f3a",
    })
    render(<InstallFromUrlDialog open onOpenChange={() => {}} />)
    fireEvent.change(screen.getByLabelText("bundleUrlLabel"), {
      target: { value: "https://example.com/p.zip" },
    })
    fireEvent.click(screen.getByTestId("install-from-url-preview-button"))
    await waitFor(() => {
      expect(screen.getByTestId("install-from-url-confirm-button")).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId("install-from-url-confirm-button"))
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("trustRequiredError")
    })
    expect(installMock).not.toHaveBeenCalled()
  })

  it("applies mobile-first w-[95vw] width to DialogContent", () => {
    render(<InstallFromUrlDialog open onOpenChange={() => {}} />)
    const dialog = screen.getByRole("dialog")
    expect(dialog.className).toContain("w-[95vw]")
  })
})
