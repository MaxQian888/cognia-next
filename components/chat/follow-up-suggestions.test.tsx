import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { FollowUpSuggestions } from "./follow-up-suggestions"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

describe("FollowUpSuggestions", () => {
  it("renders nothing without predictions", () => {
    const { container } = render(
      <FollowUpSuggestions suggestions={[]} onAccept={jest.fn()} onDismiss={jest.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("accepts a selected prediction without invoking dismiss itself", async () => {
    const user = userEvent.setup()
    const onAccept = jest.fn()
    const onDismiss = jest.fn()
    render(
      <FollowUpSuggestions
        suggestions={["Tell me more", "Show an example"]}
        onAccept={onAccept}
        onDismiss={onDismiss}
      />
    )
    await user.click(screen.getByText("Show an example"))
    expect(onAccept).toHaveBeenCalledWith("Show an example")
    expect(onDismiss).not.toHaveBeenCalled()
    expect(screen.getByText("acceptHint")).toBeInTheDocument()
  })

  it("explains explicitly selected direct sending", () => {
    render(
      <FollowUpSuggestions
        suggestions={["Continue"]}
        onAccept={jest.fn()}
        onDismiss={jest.fn()}
        directSend
      />
    )
    expect(screen.getByText("sendHint")).toBeInTheDocument()
  })

  it("explains unavailable predictions and offers configuration plus retry", async () => {
    const onConfigure = jest.fn()
    const onRetry = jest.fn()
    render(
      <FollowUpSuggestions
        suggestions={[]}
        onAccept={jest.fn()}
        onDismiss={jest.fn()}
        status="unavailable"
        onConfigure={onConfigure}
        onRetry={onRetry}
      />
    )
    expect(screen.getByRole("status")).toHaveTextContent("unavailable")
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "configure" }))
    await user.click(screen.getByRole("button", { name: "retry" }))
    expect(onConfigure).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("keeps errors recoverable without offering configuration as their cause", () => {
    render(
      <FollowUpSuggestions
        suggestions={[]}
        onAccept={jest.fn()}
        onDismiss={jest.fn()}
        status="error"
        onConfigure={jest.fn()}
        onRetry={jest.fn()}
      />
    )
    expect(screen.getByRole("status")).toHaveTextContent("error")
    expect(screen.queryByRole("button", { name: "configure" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument()
  })

  it("dismisses using the labelled close button", async () => {
    const user = userEvent.setup()
    const onDismiss = jest.fn()
    render(
      <FollowUpSuggestions suggestions={["Continue"]} onAccept={jest.fn()} onDismiss={onDismiss} />
    )
    await user.click(screen.getByRole("button", { name: "dismiss" }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
