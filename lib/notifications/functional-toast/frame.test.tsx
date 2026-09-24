/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"

import { FunctionalToast } from "./frame"
import type { FunctionalToastSpec } from "./types"

function spec(overrides: Partial<FunctionalToastSpec> = {}): FunctionalToastSpec {
  return {
    icon: <span data-testid="icon" />,
    eyebrow: { text: "Due now", tone: "live", pulse: true },
    title: "Provider diagnostics refresh",
    body: <div data-testid="body" />,
    footnote: "Run #129 starting",
    actions: [
      { id: "open", label: "Open", strong: true },
      { id: "mute", label: "Mute" },
    ],
    accentClass: "bg-primary",
    ...overrides,
  }
}

describe("FunctionalToast", () => {
  it("renders eyebrow, title, body, footnote and actions", () => {
    render(
      <FunctionalToast
        spec={spec()}
        onAction={jest.fn()}
        onDismiss={jest.fn()}
        dismissLabel="Dismiss"
      />
    )
    expect(screen.getByText("Due now")).toBeInTheDocument()
    expect(screen.getByText("Provider diagnostics refresh")).toBeInTheDocument()
    expect(screen.getByTestId("body")).toBeInTheDocument()
    expect(screen.getByText("Run #129 starting")).toBeInTheDocument()
    expect(screen.getByText("Open")).toBeInTheDocument()
    expect(screen.getByText("Mute")).toBeInTheDocument()
  })

  it("dispatches the clicked action spec, not just the id", () => {
    const onAction = jest.fn()
    render(
      <FunctionalToast
        spec={spec()}
        onAction={onAction}
        onDismiss={jest.fn()}
        dismissLabel="Dismiss"
      />
    )
    fireEvent.click(screen.getByText("Mute"))
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: "mute", label: "Mute" }))
  })

  it("caps the action row at three", () => {
    render(
      <FunctionalToast
        spec={spec({
          actions: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
            { id: "c", label: "C" },
            { id: "d", label: "D" },
          ],
        })}
        onAction={jest.fn()}
        onDismiss={jest.fn()}
        dismissLabel="Dismiss"
      />
    )
    expect(screen.queryByText("D")).not.toBeInTheDocument()
  })

  it("dismisses via the corner button with the host-supplied label", () => {
    const onDismiss = jest.fn()
    render(
      <FunctionalToast
        spec={spec()}
        onAction={jest.fn()}
        onDismiss={onDismiss}
        dismissLabel="Close me"
      />
    )
    fireEvent.click(screen.getByLabelText("Close me"))
    expect(onDismiss).toHaveBeenCalled()
  })

  it("omits the footer row and accent strip when the spec leaves them out", () => {
    const { container } = render(
      <FunctionalToast
        spec={spec({ footnote: undefined, actions: undefined, accentClass: undefined })}
        onAction={jest.fn()}
        onDismiss={jest.fn()}
        dismissLabel="Dismiss"
      />
    )
    expect(container.querySelector(".bg-primary")).toBeNull()
    expect(screen.queryByText("Open")).not.toBeInTheDocument()
  })
})
