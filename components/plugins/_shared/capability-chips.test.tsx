import userEvent from "@testing-library/user-event"
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

import { CapabilityChips } from "./capability-chips"

function renderWithIntl(node: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

describe("CapabilityChips", () => {
  it("renders all capabilities up to the limit (default 3)", () => {
    renderWithIntl(<CapabilityChips capabilities={["tools", "modes", "commands"]} />)
    expect(screen.getByText("tools")).toBeInTheDocument()
    expect(screen.getByText("modes")).toBeInTheDocument()
    expect(screen.getByText("commands")).toBeInTheDocument()
    expect(screen.queryByTestId("capability-overflow")).not.toBeInTheDocument()
  })

  it("renders nothing when the capabilities array is empty", () => {
    const { container } = renderWithIntl(<CapabilityChips capabilities={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders an overflow badge with the remaining count when above limit", () => {
    renderWithIntl(
      <CapabilityChips capabilities={["a", "b", "c", "d", "e"]} limit={3} hoverable={false} />
    )
    expect(screen.getByText("a")).toBeInTheDocument()
    expect(screen.getByText("c")).toBeInTheDocument()
    // overflow count = total - limit = 2
    expect(screen.getByTestId("capability-overflow")).toHaveTextContent("+2 more")
  })

  it("honors a custom limit", () => {
    renderWithIntl(
      <CapabilityChips capabilities={["a", "b", "c", "d", "e"]} limit={4} hoverable={false} />
    )
    expect(screen.getByTestId("capability-overflow")).toHaveTextContent("+1 more")
  })

  it("wraps the overflow badge in a hover trigger when hoverable=true", () => {
    renderWithIntl(
      <CapabilityChips capabilities={["a", "b", "c", "d", "e"]} limit={3} hoverable={true} />
    )
    const trigger = screen.getByRole("button", { name: /\+2 more/i })
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveAttribute("type", "button")
  })

  // The full list used to be a hover-only HoverCard; a tap now opens it.
  it("lists every capability when the overflow is tapped", async () => {
    const user = userEvent.setup()
    renderWithIntl(
      <CapabilityChips capabilities={["a", "b", "c", "d", "e"]} limit={3} hoverable={true} />
    )
    await user.click(screen.getByRole("button", { name: /\+2 more/i }))
    expect(await screen.findByText("e")).toBeInTheDocument()
  })
})
