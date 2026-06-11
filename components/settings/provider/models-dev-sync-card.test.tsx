/**
 * @jest-environment jsdom
 */
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
  it("renders a compact sync button (non-resident)", () => {
    render(<ModelsDevSyncCard />)
    expect(screen.getByRole("button", { name: /Sync from models\.dev/i })).toBeInTheDocument()
  })

  it("shows a 'never synced' status line when the catalog has never been synced", () => {
    render(<ModelsDevSyncCard />)
    // !row → stale phase surfaces the last-synced (never) hint transiently.
    expect(screen.getByText(/Last synced: never/i)).toBeInTheDocument()
  })

  it("collapses to just the button (no resident status) once synced and fresh", () => {
    hookState.row = { fetchedAt: 1_700_000_000_000, source: "remote", providers: {} }
    hookState.providerCount = 21
    hookState.modelCount = 350
    render(<ModelsDevSyncCard />)
    // Idle phase: no status line is rendered.
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    // Counts/source/last-synced remain discoverable via the button hover title.
    const btn = screen.getByRole("button", { name: /Sync from models\.dev/i })
    expect(btn.getAttribute("title")).toContain("21 providers · 350 models")
    expect(btn.getAttribute("title")).toContain("Live")
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

  it("surfaces the error inline and toasts it when the hook reports one", async () => {
    hookState.error = "offline"
    render(<ModelsDevSyncCard />)
    expect(screen.getByRole("status")).toHaveTextContent("offline")
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(String(toastError.mock.calls[0][0])).toContain("offline")
  })
})
