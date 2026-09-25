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
    expect(screen.getByTestId("permission-answered")).toHaveTextContent("answered.allow")
    expect(screen.queryByTestId("permission-allow")).toBeNull()
  })

  it("sends deny and shows the answered state", async () => {
    render(<IslandPermissionActions pending={pending()} />)
    fireEvent.click(screen.getByTestId("permission-deny"))
    await waitFor(() => expect(respondMock).toHaveBeenCalledWith("req-1", "deny"))
    expect(screen.getByTestId("permission-answered")).toHaveTextContent("answered.deny")
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

  it("drains the countdown progress bar and turns red near the deadline", () => {
    jest.useFakeTimers()
    try {
      render(<IslandPermissionActions pending={pending({ requestedAt: Date.now() })} />)
      const bar = screen.getByTestId("permission-progress")
      // Fresh request → (almost) full width, amber.
      expect(bar.style.width).toBe("100%")
      expect(bar.className).toContain("bg-amber-400")
      // Advance to within the last 5 seconds → shrunken and red.
      act(() => {
        jest.advanceTimersByTime(FLEET_PERMISSION_WAIT_MS - 4_000)
      })
      expect(parseFloat(screen.getByTestId("permission-progress").style.width)).toBeLessThan(25)
      expect(screen.getByTestId("permission-progress").className).toContain("bg-red-400")
    } finally {
      jest.useRealTimers()
    }
  })

  it("hides the progress bar once answered or expired", async () => {
    render(<IslandPermissionActions pending={pending()} />)
    expect(screen.getByTestId("permission-progress-track")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("permission-allow"))
    await waitFor(() => expect(screen.queryByTestId("permission-progress-track")).toBeNull())
  })

  it("waits without a countdown for an ask that never lapses", () => {
    jest.useFakeTimers()
    try {
      render(
        <IslandPermissionActions
          pending={pending({ requestedAt: Date.now() - 10 * FLEET_PERMISSION_WAIT_MS })}
          deadline={null}
        />
      )
      expect(screen.queryByTestId("permission-countdown")).toBeNull()
      expect(screen.queryByTestId("permission-progress-track")).toBeNull()
      expect(screen.queryByTestId("permission-expired")).toBeNull()
      // Long past the hook window, still answerable.
      expect(screen.getByTestId("permission-allow")).toBeEnabled()
    } finally {
      jest.useRealTimers()
    }
  })

  it("counts a long deadline in minutes and says it lapsed rather than moved to a terminal", () => {
    jest.useFakeTimers()
    try {
      const now = Date.now()
      render(
        <IslandPermissionActions
          pending={pending({ requestedAt: now })}
          deadline={{ at: now + 185_000, fallback: "lapse" }}
        />
      )
      expect(screen.getByTestId("permission-countdown")).toHaveTextContent(
        'remaining:{"duration":"3m05s"}'
      )
      act(() => {
        jest.advanceTimersByTime(186_000)
      })
      expect(screen.getByTestId("permission-expired")).toHaveTextContent("lapsed")
    } finally {
      jest.useRealTimers()
    }
  })

  it("offers Always allow only where the ask permits a standing rule", async () => {
    const respond = jest.fn(async () => true)
    const { unmount } = render(
      <IslandPermissionActions pending={pending()} deadline={null} respond={respond} />
    )
    expect(screen.queryByTestId("permission-allow-always")).toBeNull()
    unmount()

    render(
      <IslandPermissionActions pending={pending()} deadline={null} allowAlways respond={respond} />
    )
    fireEvent.click(screen.getByTestId("permission-allow-always"))
    await waitFor(() => expect(respond).toHaveBeenCalledWith("req-1", "allow_always"))
    expect(screen.getByTestId("permission-answered")).toHaveTextContent("allowedAlways")
    expect(respondMock).not.toHaveBeenCalled()
  })

  it.each(["plan", "budget", "review"] as const)(
    "words a %s decision as approve or reject",
    async (kind) => {
      const respond = jest.fn(async () => true)
      render(
        <IslandPermissionActions
          pending={pending({ toolName: null })}
          kind={kind}
          deadline={null}
          respond={respond}
        />
      )
      expect(screen.getByText(`ask.${kind}`)).toBeInTheDocument()
      expect(screen.getByTestId("permission-allow")).toHaveTextContent("approve")
      expect(screen.getByTestId("permission-deny")).toHaveTextContent("reject")
      fireEvent.click(screen.getByTestId("permission-deny"))
      await waitFor(() => expect(respond).toHaveBeenCalledWith("req-1", "deny"))
      expect(screen.getByTestId("permission-answered")).toHaveTextContent("answered.reject")
    }
  )

  it("confirms an approved decision in its own words", async () => {
    const respond = jest.fn(async () => true)
    render(
      <IslandPermissionActions
        pending={pending()}
        kind="budget"
        deadline={null}
        respond={respond}
      />
    )
    fireEvent.click(screen.getByTestId("permission-allow"))
    await waitFor(() => expect(respond).toHaveBeenCalledWith("req-1", "allow"))
    expect(screen.getByTestId("permission-answered")).toHaveTextContent("answered.approve")
  })

  it("answers a hook ask through the direct command, never with always-allow", async () => {
    render(<IslandPermissionActions pending={pending()} />)
    fireEvent.click(screen.getByTestId("permission-allow"))
    await waitFor(() => expect(respondMock).toHaveBeenCalledWith("req-1", "allow"))
  })
})
