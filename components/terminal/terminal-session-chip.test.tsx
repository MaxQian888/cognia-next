/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react"

import type { TerminalControlState, TerminalReplayGap } from "@/lib/terminal/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const registry: {
  info: Record<string, unknown> | null
  takeControl: jest.Mock
  releaseControl: jest.Mock
  listeners: Set<() => void>
} = {
  info: null,
  takeControl: jest.fn(),
  releaseControl: jest.fn(),
  listeners: new Set(),
}

jest.mock("@/lib/terminal/session-registry", () => ({
  getLiveSession: () =>
    registry.info
      ? {
          info: registry.info,
          takeControl: registry.takeControl,
          releaseControl: registry.releaseControl,
        }
      : undefined,
  subscribeLiveSessions: (listener: () => void) => {
    registry.listeners.add(listener)
    return () => registry.listeners.delete(listener)
  },
}))

import { CHIP_AUTOHIDE_MS, TerminalSessionChip } from "./terminal-session-chip"

const controller: TerminalControlState = { role: "controller", controllerId: "local" }
const viewer: TerminalControlState = { role: "viewer", controllerId: "other" }

function sessionInfo(overrides: Record<string, unknown> = {}) {
  return { id: "s-1", sandboxed: false, currentController: null, ...overrides }
}

function renderChip(props: Partial<React.ComponentProps<typeof TerminalSessionChip>> = {}) {
  return render(
    <TerminalSessionChip sessionId="s-1" controlState={controller} replayGap={null} {...props} />
  )
}

beforeEach(() => {
  registry.info = sessionInfo()
  registry.takeControl.mockReset().mockResolvedValue(undefined)
  registry.releaseControl.mockReset().mockResolvedValue(undefined)
  registry.listeners.clear()
  jest.spyOn(window, "confirm").mockReturnValue(true)
})

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe("TerminalSessionChip", () => {
  it("renders nothing when there is no live session and no state to report", () => {
    registry.info = null
    renderChip()
    expect(screen.queryByTestId("terminal-session-chip")).toBeNull()
  })

  it("shows the highest-severity state as the headline", () => {
    // An unsandboxed session is `danger`; read-only is only `warn`.
    renderChip({ controlState: viewer })
    const chip = screen.getByTestId("terminal-session-chip")
    expect(chip).toHaveAttribute("data-severity", "danger")
    expect(chip).toHaveTextContent("fullHost")
  })

  it("prefers the sandboxed (info) badge when the session is sandboxed", () => {
    registry.info = sessionInfo({ sandboxed: true })
    renderChip()
    expect(screen.getByTestId("terminal-session-chip")).toHaveAttribute("data-severity", "info")
  })

  it("lists every active state in the popover so nothing is lost by collapsing", () => {
    const gap: TerminalReplayGap = { requestedAfter: 1, firstAvailable: 5, lastAvailable: 9 }
    registry.info = sessionInfo({ integrationCapabilities: { degradedReason: "no osc633" } })
    renderChip({ controlState: viewer, replayGap: gap, throttled: true })
    fireEvent.click(screen.getByTestId("terminal-session-chip"))
    const details = screen.getByTestId("terminal-session-chip-details")
    for (const key of ["readOnly", "replayGap", "fullHost", "degraded", "throttled"]) {
      expect(details.querySelector(`[data-state-key="${key}"]`)).not.toBeNull()
    }
  })

  it("distinguishes real flow control from renderer-side buffering", () => {
    renderChip({ throttled: true, flowControlSupported: true })
    fireEvent.click(screen.getByTestId("terminal-session-chip"))
    expect(screen.getByTestId("terminal-session-chip-details")).toHaveTextContent("outputThrottled")

    fireEvent.click(screen.getByTestId("terminal-session-chip"))
    screen.getByTestId("terminal-session-chip")
  })

  it("says output is only buffered when the transport has no flow control", () => {
    renderChip({ throttled: true, flowControlSupported: false })
    fireEvent.click(screen.getByTestId("terminal-session-chip"))
    expect(screen.getByTestId("terminal-session-chip-details")).toHaveTextContent(
      "outputThrottledBuffered"
    )
  })

  it("collapses to its dot after the autohide delay and re-expands on hover", () => {
    jest.useFakeTimers()
    renderChip()
    const chip = screen.getByTestId("terminal-session-chip")
    expect(chip).toHaveAttribute("data-collapsed", "false")

    act(() => {
      jest.advanceTimersByTime(CHIP_AUTOHIDE_MS + 10)
    })
    expect(screen.getByTestId("terminal-session-chip")).toHaveAttribute("data-collapsed", "true")

    fireEvent.mouseEnter(screen.getByTestId("terminal-session-chip"))
    expect(screen.getByTestId("terminal-session-chip")).toHaveAttribute("data-collapsed", "false")
  })

  it("offers take-control to a viewer and honours a declined confirm", () => {
    renderChip({ controlState: viewer })
    fireEvent.click(screen.getByTestId("terminal-session-chip"))

    jest.spyOn(window, "confirm").mockReturnValue(false)
    fireEvent.click(screen.getByTestId("terminal-chip-take-control"))
    expect(registry.takeControl).not.toHaveBeenCalled()

    jest.spyOn(window, "confirm").mockReturnValue(true)
    fireEvent.click(screen.getByTestId("terminal-chip-take-control"))
    expect(registry.takeControl).toHaveBeenCalledTimes(1)
  })

  it("offers release-control to the controller — the first UI to call it", () => {
    registry.info = sessionInfo({ currentController: "local" })
    renderChip({ controlState: controller })
    fireEvent.click(screen.getByTestId("terminal-session-chip"))
    fireEvent.click(screen.getByTestId("terminal-chip-release-control"))
    expect(registry.releaseControl).toHaveBeenCalledTimes(1)
  })

  it("hides release-control when nobody holds the lease", () => {
    registry.info = sessionInfo({ currentController: null })
    renderChip({ controlState: controller })
    fireEvent.click(screen.getByTestId("terminal-session-chip"))
    expect(screen.queryByTestId("terminal-chip-release-control")).toBeNull()
  })

  it("re-reads live session facts when the registry changes", () => {
    // The old badge cluster read `getLiveSession()` during render, so it kept
    // showing stale facts until something unrelated re-rendered the pane.
    renderChip()
    expect(screen.getByTestId("terminal-session-chip")).toHaveAttribute("data-severity", "danger")

    registry.info = sessionInfo({ sandboxed: true })
    act(() => {
      registry.listeners.forEach((listener) => listener())
    })
    expect(screen.getByTestId("terminal-session-chip")).toHaveAttribute("data-severity", "info")
  })
})
