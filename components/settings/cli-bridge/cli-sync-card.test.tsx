import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { CliSyncCard } from "./cli-sync-card"

const setAutoSync = jest.fn(async (_enabled: boolean) => {})
const stateRef = { current: { cliBridge: { autoSync: false } } as Record<string, unknown> }

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: stateRef.current,
      setCliBridgeAutoSync: (enabled: boolean) => setAutoSync(enabled),
    }),
}))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const resolveCliHome = jest.fn(async (): Promise<string | null> => "/home/.cognia")
jest.mock("@/lib/cli-bridge/home", () => ({ resolveCliHome: () => resolveCliHome() }))

const pushToCli = jest.fn(
  async (_s: unknown): Promise<{ home: string | null }> => ({ home: "/home/.cognia" })
)
const countPushSuccesses = jest.fn(() => 3)
const countPushErrors = jest.fn(() => 0)
jest.mock("@/lib/cli-bridge/push-to-cli", () => ({
  pushToCli: (settings: unknown) => pushToCli(settings),
  countPushSuccesses: () => countPushSuccesses(),
  countPushErrors: () => countPushErrors(),
}))

const maybeAutoPushToCli = jest.fn(
  async (_s: unknown): Promise<{ home: string | null }> => ({ home: "/home/.cognia" })
)
jest.mock("@/lib/cli-bridge/auto-push", () => ({
  maybeAutoPushToCli: (settings: unknown) => maybeAutoPushToCli(settings),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), message: jest.fn() },
}))
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { toast } = require("sonner") as {
  toast: { success: jest.Mock; error: jest.Mock; message: jest.Mock }
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  resolveCliHome.mockResolvedValue("/home/.cognia")
  pushToCli.mockResolvedValue({ home: "/home/.cognia" })
  maybeAutoPushToCli.mockResolvedValue({ home: "/home/.cognia" })
  countPushSuccesses.mockReturnValue(3)
  countPushErrors.mockReturnValue(0)
  stateRef.current = { cliBridge: { autoSync: false } }
})

describe("CliSyncCard", () => {
  it("renders nothing off the Tauri desktop", () => {
    isTauriMock.mockReturnValue(false)
    const { container } = render(<CliSyncCard />)
    expect(container).toBeEmptyDOMElement()
  })

  it("detects the CLI home and enables the sync button", async () => {
    render(<CliSyncCard />)
    const button = screen.getByRole("button", { name: "syncNow" })
    await waitFor(() => expect(button).not.toBeDisabled())
    expect(resolveCliHome).toHaveBeenCalled()
  })

  it("Sync now pushes everything and toasts success", async () => {
    const user = userEvent.setup()
    render(<CliSyncCard />)
    const button = screen.getByRole("button", { name: "syncNow" })
    await waitFor(() => expect(button).not.toBeDisabled())
    await user.click(button)
    expect(pushToCli).toHaveBeenCalledWith(stateRef.current)
    expect(toast.success).toHaveBeenCalled()
  })

  it("enabling auto-sync persists the flag and fires the immediate push", async () => {
    const user = userEvent.setup()
    render(<CliSyncCard />)
    await waitFor(() => expect(screen.getByRole("button", { name: "syncNow" })).not.toBeDisabled())
    await user.click(screen.getByRole("switch"))
    expect(setAutoSync).toHaveBeenCalledWith(true)
    await waitFor(() => expect(maybeAutoPushToCli).toHaveBeenCalled())
  })

  it("shows the not-detected state and disables sync when no home", async () => {
    resolveCliHome.mockResolvedValue(null)
    render(<CliSyncCard />)
    await waitFor(() => expect(screen.getByRole("button", { name: "syncNow" })).toBeDisabled())
  })

  it("toasts a partial result when some items fail", async () => {
    countPushErrors.mockReturnValue(1)
    const user = userEvent.setup()
    render(<CliSyncCard />)
    const button = screen.getByRole("button", { name: "syncNow" })
    await waitFor(() => expect(button).not.toBeDisabled())
    await user.click(button)
    expect(toast.error).toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("messages when the push found no CLI home", async () => {
    pushToCli.mockResolvedValueOnce({ home: null })
    const user = userEvent.setup()
    render(<CliSyncCard />)
    const button = screen.getByRole("button", { name: "syncNow" })
    await waitFor(() => expect(button).not.toBeDisabled())
    await user.click(button)
    expect(toast.message).toHaveBeenCalled()
  })

  it("toasts a failure when the push throws", async () => {
    pushToCli.mockRejectedValueOnce(new Error("disk full"))
    const user = userEvent.setup()
    render(<CliSyncCard />)
    const button = screen.getByRole("button", { name: "syncNow" })
    await waitFor(() => expect(button).not.toBeDisabled())
    await user.click(button)
    expect(toast.error).toHaveBeenCalled()
  })

  it("disabling auto-sync persists false without an immediate push", async () => {
    stateRef.current = { cliBridge: { autoSync: true } }
    const user = userEvent.setup()
    render(<CliSyncCard />)
    await waitFor(() => expect(screen.getByRole("button", { name: "syncNow" })).not.toBeDisabled())
    await user.click(screen.getByRole("switch"))
    expect(setAutoSync).toHaveBeenCalledWith(false)
    expect(maybeAutoPushToCli).not.toHaveBeenCalled()
  })
})
