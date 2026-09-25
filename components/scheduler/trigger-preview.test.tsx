/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import { TriggerPreview } from "./trigger-preview"

const now = new Date("2026-09-25T00:00:00Z")

describe("TriggerPreview", () => {
  it("lists the next three fire times of a cron", () => {
    render(
      <TriggerPreview
        trigger={{ type: "cron", cronExpression: "0 9 * * *", timezone: "UTC" }}
        now={now}
      />
    )
    expect(screen.getByTestId("trigger-preview")).toHaveAttribute("data-state", "dates")
    expect(screen.getByText("Next 3 runs")).toBeInTheDocument()
    expect(screen.getAllByTestId("trigger-preview-date")).toHaveLength(3)
  })

  it("labels a pinned zone so a foreign wall clock is not mistaken for local time", () => {
    render(
      <TriggerPreview
        trigger={{ type: "cron", cronExpression: "0 9 * * *", timezone: "Asia/Shanghai" }}
        now={now}
        count={1}
      />
    )
    expect(screen.getByText("Next run")).toBeInTheDocument()
    expect(screen.getByTestId("trigger-preview-date").textContent).toMatch(/09:00/)
  })

  it("explains instead of listing when there is nothing to list", () => {
    const { rerender } = render(
      <TriggerPreview trigger={{ type: "event", eventType: "chat:completed" }} now={now} />
    )
    expect(screen.getByTestId("trigger-preview")).toHaveAttribute("data-state", "event")
    expect(screen.getByTestId("trigger-preview-message")).toHaveTextContent(/event fires/)

    rerender(<TriggerPreview trigger={{ type: "cron", cronExpression: "nope" }} now={now} />)
    expect(screen.getByTestId("trigger-preview")).toHaveAttribute("data-state", "invalid")

    rerender(
      <TriggerPreview
        trigger={{ type: "once", runAt: new Date("2026-09-24T00:00:00Z") }}
        now={now}
      />
    )
    expect(screen.getByTestId("trigger-preview")).toHaveAttribute("data-state", "past")
  })

  it("renders nothing without a trigger", () => {
    const { container } = render(<TriggerPreview trigger={null} now={now} />)
    expect(container).toBeEmptyDOMElement()
  })
})
