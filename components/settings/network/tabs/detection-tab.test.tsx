/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn().mockResolvedValue(undefined)
let mockedSettings: Record<string, unknown> = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: { settings: typeof mockedSettings; save: typeof saveMock }) => T
  ) => selector({ settings: mockedSettings, save: saveMock }),
}))

jest.mock("@/stores/network-proxy", () => ({
  applyProxyToRust: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const networkProxyModule = require("@/stores/network-proxy") as {
  applyProxyToRust: jest.Mock
}
const applyProxyToRustMock = networkProxyModule.applyProxyToRust

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tauriCoreModule = require("@tauri-apps/api/core") as { invoke: jest.Mock }
const invokeMock = tauriCoreModule.invoke

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tauriModule = require("@/lib/tauri") as { isTauri: jest.Mock }
const isTauriMock = tauriModule.isTauri

import { NetworkDetectionTab } from "./detection-tab"

beforeEach(() => {
  saveMock.mockClear()
  applyProxyToRustMock.mockClear()
  invokeMock.mockClear()
  isTauriMock.mockReturnValue(true)
  mockedSettings = {}
})

describe("NetworkDetectionTab", () => {
  it("shows a 'Detect now' button initially", () => {
    render(<NetworkDetectionTab />)
    expect(screen.getByText("detection.button")).toBeInTheDocument()
  })

  it("renders empty state when no candidates are found", async () => {
    invokeMock.mockResolvedValue([])
    render(<NetworkDetectionTab />)
    await act(async () => {
      fireEvent.click(screen.getByLabelText("detection.button"))
    })
    await waitFor(() => {
      expect(screen.getByText("detection.empty")).toBeInTheDocument()
    })
  })

  it("renders candidates and applies one", async () => {
    invokeMock.mockResolvedValue([
      {
        kind: "clash",
        host: "127.0.0.1",
        port: 7890,
        label: "Clash mixed @ 127.0.0.1:7890",
        version: "1.18.0",
      },
    ])
    render(<NetworkDetectionTab />)
    await act(async () => {
      fireEvent.click(screen.getByLabelText("detection.button"))
    })
    await waitFor(() => {
      expect(screen.getByText("Clash mixed @ 127.0.0.1:7890")).toBeInTheDocument()
    })
    await act(async () => {
      fireEvent.click(screen.getByText("detection.apply"))
    })
    expect(saveMock).toHaveBeenCalled()
    const patch = saveMock.mock.calls[0][0]
    expect(patch.networkProxy.mode).toBe("auto")
    expect(patch.networkProxy.host).toBe("127.0.0.1")
    expect(patch.networkProxy.port).toBe(7890)
    expect(applyProxyToRustMock).toHaveBeenCalled()
  })

  it("maps SOCKS5 candidates to the socks5 protocol", async () => {
    invokeMock.mockResolvedValue([
      { kind: "socks5", host: "127.0.0.1", port: 1080, label: "SOCKS5 @ 127.0.0.1:1080" },
    ])
    render(<NetworkDetectionTab />)
    await act(async () => {
      fireEvent.click(screen.getByLabelText("detection.button"))
    })
    await waitFor(() => {
      expect(screen.getByText("SOCKS5 @ 127.0.0.1:1080")).toBeInTheDocument()
    })
    await act(async () => {
      fireEvent.click(screen.getByText("detection.apply"))
    })
    const patch = saveMock.mock.calls[0][0]
    expect(patch.networkProxy.protocol).toBe("socks5")
  })

  it("renders the error card when invoke rejects", async () => {
    invokeMock.mockRejectedValue(new Error("permission denied"))
    render(<NetworkDetectionTab />)
    await act(async () => {
      fireEvent.click(screen.getByLabelText("detection.button"))
    })
    await waitFor(() => {
      expect(screen.getByText(/permission denied/)).toBeInTheDocument()
    })
  })

  it("shows a web-unsupported notice and skips invoke when not in Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    render(<NetworkDetectionTab />)
    await act(async () => {
      fireEvent.click(screen.getByLabelText("detection.button"))
    })
    expect(invokeMock).not.toHaveBeenCalled()
    expect(screen.getByText("detection.webUnsupported")).toBeInTheDocument()
  })
})
