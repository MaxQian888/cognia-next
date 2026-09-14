/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { renderHook } from "@testing-library/react"

import {
  BotExecutorIcon,
  BotOrphanBadge,
  BotSourceIcon,
  BotStatusBadge,
  BotStatusDot,
  BotTriggerIcon,
  useBotIntervalText,
  useBotProblemText,
  useBotRelativeTime,
} from "./bot-visuals"

describe("BotStatusBadge", () => {
  it("names the status and carries it for a test to select on", () => {
    render(<BotStatusBadge status="needs_setup" />)
    const badge = screen.getByTestId("bot-status-badge")
    expect(badge).toHaveAttribute("data-status", "needs_setup")
    expect(badge).toHaveTextContent("Needs setup")
  })

  it("tints needs_setup amber rather than red, because it is a task", () => {
    render(<BotStatusBadge status="needs_setup" />)
    expect(screen.getByTestId("bot-status-badge").className).toContain("amber")
  })
})

describe("BotStatusDot", () => {
  it("labels itself, so the state is not colour-only", () => {
    render(<BotStatusDot status="disabled" />)
    expect(screen.getByRole("img", { name: "Disabled" })).toBeInTheDocument()
  })
})

describe("BotOrphanBadge", () => {
  it("says the definition is missing rather than borrowing the disabled word", () => {
    // A user who reads "disabled" reaches for a switch, and there is no switch
    // that brings a missing plugin back.
    render(<BotOrphanBadge />)
    expect(screen.getByTestId("bot-orphan-badge")).toHaveTextContent("Definition missing")
  })
})

describe("icons", () => {
  it("labels the executor, the trigger kind and the source", () => {
    render(
      <>
        <BotExecutorIcon executor="agent-turn" />
        <BotTriggerIcon kind="derivedState" />
        <BotSourceIcon source="plugin" />
      </>
    )
    expect(screen.getByRole("img", { name: "Agent turn" })).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "State change" })).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "Plugin" })).toBeInTheDocument()
  })

  it("gives each executor its own glyph", () => {
    // Four executors sharing one icon is the same failure as two rail entries
    // sharing one: the reader cannot tell what a run will cost.
    const { container } = render(
      <>
        <BotExecutorIcon executor="workflow" />
        <BotExecutorIcon executor="squad" />
        <BotExecutorIcon executor="agent-turn" />
        <BotExecutorIcon executor="handler" />
      </>
    )
    const paths = [...container.querySelectorAll("svg")].map((svg) => svg.innerHTML)
    expect(new Set(paths).size).toBe(4)
  })
})

describe("useBotIntervalText", () => {
  it("picks the largest unit that fits, so a poll reads as one figure", () => {
    const { result } = renderHook(() => useBotIntervalText())
    expect(result.current(45_000)).toBe("Every 45s")
    expect(result.current(300_000)).toBe("Every 5m")
    expect(result.current(7_200_000)).toBe("Every 2h")
  })

  it("refuses a nonsense interval instead of printing Every 0s", () => {
    const { result } = renderHook(() => useBotIntervalText())
    expect(result.current(0)).toBe("Not available")
    expect(result.current(Number.NaN)).toBe("Not available")
  })
})

describe("useBotProblemText", () => {
  it("marks only the handler failure severe, because only it stops the Bot", () => {
    const { result } = renderHook(() => useBotProblemText())
    expect(
      result.current({ kind: "version_drift", pinned: "1.0.0", available: "1.1.0" })
    ).toMatchObject({ severe: false })
    expect(result.current({ kind: "handler_missing", definitionId: "a:b" })).toMatchObject({
      severe: true,
    })
  })

  it("names both versions in the drift message", () => {
    const { result } = renderHook(() => useBotProblemText())
    const { text } = result.current({ kind: "version_drift", pinned: "1.0.0", available: "1.1.0" })
    expect(text).toContain("1.0.0")
    expect(text).toContain("1.1.0")
  })
})

describe("useBotRelativeTime", () => {
  it("provides a refreshable clock when the locale provider has no global now", () => {
    const intl = jest.requireMock<typeof import("next-intl")>("next-intl")
    const now = new Date("2026-09-12T12:00:00Z")
    const relativeTime = jest.fn(() => "one minute ago")
    const clock = jest.spyOn(intl, "useNow").mockReturnValue(now)
    const formatter = jest.spyOn(intl, "useFormatter").mockReturnValue({
      relativeTime,
    } as unknown as ReturnType<typeof intl.useFormatter>)
    try {
      const { result } = renderHook(() => useBotRelativeTime())
      expect(result.current(now.getTime() - 60_000)).toBe("one minute ago")
      expect(clock).toHaveBeenCalledWith({ updateInterval: 60_000 })
      expect(relativeTime).toHaveBeenCalledWith(new Date(now.getTime() - 60_000), now)
    } finally {
      formatter.mockRestore()
      clock.mockRestore()
    }
  })

  it("says never rather than printing the epoch", () => {
    const { result } = renderHook(() => useBotRelativeTime())
    expect(result.current(undefined)).toBe("Never")
    expect(result.current(0)).toBe("Never")
    expect(result.current(1_700_000_000_000)).not.toBe("Never")
  })
})
