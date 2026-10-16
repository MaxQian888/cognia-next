/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}:${Object.values(values).join(",")}` : `${namespace}.${key}`,
}))
jest.mock("@/lib/tauri", () => ({ localTransport: { call: jest.fn() } }))
import { localTransport } from "@/lib/tauri"

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

beforeEach(() => jest.clearAllMocks())

describe("PairedBrowsersList", () => {
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
