import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

const hookState = {
  row: undefined as
    | undefined
    | { fetchedAt: number; source: "remote" | "bundled"; providers: Record<string, unknown> },
  providerCount: 0,
  modelCount: 0,
  isSyncing: false,
  error: null as string | null,
  sync: jest.fn(),
}
jest.mock("@/hooks/settings/use-models-dev-catalog", () => ({
  useModelsDevCatalog: () => hookState,
}))

import { ModelsDevSyncCard } from "./models-dev-sync-card"

beforeEach(() => {
  toastError.mockReset()
  hookState.row = undefined
  hookState.providerCount = 0
  hookState.modelCount = 0
  hookState.isSyncing = false
  hookState.error = null
  hookState.sync = jest.fn()
})

describe("ModelsDevSyncCard", () => {
  it("renders the sync button and 'never synced' state", () => {
    render(<ModelsDevSyncCard />)
    expect(screen.getByRole("button", { name: /Sync from models\.dev/i })).toBeInTheDocument()
    expect(screen.getByText(/Last synced: never/i)).toBeInTheDocument()
  })

  it("shows provider/model counts and the source badge once synced", () => {
    hookState.row = { fetchedAt: 1_700_000_000_000, source: "remote", providers: {} }
    hookState.providerCount = 21
    hookState.modelCount = 350
    render(<ModelsDevSyncCard />)
    expect(screen.getByText(/21 providers · 350 models/)).toBeInTheDocument()
    expect(screen.getByText("Live")).toBeInTheDocument()
  })

  it("renders the bundled source badge", () => {
    hookState.row = { fetchedAt: 1, source: "bundled", providers: {} }
    render(<ModelsDevSyncCard />)
    expect(screen.getByText("Bundled")).toBeInTheDocument()
  })

  it("invokes sync on click", () => {
    render(<ModelsDevSyncCard />)
    fireEvent.click(screen.getByRole("button", { name: /Sync from models\.dev/i }))
    expect(hookState.sync).toHaveBeenCalledTimes(1)
  })

  it("disables the button and shows progress while syncing", () => {
    hookState.isSyncing = true
    render(<ModelsDevSyncCard />)
    const btn = screen.getByRole("button", { name: /Syncing/i })
    expect(btn).toBeDisabled()
  })

  it("toasts an error when the hook reports one", async () => {
    hookState.error = "offline"
    render(<ModelsDevSyncCard />)
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(String(toastError.mock.calls[0][0])).toContain("offline")
  })
})
