/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import { PerfHostUnavailable } from "./perf-host-unavailable"

describe("PerfHostUnavailable", () => {
  it("says a web runtime has no host, even when the lease recorded an issue", () => {
    render(
      <PerfHostUnavailable
        hostState="unsupported"
        issue={{ kind: "unreachable", detail: "no transport" }}
        section="processes"
      />
    )
    const panel = screen.getByTestId("perf-host-unavailable-processes")
    expect(panel).toHaveTextContent("Processes need a host")
    expect(panel).toHaveTextContent("This runtime has no host to measure")
    expect(panel).toHaveAttribute("data-state", "unsupported")
  })

  it("names a typed lease issue while connecting", () => {
    render(
      <PerfHostUnavailable
        hostState="connecting"
        issue={{ kind: "contended", code: "device-purpose-limit", detail: "busy" }}
        section="runtime"
      />
    )
    expect(screen.getByTestId("perf-host-unavailable-runtime")).toHaveTextContent(
      "Another window holds the host's metrics stream"
    )
  })

  it("distinguishes a section the connected host does not report", () => {
    render(<PerfHostUnavailable hostState="live" section="runtime" notReported />)
    const panel = screen.getByTestId("perf-host-unavailable-runtime")
    expect(panel).toHaveTextContent("does not report this")
    expect(panel).toHaveAttribute("data-state", "not-reported")
  })

  it("offers a jump to the source details when given one", () => {
    const onOpenDiagnose = jest.fn()
    render(
      <PerfHostUnavailable hostState="stale" section="managed" onOpenDiagnose={onOpenDiagnose} />
    )
    fireEvent.click(screen.getByText("See source details"))
    expect(onOpenDiagnose).toHaveBeenCalledTimes(1)
  })
})
