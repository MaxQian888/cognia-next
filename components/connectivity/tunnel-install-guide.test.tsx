import { act, fireEvent, render, screen } from "@testing-library/react"

import { TunnelInstallGuide } from "./tunnel-install-guide"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))
const toast = { success: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toast.success(...a),
    error: (...a: unknown[]) => toast.error(...a),
  },
}))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn(async () => {}) }))

describe("TunnelInstallGuide", () => {
  beforeEach(() => {
    toast.success.mockClear()
    toast.error.mockClear()
  })

  it("lists the OS's steps for the tool and copies a command", async () => {
    const copy = jest.fn(async () => {})
    render(<TunnelInstallGuide tool="cloudflared" os="macos" copy={copy} />)
    const guide = screen.getByTestId("tunnel-install-guide")
    expect(guide).toHaveAttribute("data-os", "macos")
    expect(guide).toHaveTextContent("brew install cloudflared")
    await act(async () => {
      fireEvent.click(screen.getByTestId("tunnel-install-guide-copy-homebrew"))
    })
    expect(copy).toHaveBeenCalledWith("brew install cloudflared")
    expect(toast.success).toHaveBeenCalledWith("copied")
  })

  it("opens the vendor page for a download row and offers a re-check", async () => {
    const open = jest.fn(async () => {})
    const onRecheck = jest.fn()
    render(<TunnelInstallGuide tool="tailscale" os="windows" open={open} onRecheck={onRecheck} />)
    fireEvent.click(screen.getByTestId("tunnel-install-guide-open-download"))
    expect(open).toHaveBeenCalledWith("https://tailscale.com/download")
    fireEvent.click(screen.getByTestId("tunnel-install-guide-recheck"))
    expect(onRecheck).toHaveBeenCalled()
  })

  it("reports a failed copy instead of pretending", async () => {
    const copy = jest.fn(async () => {
      throw new Error("denied")
    })
    render(<TunnelInstallGuide tool="zerotier" os="linux" copy={copy} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId("tunnel-install-guide-copy-script"))
    })
    expect(toast.error).toHaveBeenCalledWith("copyFailed")
  })

  it("falls back to the plain download row on an unknown OS", () => {
    render(<TunnelInstallGuide tool="cloudflared" os="unknown" />)
    expect(screen.getByTestId("tunnel-install-guide-step-download")).toBeInTheDocument()
    expect(screen.queryByTestId("tunnel-install-guide-step-homebrew")).toBeNull()
  })
})
