/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { TeamRunControls } from "./team-run-controls"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

describe("TeamRunControls", () => {
  it("offers Start when idle and calls onStart", () => {
    const onStart = jest.fn()
    render(<TeamRunControls status="idle" onStart={onStart} />)
    expect(screen.getByTestId("team-run-controls")).toHaveAttribute("data-run-state", "idle")
    fireEvent.click(screen.getByTestId("start-team"))
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("abort-team")).not.toBeInTheDocument()
    expect(screen.queryByTestId("resume-team")).not.toBeInTheDocument()
  })

  it("treats completed as an idle, restartable state", () => {
    render(<TeamRunControls status="completed" onStart={jest.fn()} onAbort={jest.fn()} />)
    expect(screen.getByTestId("start-team")).toBeInTheDocument()
    expect(screen.queryByTestId("abort-team")).not.toBeInTheDocument()
  })

  it("shows the ultracode button only when ultracode is enabled and a handler is given", () => {
    const onStartUltracode = jest.fn()
    const { rerender } = render(
      <TeamRunControls status="idle" onStartUltracode={onStartUltracode} />
    )
    expect(screen.queryByTestId("start-team-ultracode")).not.toBeInTheDocument()

    // Enabled but no handler → still hidden.
    rerender(<TeamRunControls status="idle" ultracodeEnabled />)
    expect(screen.queryByTestId("start-team-ultracode")).not.toBeInTheDocument()

    rerender(<TeamRunControls status="idle" ultracodeEnabled onStartUltracode={onStartUltracode} />)
    fireEvent.click(screen.getByTestId("start-team-ultracode"))
    expect(onStartUltracode).toHaveBeenCalledTimes(1)
  })

  it.each(["executing", "planning"] as const)("offers Pause + Abort while %s", (status) => {
    const onPause = jest.fn()
    const onAbort = jest.fn()
    render(<TeamRunControls status={status} onPause={onPause} onAbort={onAbort} />)
    expect(screen.getByTestId("team-run-controls")).toHaveAttribute("data-run-state", "live")
    fireEvent.click(screen.getByTestId("pause-team"))
    expect(onPause).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId("abort-team"))
    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("start-team")).not.toBeInTheDocument()
  })

  it("omits Pause when no onPause is supplied but keeps Abort", () => {
    render(<TeamRunControls status="executing" onAbort={jest.fn()} />)
    expect(screen.queryByTestId("pause-team")).not.toBeInTheDocument()
    expect(screen.getByTestId("abort-team")).toBeInTheDocument()
  })

  it("offers Resume + Stop while paused", () => {
    const onResume = jest.fn()
    const onStop = jest.fn()
    render(<TeamRunControls status="paused" onResume={onResume} onStop={onStop} />)
    expect(screen.getByTestId("team-run-controls")).toHaveAttribute("data-run-state", "paused")
    fireEvent.click(screen.getByTestId("resume-team"))
    expect(onResume).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId("stop-team"))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("start-team")).not.toBeInTheDocument()
    expect(screen.queryByTestId("abort-team")).not.toBeInTheDocument()
  })

  it("omits Stop when no onStop is supplied but keeps Resume", () => {
    render(<TeamRunControls status="paused" onResume={jest.fn()} />)
    expect(screen.queryByTestId("stop-team")).not.toBeInTheDocument()
    expect(screen.getByTestId("resume-team")).toBeInTheDocument()
  })

  it("forwards className onto the wrapper", () => {
    render(<TeamRunControls status="idle" className="ml-auto" />)
    expect(screen.getByTestId("team-run-controls")).toHaveClass("ml-auto")
  })
})

/**
 * A control wired to `undefined` is worse than an absent one: it reads as "the
 * run refuses" rather than "this surface cannot". The mobile workspace shipped
 * exactly that — a paused team with an inert Resume button — because only Pause
 * and Stop were gated on their handlers.
 */
describe("no button without a handler", () => {
  it("omits Resume when the surface cannot resume", () => {
    render(<TeamRunControls status="paused" />)
    expect(screen.queryByTestId("resume-team")).not.toBeInTheDocument()
  })

  it("omits Start when the surface cannot start", () => {
    render(<TeamRunControls status="idle" />)
    expect(screen.queryByTestId("start-team")).not.toBeInTheDocument()
  })

  it("omits Abort when the surface cannot abort", () => {
    render(<TeamRunControls status="executing" />)
    expect(screen.queryByTestId("abort-team")).not.toBeInTheDocument()
  })

  it("still renders each one when its handler is supplied", () => {
    const { rerender } = render(<TeamRunControls status="paused" onResume={jest.fn()} />)
    expect(screen.getByTestId("resume-team")).toBeInTheDocument()
    rerender(<TeamRunControls status="idle" onStart={jest.fn()} />)
    expect(screen.getByTestId("start-team")).toBeInTheDocument()
    rerender(<TeamRunControls status="executing" onAbort={jest.fn()} />)
    expect(screen.getByTestId("abort-team")).toBeInTheDocument()
  })
})
