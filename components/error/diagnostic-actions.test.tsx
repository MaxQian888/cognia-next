/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { DiagnosticAction } from "@cognia/diagnostics"

import { DiagnosticActions } from "./diagnostic-actions"

describe("DiagnosticActions", () => {
  it("labels each action from the shared i18n contract", () => {
    render(
      <DiagnosticActions
        actions={[{ kind: "retry" }, { kind: "view-logs" }]}
        handlers={{ retry: jest.fn(), "view-logs": jest.fn() }}
      />
    )
    expect(screen.getByTestId("diagnostic-action-retry")).toHaveTextContent("Retry")
    expect(screen.getByTestId("diagnostic-action-view-logs")).toHaveTextContent("View logs")
  })

  it("drops actions the caller cannot service rather than rendering dead buttons", () => {
    render(
      <DiagnosticActions
        actions={[{ kind: "retry" }, { kind: "restart-sidecar" }]}
        handlers={{ retry: jest.fn() }}
      />
    )
    expect(screen.getByTestId("diagnostic-action-retry")).toBeInTheDocument()
    expect(screen.queryByTestId("diagnostic-action-restart-sidecar")).not.toBeInTheDocument()
  })

  it("renders nothing when no action is serviceable", () => {
    const { container } = render(<DiagnosticActions actions={[{ kind: "retry" }]} handlers={{}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("interpolates the countdown into the wait-and-retry label", () => {
    render(
      <DiagnosticActions
        actions={[{ kind: "wait-and-retry", retryAfterMs: 45_000 }]}
        handlers={{ "wait-and-retry": jest.fn() }}
      />
    )
    expect(screen.getByTestId("diagnostic-action-wait-and-retry")).toHaveTextContent("45 seconds")
  })

  it("rounds a sub-second delay up to one second rather than showing zero", () => {
    render(
      <DiagnosticActions
        actions={[{ kind: "wait-and-retry", retryAfterMs: 400 }]}
        handlers={{ "wait-and-retry": jest.fn() }}
      />
    )
    expect(screen.getByTestId("diagnostic-action-wait-and-retry")).toHaveTextContent("1 second")
  })

  it("hands the full action to the handler so its payload survives", () => {
    const handler = jest.fn()
    const action: DiagnosticAction = { kind: "open-external", url: "https://x.test/docs" }
    render(<DiagnosticActions actions={[action]} handlers={{ "open-external": handler }} />)
    fireEvent.click(screen.getByTestId("diagnostic-action-open-external"))
    expect(handler).toHaveBeenCalledWith(action)
  })

  it("caps the rendered buttons, keeping the most useful ones", () => {
    // The registry orders actions most-useful-first, so truncating from the end
    // is what makes `max` safe for a cramped surface like a toast.
    render(
      <DiagnosticActions
        actions={[{ kind: "retry" }, { kind: "view-logs" }, { kind: "copy-report" }]}
        handlers={{ retry: jest.fn(), "view-logs": jest.fn(), "copy-report": jest.fn() }}
        max={2}
      />
    )
    expect(screen.getAllByRole("button")).toHaveLength(2)
    expect(screen.queryByTestId("diagnostic-action-copy-report")).not.toBeInTheDocument()
  })

  it("counts the cap against serviceable actions, not the raw list", () => {
    render(
      <DiagnosticActions
        actions={[{ kind: "restart-sidecar" }, { kind: "retry" }, { kind: "view-logs" }]}
        handlers={{ retry: jest.fn(), "view-logs": jest.fn() }}
        max={2}
      />
    )
    expect(screen.getAllByRole("button")).toHaveLength(2)
    expect(screen.getByTestId("diagnostic-action-view-logs")).toBeInTheDocument()
  })
})
