/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { BackgroundedRunControls } from "./backgrounded-run-controls"

describe("BackgroundedRunControls — icon variant", () => {
  it("renders the abort icon while running and fires onAbort", () => {
    const onAbort = jest.fn()
    render(
      <BackgroundedRunControls
        variant="icon"
        isRunning
        onAbort={onAbort}
        abortAria="Abort"
        abortTestId="subagent-abort-x"
      />
    )
    const btn = screen.getByTestId("subagent-abort-x")
    expect(btn).toHaveAttribute("aria-label", "Abort")
    fireEvent.click(btn)
    expect(onAbort).toHaveBeenCalledTimes(1)
  })

  it("renders nothing when not running", () => {
    const { container } = render(
      <BackgroundedRunControls
        variant="icon"
        isRunning={false}
        onAbort={jest.fn()}
        abortTestId="a"
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing when no onAbort is provided", () => {
    const { container } = render(
      <BackgroundedRunControls variant="icon" isRunning onAbort={undefined} abortTestId="a" />
    )
    expect(container.firstChild).toBeNull()
  })
})

describe("BackgroundedRunControls — labeled variant", () => {
  it("renders collect + cancel while running and fires both handlers", () => {
    const onCollect = jest.fn()
    const onAbort = jest.fn()
    render(
      <BackgroundedRunControls
        variant="labeled"
        isRunning
        onCollect={onCollect}
        onAbort={onAbort}
        collectLabel="Collect"
        abortLabel="Cancel"
        collectTestId="job-collect-1"
        abortTestId="job-cancel-1"
      />
    )
    fireEvent.click(screen.getByTestId("job-collect-1"))
    fireEvent.click(screen.getByTestId("job-cancel-1"))
    expect(onCollect).toHaveBeenCalledTimes(1)
    expect(onAbort).toHaveBeenCalledTimes(1)
  })

  it("hides cancel once the run is settled but keeps collect", () => {
    render(
      <BackgroundedRunControls
        variant="labeled"
        isRunning={false}
        onCollect={jest.fn()}
        onAbort={jest.fn()}
        collectTestId="job-collect-1"
        abortTestId="job-cancel-1"
      />
    )
    expect(screen.getByTestId("job-collect-1")).toBeInTheDocument()
    expect(screen.queryByTestId("job-cancel-1")).toBeNull()
  })

  it("disables the buttons while their action is pending", () => {
    render(
      <BackgroundedRunControls
        variant="labeled"
        isRunning
        onCollect={jest.fn()}
        onAbort={jest.fn()}
        collecting
        aborting
        collectTestId="job-collect-1"
        abortTestId="job-cancel-1"
      />
    )
    expect(screen.getByTestId("job-collect-1")).toBeDisabled()
    expect(screen.getByTestId("job-cancel-1")).toBeDisabled()
  })
})
