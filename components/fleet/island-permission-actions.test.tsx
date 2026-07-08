/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { IslandPermissionActions } from "./island-permission-actions"
import { FLEET_PERMISSION_WAIT_MS } from "@/lib/fleet/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const respondMock = jest.fn()
jest.mock("@/lib/tauri/fleet", () => ({
  fleetPermissionRespond: (...args: unknown[]) => respondMock(...args),
}))

function pending(
  overrides: Partial<Parameters<typeof IslandPermissionActions>[0]["pending"]> = {}
) {
  return {
    requestId: "req-1",
    toolName: "Bash",
    detail: "rm -rf build",
    requestedAt: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  respondMock.mockReset()
  respondMock.mockResolvedValue(true)
})

describe("IslandPermissionActions", () => {
  it("renders the request line, countdown and both buttons", () => {
    render(<IslandPermissionActions pending={pending()} />)
    expect(screen.getByText(/request:\{"tool":"Bash"\}/)).toBeInTheDocument()
    expect(screen.getByTestId("permission-countdown")).toBeInTheDocument()
    expect(screen.getByTestId("permission-allow")).toBeInTheDocument()
    expect(screen.getByTestId("permission-deny")).toBeInTheDocument()
  })

  it("sends allow and shows the answered state", async () => {
    render(<IslandPermissionActions pending={pending()} />)
    fireEvent.click(screen.getByTestId("permission-allow"))
    await waitFor(() => expect(respondMock).toHaveBeenCalledWith("req-1", "allow"))
    expect(screen.getByTestId("permission-answered")).toHaveTextContent("allowed")
    expect(screen.queryByTestId("permission-allow")).toBeNull()
  })

  it("sends deny and shows the answered state", async () => {
    render(<IslandPermissionActions pending={pending()} />)
    fireEvent.click(screen.getByTestId("permission-deny"))
    await waitFor(() => expect(respondMock).toHaveBeenCalledWith("req-1", "deny"))
    expect(screen.getByTestId("permission-answered")).toHaveTextContent("denied")
  })

  it("keeps the buttons when the Rust side reports the request already gone", async () => {
    respondMock.mockResolvedValue(false)
    render(<IslandPermissionActions pending={pending()} />)
    fireEvent.click(screen.getByTestId("permission-allow"))
    await waitFor(() => expect(respondMock).toHaveBeenCalled())
    expect(screen.queryByTestId("permission-answered")).toBeNull()
  })

  it("shows the expired state past the answer window and stops responding", () => {
    jest.useFakeTimers()
    try {
      render(
        <IslandPermissionActions
          pending={pending({ requestedAt: Date.now() - FLEET_PERMISSION_WAIT_MS + 1500 })}
        />
      )
      expect(screen.getByTestId("permission-countdown")).toBeInTheDocument()
      act(() => {
        jest.advanceTimersByTime(3000)
      })
      expect(screen.getByTestId("permission-expired")).toBeInTheDocument()
      expect(screen.queryByTestId("permission-allow")).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it("renders the generic label when the tool name is unknown", () => {
    render(<IslandPermissionActions pending={pending({ toolName: null, detail: null })} />)
    expect(screen.getByText("requestGeneric")).toBeInTheDocument()
  })
})
