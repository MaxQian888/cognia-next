/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InboxIcon } from "lucide-react"

import { EmptyState } from "./empty-state"

describe("<EmptyState />", () => {
  it("renders the title and (optional) description", () => {
    render(<EmptyState title="No items" description="Add one to get started." />)
    expect(screen.getByText("No items")).toBeInTheDocument()
    expect(screen.getByText("Add one to get started.")).toBeInTheDocument()
  })

  it("renders an icon when provided", () => {
    render(<EmptyState icon={InboxIcon} title="No mail" />)
    expect(screen.getByTestId("empty-state-icon")).toBeInTheDocument()
  })

  it("renders a larger companion illustration instead of the Lucide fallback", () => {
    render(<EmptyState icon={InboxIcon} spotIcon="chat" title="No conversations" />)

    expect(screen.getByTestId("mobile-spot-icon-chat")).toHaveAttribute(
      "src",
      "/icons/cognia-mobile-spots/png/chat.png"
    )
    expect(screen.queryByTestId("empty-state-icon")).not.toBeInTheDocument()
  })

  it("renders no icon slot when none is provided", () => {
    render(<EmptyState title="No mail" />)
    expect(screen.queryByTestId("empty-state-icon")).not.toBeInTheDocument()
  })

  it("invokes the cta callback when the button is clicked", async () => {
    const user = userEvent.setup()
    const onSelect = jest.fn()
    render(<EmptyState title="Empty" cta={{ label: "Create", onSelect, testId: "create-cta" }} />)
    await user.click(screen.getByTestId("create-cta"))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it("renders arbitrary children below the body", () => {
    render(
      <EmptyState title="Empty">
        <span data-testid="extra-slot">Extra</span>
      </EmptyState>
    )
    expect(screen.getByTestId("extra-slot")).toBeInTheDocument()
  })
})
