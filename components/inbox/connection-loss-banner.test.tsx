/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

const mockIsTauri = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri(),
}))

const mockRequeue = jest.fn<Promise<boolean>, [string]>()
jest.mock("@/lib/connectors/lifecycle", () => ({
  requeueAdapter: (...args: unknown[]) => mockRequeue(...(args as [string])),
}))

// Declared inside the factory — a module-scope object would be in its TDZ when
// Jest hoists the `jest.mock` call above these lines.
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
import { ConnectionLossNotice } from "./connection-loss-banner"
import type { DegradedAdapter } from "@/hooks/connectors/use-degraded-adapters"

const mockToast = toast as jest.Mocked<typeof toast>

// The Dexie query, the per-set dismiss and its TTL live in
// `useDegradedAdapters` and are pinned by its own suite. This component is a
// pure presenter, so every case here is driven by props.
function wrap(adapters: DegradedAdapter[], onDismiss = jest.fn()) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as unknown as Record<string, unknown>}>
      <ConnectionLossNotice adapters={adapters} onDismiss={onDismiss} />
    </NextIntlClientProvider>
  )
}

function adapter(
  adapterId: string,
  state: "degraded" | "down" = "degraded",
  reason: string | null = null,
  at = 1_700_000_000_000
): DegradedAdapter {
  return { adapterId, state, reason, at }
}

beforeEach(() => {
  mockIsTauri.mockReturnValue(true)
  mockRequeue.mockReset()
  mockRequeue.mockResolvedValue(true)
  mockToast.success.mockClear()
  mockToast.error.mockClear()
})

describe("ConnectionLossNotice", () => {
  it("renders nothing when no adapters are degraded", () => {
    const { container } = wrap([])
    expect(container.querySelector("[data-testid='connection-loss-banner']")).toBeNull()
  })

  it("surfaces each adapter with a per-row reconnect button", () => {
    wrap([adapter("lark-1", "degraded", "lark_ping_failed"), adapter("onebot-1", "down")])
    expect(screen.getByTestId("connection-loss-banner")).toBeInTheDocument()
    expect(screen.getByTestId("connection-loss-row-lark-1")).toBeInTheDocument()
    expect(screen.getByTestId("connection-loss-row-onebot-1")).toBeInTheDocument()
    expect(screen.getByTestId("connection-loss-reconnect-lark-1")).toBeInTheDocument()
    expect(screen.getByTestId("connection-loss-reconnect-onebot-1")).toBeInTheDocument()
  })

  it("shows the reason only when one is present", () => {
    wrap([adapter("lark-1", "degraded", "lark_ping_failed"), adapter("onebot-1", "down")])
    expect(screen.getByTestId("connection-loss-row-lark-1")).toHaveTextContent("lark_ping_failed")
    expect(screen.getByTestId("connection-loss-row-onebot-1").textContent).not.toContain("—")
  })

  it("renders 'reconnect all' only when more than one adapter is down", () => {
    const { unmount } = wrap([adapter("only-one")])
    expect(screen.queryByTestId("connection-loss-reconnect-all")).not.toBeInTheDocument()
    unmount()

    wrap([adapter("a"), adapter("b")])
    expect(screen.getByTestId("connection-loss-reconnect-all")).toBeInTheDocument()
  })

  it("clicking reconnect drives requeueAdapter and reports success", async () => {
    wrap([adapter("lark-1")])
    fireEvent.click(screen.getByTestId("connection-loss-reconnect-lark-1"))
    await waitFor(() => expect(mockRequeue).toHaveBeenCalledWith("lark-1"))
    await waitFor(() => expect(mockToast.success).toHaveBeenCalled())
  })

  it("'reconnect all' kicks every adapter", async () => {
    wrap([adapter("a"), adapter("b")])
    fireEvent.click(screen.getByTestId("connection-loss-reconnect-all"))
    await waitFor(() => expect(mockRequeue).toHaveBeenCalledTimes(2))
    expect(mockRequeue).toHaveBeenCalledWith("a")
    expect(mockRequeue).toHaveBeenCalledWith("b")
  })

  it("reports the unavailable case when requeue resolves false", async () => {
    mockRequeue.mockResolvedValue(false)
    wrap([adapter("lark-1")])
    fireEvent.click(screen.getByTestId("connection-loss-reconnect-lark-1"))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled())
    expect(mockToast.success).not.toHaveBeenCalled()
  })

  it("surfaces a thrown requeue error and re-enables the button", async () => {
    mockRequeue.mockRejectedValue(new Error("transport gone"))
    wrap([adapter("lark-1")])
    const button = screen.getByTestId("connection-loss-reconnect-lark-1")
    fireEvent.click(button)
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("transport gone"))
    // `finally` must clear the in-flight id even on the failure path.
    await waitFor(() => expect(button).not.toBeDisabled())
  })

  it("stringifies a non-Error rejection", async () => {
    mockRequeue.mockRejectedValue("plain string")
    wrap([adapter("lark-1")])
    fireEvent.click(screen.getByTestId("connection-loss-reconnect-lark-1"))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("plain string"))
  })

  it("disables every reconnect control outside Tauri", () => {
    mockIsTauri.mockReturnValue(false)
    wrap([adapter("a"), adapter("b")])
    expect(screen.getByTestId("connection-loss-reconnect-a")).toBeDisabled()
    expect(screen.getByTestId("connection-loss-reconnect-b")).toBeDisabled()
    expect(screen.getByTestId("connection-loss-reconnect-all")).toBeDisabled()
    expect(mockRequeue).not.toHaveBeenCalled()
  })

  it("hands the dismiss control straight to the caller", () => {
    const onDismiss = jest.fn()
    wrap([adapter("lark-1")], onDismiss)
    fireEvent.click(screen.getByTestId("connection-loss-dismiss"))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
