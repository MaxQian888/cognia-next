/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const promptInstallMock = jest.fn<Promise<string>, []>()
let mockStatus = "unavailable"
jest.mock("@/hooks/use-install-prompt", () => ({
  useInstallPrompt: () => ({ status: mockStatus, install: promptInstallMock }),
}))

const detectPlatformMock = jest.fn(() => "web")
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => detectPlatformMock(),
}))

const trackEventMock = jest.fn<Promise<boolean>, unknown[]>(async () => true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...a: unknown[]) => trackEventMock(...a),
}))

import { InstallAppCard } from "./install-app-card"

beforeEach(() => {
  mockStatus = "unavailable"
  promptInstallMock.mockReset()
  detectPlatformMock.mockReturnValue("web")
  trackEventMock.mockClear()
})

describe("<InstallAppCard />", () => {
  it("renders nothing outside the web shell", () => {
    detectPlatformMock.mockReturnValue("tauri")
    const { container } = render(<InstallAppCard />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the muted unavailable state when the browser cannot install", () => {
    render(<InstallAppCard />)
    expect(screen.getByTestId("install-app-card")).toBeInTheDocument()
    expect(screen.queryByTestId("install-app-action")).not.toBeInTheDocument()
    expect(trackEventMock).not.toHaveBeenCalled()
  })

  it("shows the install button once and reports the shown event once", async () => {
    mockStatus = "installable"
    render(<InstallAppCard />)
    expect(screen.getByTestId("install-app-action")).toBeInTheDocument()
    await waitFor(() => expect(trackEventMock).toHaveBeenCalledWith("app.pwa.install.shown", {}))
    expect(trackEventMock).toHaveBeenCalledTimes(1)
  })

  it("prompts on click and reports an accepted outcome", async () => {
    mockStatus = "installable"
    promptInstallMock.mockResolvedValue("accepted")
    render(<InstallAppCard />)
    fireEvent.click(screen.getByTestId("install-app-action"))
    await waitFor(() => expect(promptInstallMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(trackEventMock).toHaveBeenCalledWith("app.pwa.install.accepted", {}))
  })

  it("reports a dismissed outcome", async () => {
    mockStatus = "installable"
    promptInstallMock.mockResolvedValue("dismissed")
    render(<InstallAppCard />)
    fireEvent.click(screen.getByTestId("install-app-action"))
    await waitFor(() =>
      expect(trackEventMock).toHaveBeenCalledWith("app.pwa.install.dismissed", {})
    )
  })

  it("shows the installed state inside a standalone window", () => {
    mockStatus = "installed"
    render(<InstallAppCard />)
    expect(screen.getByTestId("install-app-card")).toBeInTheDocument()
    expect(screen.queryByTestId("install-app-action")).not.toBeInTheDocument()
    expect(screen.getByText(/installed/i)).toBeInTheDocument()
  })

  it("shows the iOS manual steps on iOS Safari", () => {
    mockStatus = "ios-manual"
    render(<InstallAppCard />)
    expect(screen.queryByTestId("install-app-action")).not.toBeInTheDocument()
    expect(screen.getByRole("list")).toBeInTheDocument()
  })
})
