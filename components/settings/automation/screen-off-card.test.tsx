// Screen-off Computer Use — ScreenOffCard tests.

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { ScreenOffCard } from "./screen-off-card"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockRefresh = jest.fn()
const mockHealthRef = {
  current: {
    available: false,
    installed: false,
    backend: "windows-parsec-vdd",
    driverVersion: "",
    activeMonitor: "",
    lastError: "",
  },
}
const mockErrorRef = { current: null as string | null }

jest.mock("@/hooks/automation/use-virtual-display-health", () => ({
  useVirtualDisplayHealth: () => ({
    health: mockHealthRef.current,
    refresh: mockRefresh,
    error: mockErrorRef.current,
  }),
}))

const mockSetup = jest.fn()
const mockProbe = jest.fn()

jest.mock("@/lib/automation/client", () => ({
  desktop: {
    virtualDisplaySetup: (...args: unknown[]) => mockSetup(...args),
    virtualDisplayProbe: (...args: unknown[]) => mockProbe(...args),
  },
}))

beforeEach(() => {
  mockRefresh.mockReset()
  mockSetup.mockReset()
  mockProbe.mockReset()
  mockErrorRef.current = null
  mockHealthRef.current = {
    available: false,
    installed: false,
    backend: "windows-parsec-vdd",
    driverVersion: "",
    activeMonitor: "",
    lastError: "",
  }
})

describe("ScreenOffCard", () => {
  it("shows a Windows-only note off Windows and hides the action buttons", () => {
    render(<ScreenOffCard platform="macos" />)
    expect(screen.getByTestId("screen-off-windows-only")).toBeInTheDocument()
    expect(screen.queryByTestId("screen-off-setup-button")).not.toBeInTheDocument()
    expect(screen.queryByTestId("screen-off-probe-button")).not.toBeInTheDocument()
  })

  it("offers the setup button when the driver is not installed", () => {
    render(<ScreenOffCard platform="windows" />)
    expect(screen.getByTestId("screen-off-status-badge")).toHaveTextContent("status.setup")
    expect(screen.getByTestId("screen-off-setup-button")).toBeInTheDocument()
    // Probe is disabled until the driver is available.
    expect(screen.getByTestId("screen-off-probe-button")).toBeDisabled()
  })

  it("ready state hides setup and enables the probe", () => {
    mockHealthRef.current = {
      available: true,
      installed: true,
      backend: "windows-parsec-vdd",
      driverVersion: "0.1.0",
      activeMonitor: "",
      lastError: "",
    }
    render(<ScreenOffCard platform="windows" />)
    expect(screen.getByTestId("screen-off-status-badge")).toHaveTextContent("status.ok")
    expect(screen.queryByTestId("screen-off-setup-button")).not.toBeInTheDocument()
    expect(screen.getByTestId("screen-off-probe-button")).not.toBeDisabled()
  })

  it("setup button triggers the elevated install then refreshes", async () => {
    mockSetup.mockResolvedValueOnce(undefined)
    render(<ScreenOffCard platform="windows" />)
    fireEvent.click(screen.getByTestId("screen-off-setup-button"))
    await waitFor(() => expect(mockSetup).toHaveBeenCalledTimes(1))
    expect(mockRefresh).toHaveBeenCalled()
  })

  it("probe success renders the non-black result", async () => {
    mockHealthRef.current = {
      available: true,
      installed: true,
      backend: "windows-parsec-vdd",
      driverVersion: "0.1.0",
      activeMonitor: "",
      lastError: "",
    }
    mockProbe.mockResolvedValueOnce({
      width: 1920,
      height: 1080,
      nonBlack: true,
      monitor: "\\\\.\\DISPLAY3",
    })
    render(<ScreenOffCard platform="windows" />)
    fireEvent.click(screen.getByTestId("screen-off-probe-button"))
    await waitFor(() =>
      expect(screen.getByTestId("screen-off-probe-result")).toHaveTextContent("probeOk")
    )
  })

  it("probe black frame renders the warning", async () => {
    mockHealthRef.current = {
      available: true,
      installed: true,
      backend: "windows-parsec-vdd",
      driverVersion: "0.1.0",
      activeMonitor: "",
      lastError: "",
    }
    mockProbe.mockResolvedValueOnce({ width: 1920, height: 1080, nonBlack: false, monitor: "" })
    render(<ScreenOffCard platform="windows" />)
    fireEvent.click(screen.getByTestId("screen-off-probe-button"))
    await waitFor(() =>
      expect(screen.getByTestId("screen-off-probe-result")).toHaveTextContent("probeBlack")
    )
  })

  it("surfaces a probe rejection as an inline error", async () => {
    mockHealthRef.current = {
      available: true,
      installed: true,
      backend: "windows-parsec-vdd",
      driverVersion: "0.1.0",
      activeMonitor: "",
      lastError: "",
    }
    mockProbe.mockRejectedValueOnce(new Error("driver gone"))
    render(<ScreenOffCard platform="windows" />)
    fireEvent.click(screen.getByTestId("screen-off-probe-button"))
    await waitFor(() => expect(screen.getByText("driver gone")).toBeInTheDocument())
  })
})
