import { render, waitFor } from "@testing-library/react"

import { CliSyncInitializer } from "./cli-sync-initializer"

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const getSettings = jest.fn(async () => ({ id: "singleton", cliBridge: { autoSync: true } }))
jest.mock("@/lib/db/settings", () => ({ getSettings: () => getSettings() }))

const maybeAutoPushToCli = jest.fn(
  async (_s: unknown): Promise<{ home: string | null }> => ({ home: "/home/.cognia" })
)
jest.mock("@/lib/cli-bridge/auto-push", () => ({
  maybeAutoPushToCli: (settings: unknown) => maybeAutoPushToCli(settings),
}))

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
})

describe("CliSyncInitializer", () => {
  it("renders nothing", () => {
    const { container } = render(<CliSyncInitializer />)
    expect(container).toBeEmptyDOMElement()
  })

  it("pushes on boot when on the Tauri desktop", async () => {
    render(<CliSyncInitializer />)
    await waitFor(() => expect(maybeAutoPushToCli).toHaveBeenCalled())
    expect(getSettings).toHaveBeenCalled()
  })

  it("does nothing off the desktop", async () => {
    isTauriMock.mockReturnValue(false)
    render(<CliSyncInitializer />)
    await Promise.resolve()
    expect(getSettings).not.toHaveBeenCalled()
    expect(maybeAutoPushToCli).not.toHaveBeenCalled()
  })

  it("swallows a boot-time failure", async () => {
    getSettings.mockRejectedValueOnce(new Error("db locked"))
    render(<CliSyncInitializer />)
    await waitFor(() => expect(getSettings).toHaveBeenCalled())
    // No throw → still rendered.
    expect(maybeAutoPushToCli).not.toHaveBeenCalled()
  })
})
