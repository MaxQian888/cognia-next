/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useFormatter: () => ({ dateTime: (value: number) => new Date(value).toISOString() }),
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}:${Object.values(values).join(",")}` : `${namespace}.${key}`,
}))
jest.mock("@/lib/tauri", () => ({ localTransport: { call: jest.fn() } }))
import { localTransport } from "@/lib/tauri"

/** The device console's `forget`, which the list uses unless one is injected. */
// eslint-disable-next-line no-var -- jest.mock factories hoist above this body.
var consoleForget: jest.Mock
jest.mock("@/hooks/devices/use-device-grant-actions", () => ({
  useDeviceGrantActions: () => ({ forget: consoleForget }),
}))

import { PairedBrowsersList, type PairedBrowser } from "./paired-browsers-list"

function browser(overrides: Partial<PairedBrowser> = {}): PairedBrowser {
  return {
    deviceId: "browser-a",
    displayName: "Chrome",
    status: "active",
    createdAt: 1,
    connected: true,
    extensionVersion: "0.2.0",
    driveAllowed: false,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  consoleForget = jest.fn(async (_deviceId: string, _name: string) => undefined)
})

describe("PairedBrowsersList", () => {
  it("shows the live connection time and negotiated features, clearing them offline", async () => {
    const connectedAt = 1_700_000_000_000
    const loadBrowsers = jest.fn(async () => [
      browser({ connectedAt, features: ["agent", "capture"] }),
    ])
    const { rerender } = render(<PairedBrowsersList loadBrowsers={loadBrowsers} />)
    expect(await screen.findByText(/pairedConnectedAt:2023-11-14/)).toBeVisible()
    expect(screen.getByText(/pairedFeatures:agent, capture/)).toBeVisible()
    rerender(
      <PairedBrowsersList
        loadBrowsers={async () => [browser({ connected: false, connectedAt, features: ["agent"] })]}
      />
    )
    await waitFor(() => expect(screen.queryByText(/pairedConnectedAt:/)).not.toBeInTheDocument())
    expect(screen.queryByText(/pairedFeatures:/)).not.toBeInTheDocument()
  })
  it("shows each browser's connection and version", async () => {
    render(
      <PairedBrowsersList
        loadBrowsers={async () => [
          browser(),
          browser({
            deviceId: "browser-b",
            displayName: "Edge",
            connected: false,
            extensionVersion: null,
          }),
        ]}
        setDrive={async () => undefined}
      />
    )
    const first = await screen.findByTestId("paired-browser-browser-a")
    expect(first).toHaveTextContent("mobile.companion.browserCompanion.pairedConnected")
    expect(first).toHaveTextContent("mobile.companion.browserCompanion.pairedVersion:0.2.0")
    expect(screen.getByTestId("paired-browser-browser-b")).toHaveTextContent(
      "mobile.companion.browserCompanion.pairedOffline"
    )
  })

  it("asks before allowing agents, and grants only on confirm", async () => {
    const setDrive = jest.fn(async (_deviceId: string, _allowed: boolean) => undefined)
    let allowed = false
    render(
      <PairedBrowsersList
        loadBrowsers={async () => [browser({ driveAllowed: allowed })]}
        setDrive={async (deviceId, next) => {
          allowed = next
          await setDrive(deviceId, next)
        }}
      />
    )
    fireEvent.click(await screen.findByTestId("paired-browser-drive-browser-a"))
    expect(await screen.findByTestId("paired-browser-drive-dialog")).toBeInTheDocument()
    expect(setDrive).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("paired-browser-drive-confirm"))
    await waitFor(() => expect(setDrive).toHaveBeenCalledWith("browser-a", true))
    await waitFor(() =>
      expect(screen.getByTestId("paired-browser-drive-browser-a")).toHaveAttribute(
        "data-state",
        "checked"
      )
    )
  })

  it("revokes without a confirmation", async () => {
    const setDrive = jest.fn(async () => undefined)
    render(
      <PairedBrowsersList
        loadBrowsers={async () => [browser({ driveAllowed: true })]}
        setDrive={setDrive}
      />
    )
    fireEvent.click(await screen.findByTestId("paired-browser-drive-browser-a"))
    await waitFor(() => expect(setDrive).toHaveBeenCalledWith("browser-a", false))
    expect(screen.queryByTestId("paired-browser-drive-dialog")).not.toBeInTheDocument()
  })

  it("disables the switch for a suspended browser", async () => {
    render(
      <PairedBrowsersList
        loadBrowsers={async () => [browser({ status: "suspended" })]}
        setDrive={async () => undefined}
      />
    )
    expect(await screen.findByTestId("paired-browser-drive-browser-a")).toBeDisabled()
  })

  it("says when the list cannot be read, and when it is empty", async () => {
    const { unmount } = render(
      <PairedBrowsersList
        loadBrowsers={async () => {
          throw new Error("store down")
        }}
        setDrive={async () => undefined}
      />
    )
    expect(await screen.findByTestId("paired-browsers-error")).toBeInTheDocument()
    unmount()
    render(<PairedBrowsersList loadBrowsers={async () => []} setDrive={async () => undefined} />)
    expect(await screen.findByTestId("paired-browsers-empty")).toBeInTheDocument()
  })

  it("defaults to the local desktop commands", async () => {
    ;(localTransport.call as jest.Mock).mockImplementation(async (name: string) =>
      name === "companion_browser_extension_list" ? [browser({ driveAllowed: true })] : undefined
    )
    render(<PairedBrowsersList />)
    fireEvent.click(await screen.findByTestId("paired-browser-drive-browser-a"))
    await waitFor(() =>
      expect(localTransport.call).toHaveBeenCalledWith("companion_browser_extension_set_drive", {
        deviceId: "browser-a",
        allowed: false,
      })
    )
  })

  it("offers Forget instead of the agent switch on a revoked browser", async () => {
    render(
      <PairedBrowsersList
        loadBrowsers={async () => [
          browser({ deviceId: "browser-r", status: "revoked", connected: false }),
          browser(),
        ]}
        setDrive={async () => undefined}
      />
    )
    const revoked = await screen.findByTestId("paired-browser-browser-r")
    expect(revoked).toHaveTextContent("mobile.companion.browserCompanion.pairedRevoked")
    expect(revoked).not.toHaveTextContent("mobile.companion.browserCompanion.pairedOffline")
    expect(screen.queryByTestId("paired-browser-drive-browser-r")).not.toBeInTheDocument()
    expect(screen.getByTestId("paired-browser-forget-browser-r")).toBeEnabled()
    // A live browser keeps its switch and has nothing to forget.
    expect(screen.getByTestId("paired-browser-drive-browser-a")).toBeInTheDocument()
    expect(screen.queryByTestId("paired-browser-forget-browser-a")).not.toBeInTheDocument()
  })

  it("asks before forgetting, then forgets and re-reads the list", async () => {
    let listed = [browser({ deviceId: "browser-r", status: "revoked", displayName: "Old" })]
    const loadBrowsers = jest.fn(async () => listed)
    const forgetBrowser = jest.fn(async (_deviceId: string, _name: string) => {
      listed = []
    })
    render(
      <PairedBrowsersList
        loadBrowsers={loadBrowsers}
        setDrive={async () => undefined}
        forgetBrowser={forgetBrowser}
      />
    )

    fireEvent.click(await screen.findByTestId("paired-browser-forget-browser-r"))
    expect(screen.getByTestId("paired-browser-forget-dialog")).toHaveTextContent(
      "mobile.companion.browserCompanion.forgetConfirmTitle:Old"
    )
    fireEvent.click(screen.getByText("mobile.companion.browserCompanion.forgetConfirmCancel"))
    expect(forgetBrowser).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("paired-browser-forget-browser-r"))
    fireEvent.click(screen.getByTestId("paired-browser-forget-confirm"))
    await waitFor(() => expect(forgetBrowser).toHaveBeenCalledWith("browser-r", "Old"))
    expect(await screen.findByTestId("paired-browsers-empty")).toBeInTheDocument()
    expect(consoleForget).not.toHaveBeenCalled()
  })

  it("forgets through the device console's action by default", async () => {
    render(
      <PairedBrowsersList
        loadBrowsers={async () => [browser({ status: "revoked", displayName: "Old" })]}
        setDrive={async () => undefined}
      />
    )
    fireEvent.click(await screen.findByTestId("paired-browser-forget-browser-a"))
    fireEvent.click(screen.getByTestId("paired-browser-forget-confirm"))
    await waitFor(() => expect(consoleForget).toHaveBeenCalledWith("browser-a", "Old"))
  })

  it("re-reads the connection state while open", async () => {
    jest.useFakeTimers()
    const loadBrowsers = jest.fn(async () => [browser()])
    render(
      <PairedBrowsersList
        loadBrowsers={loadBrowsers}
        setDrive={async () => undefined}
        refreshMs={1_000}
      />
    )
    await act(async () => {
      jest.advanceTimersByTime(2_100)
    })
    expect(loadBrowsers.mock.calls.length).toBeGreaterThanOrEqual(3)
    jest.useRealTimers()
  })
})
