/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

const mockListRecent = jest.fn()
jest.mock("@/lib/db/inbox-telemetry", () => ({
  listRecent: (opts?: unknown) => mockListRecent(opts),
}))

const mockExport = jest.fn((_opts: unknown) => ({
  filename: "cognia-inbox-telemetry-test.csv",
  mime: "text/csv",
}))
jest.mock("@/lib/telemetry/inbox-telemetry-export", () => ({
  exportInboxTelemetry: (opts: unknown) => mockExport(opts),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), message: jest.fn() },
}))

import { InboxTelemetryCard } from "./inbox-telemetry-card"
import { toast } from "sonner"

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as unknown as Record<string, unknown>}>
      {ui}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mockListRecent.mockReset()
  mockExport.mockClear()
  ;(toast.success as jest.Mock).mockClear()
  ;(toast.message as jest.Mock).mockClear()
  ;(toast.error as jest.Mock).mockClear()
})

describe("InboxTelemetryCard", () => {
  it("renders the card with the row count after mount", async () => {
    mockListRecent.mockResolvedValueOnce([
      { id: "r1", kind: "outbound.sent", at: 100 },
      { id: "r2", kind: "inbound.received", at: 200 },
    ])
    wrap(<InboxTelemetryCard />)
    await waitFor(() => expect(screen.getByText(/2 events captured/)).toBeInTheDocument())
  })

  it("disables export buttons when the buffer is empty", async () => {
    mockListRecent.mockResolvedValueOnce([])
    wrap(<InboxTelemetryCard />)
    await waitFor(() => expect(screen.getByText(/No events captured yet/)).toBeInTheDocument())
    expect(screen.getByTestId("inbox-telemetry-export-csv")).toBeDisabled()
    expect(screen.getByTestId("inbox-telemetry-export-json")).toBeDisabled()
  })

  it("calls exportInboxTelemetry on CSV click and emits a success toast", async () => {
    mockListRecent.mockResolvedValueOnce([{ id: "r1", kind: "outbound.sent", at: 100 }])
    // Second invocation is when onExport calls listRecent again.
    mockListRecent.mockResolvedValueOnce([{ id: "r1", kind: "outbound.sent", at: 100 }])
    wrap(<InboxTelemetryCard />)
    await waitFor(() => expect(screen.getByText(/1 event captured/)).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("inbox-telemetry-export-csv"))
    await waitFor(() => {
      expect(mockExport).toHaveBeenCalledWith({
        rows: [{ id: "r1", kind: "outbound.sent", at: 100 }],
        format: "csv",
      })
      expect(toast.success).toHaveBeenCalled()
    })
  })

  it("emits a message toast when export is triggered on an empty buffer", async () => {
    // Initial mount: 1 row, button enabled.
    mockListRecent.mockResolvedValueOnce([{ id: "r1", kind: "outbound.sent", at: 100 }])
    // Snapshot at export time: now empty (eviction raced the click).
    mockListRecent.mockResolvedValueOnce([])
    wrap(<InboxTelemetryCard />)
    await waitFor(() => expect(screen.getByText(/1 event captured/)).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("inbox-telemetry-export-json"))
    await waitFor(() => {
      expect(toast.message).toHaveBeenCalled()
      expect(mockExport).not.toHaveBeenCalled()
    })
  })

  it("refresh button re-runs the count", async () => {
    mockListRecent.mockResolvedValueOnce([{ id: "r1", kind: "outbound.sent", at: 100 }])
    wrap(<InboxTelemetryCard />)
    await waitFor(() => expect(screen.getByText(/1 event captured/)).toBeInTheDocument())
    mockListRecent.mockResolvedValueOnce([
      { id: "r1", kind: "outbound.sent", at: 100 },
      { id: "r2", kind: "inbound.received", at: 200 },
      { id: "r3", kind: "breaker.open", at: 300 },
    ])
    fireEvent.click(screen.getByTestId("inbox-telemetry-refresh"))
    await waitFor(() => expect(screen.getByText(/3 events captured/)).toBeInTheDocument())
  })
})
