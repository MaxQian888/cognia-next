import { fireEvent, render, screen } from "@testing-library/react"
import { PetBubbleView } from "./pet-bubble"

describe("PetBubbleView", () => {
  it("renders nothing when there is no bubble", () => {
    const { container } = render(<PetBubbleView bubble={null} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders the text and origin", () => {
    render(<PetBubbleView bubble={{ text: "Mrrp!", origin: "llm" }} />)
    const el = screen.getByRole("status")
    expect(el).toHaveTextContent("Mrrp!")
    expect(el).toHaveAttribute("data-bubble-origin", "llm")
  })

  const withAction = {
    text: "A new radar report is in.",
    origin: "system" as const,
    action: { kind: "open-console" as const, tab: "insights" as const },
  }

  it("offers no button when the host gives it nothing to do", () => {
    // A surface that cannot act shows the text alone rather than a dead button.
    render(<PetBubbleView bubble={withAction} />)
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByRole("status")).toHaveTextContent("A new radar report is in.")
  })

  it("renders the action as a labelled button that runs it on click", () => {
    const onAction = jest.fn()
    render(<PetBubbleView bubble={withAction} onAction={onAction} />)
    const button = screen.getByRole("button", { name: "Open Insights" })
    fireEvent.click(button)
    expect(onAction).toHaveBeenCalledWith({ kind: "open-console", tab: "insights" })
  })

  it("is a real, focusable button, so the keyboard reaches it and nothing steals focus", () => {
    render(<PetBubbleView bubble={withAction} onAction={jest.fn()} />)
    const button = screen.getByRole("button", { name: "Open Insights" })
    expect(button).toHaveAttribute("type", "button")
    // Rendering must not move focus onto it: a bubble appearing mid-typing
    // would otherwise swallow the next keystroke.
    expect(document.activeElement).not.toBe(button)
    button.focus()
    expect(document.activeElement).toBe(button)
  })

  it("renders no button for a bubble without an action, even with a handler", () => {
    render(<PetBubbleView bubble={{ text: "hi", origin: "template" }} onAction={jest.fn()} />)
    expect(screen.queryByRole("button")).toBeNull()
  })
})
