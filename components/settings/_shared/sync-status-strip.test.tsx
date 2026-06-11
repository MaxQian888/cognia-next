/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, act } from "@testing-library/react"
import { SyncStatusStrip, SYNC_SUCCESS_LINGER_MS, type SyncPhase } from "./sync-status-strip"

jest.mock("@/components/ui/button")

const baseProps = {
  label: "Sync",
  syncingLabel: "Syncing…",
  syncedLabel: "Synced",
  onSync: jest.fn(),
}

function renderStrip(
  phase: SyncPhase,
  extra?: Partial<React.ComponentProps<typeof SyncStatusStrip>>
) {
  return render(<SyncStatusStrip {...baseProps} phase={phase} {...extra} />)
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("SyncStatusStrip", () => {
  it("renders only the button when idle (non-resident)", () => {
    renderStrip("idle", { statusText: "should not show" })
    expect(screen.getByRole("button", { name: /Sync/i })).toBeInTheDocument()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(screen.queryByText("should not show")).not.toBeInTheDocument()
  })

  it("invokes onSync when the button is clicked", () => {
    const onSync = jest.fn()
    renderStrip("idle", { onSync })
    fireEvent.click(screen.getByRole("button"))
    expect(onSync).toHaveBeenCalledTimes(1)
  })

  it("shows the syncing label + progress text and disables the button while syncing", () => {
    renderStrip("syncing", { statusText: "uploading" })
    const btn = screen.getByRole("button", { name: /Syncing…/i })
    expect(btn).toBeDisabled()
    expect(screen.getByText("uploading")).toBeInTheDocument()
  })

  it("shows the error message on error", () => {
    renderStrip("error", { statusText: "offline" })
    expect(screen.getByRole("status")).toHaveTextContent("offline")
  })

  it("shows a stale hint when stale", () => {
    renderStrip("stale", { statusText: "8 days old" })
    expect(screen.getByText("8 days old")).toBeInTheDocument()
  })

  it("honors the disabled prop", () => {
    renderStrip("idle", { disabled: true })
    expect(screen.getByRole("button")).toBeDisabled()
  })

  it("exposes the summary as the button hover title", () => {
    renderStrip("idle", { summary: "21 providers · 350 models" })
    expect(screen.getByRole("button")).toHaveAttribute("title", "21 providers · 350 models")
  })

  it("shows a transient 'synced' confirmation after a sync completes, then clears it", () => {
    jest.useFakeTimers()
    try {
      const { rerender } = render(<SyncStatusStrip {...baseProps} phase="syncing" />)
      // Transition syncing → idle simulates a completed sync.
      rerender(<SyncStatusStrip {...baseProps} phase="idle" />)
      expect(screen.getByText("Synced")).toBeInTheDocument()

      act(() => {
        jest.advanceTimersByTime(SYNC_SUCCESS_LINGER_MS + 10)
      })
      expect(screen.queryByText("Synced")).not.toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })

  it("does not show the success confirmation on a plain idle render (no prior sync)", () => {
    renderStrip("idle")
    expect(screen.queryByText("Synced")).not.toBeInTheDocument()
  })
})
