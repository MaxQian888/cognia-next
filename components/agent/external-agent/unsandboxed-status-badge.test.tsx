/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"

import { UnsandboxedStatusBadge } from "./unsandboxed-status-badge"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

function renderBadge(props: React.ComponentProps<typeof UnsandboxedStatusBadge>) {
  return render(
    <TooltipProvider>
      <UnsandboxedStatusBadge {...props} />
    </TooltipProvider>
  )
}

describe("UnsandboxedStatusBadge", () => {
  it("renders nothing for a sandboxed agent", () => {
    const { container } = renderBadge({ unsandboxed: false })
    // Call sites mount this unconditionally rather than each re-deriving the
    // condition, which is the kind of duplicated predicate that drifts.
    expect(container).toBeEmptyDOMElement()
  })

  it("stays visible while the agent runs without a sandbox", () => {
    renderBadge({ unsandboxed: true })
    expect(screen.getByTestId("unsandboxed-status-badge")).toHaveTextContent("badge")
  })

  it("names the executable the consent was granted for on hover", async () => {
    const user = userEvent.setup()
    renderBadge({ unsandboxed: true, executablePath: "C:\\tools\\npx.cmd" })

    await user.hover(screen.getByTestId("unsandboxed-status-badge"))

    const tooltips = await screen.findAllByText("badgeTooltip")
    expect(tooltips.length).toBeGreaterThan(0)
    expect(screen.getAllByText("C:\\tools\\npx.cmd").length).toBeGreaterThan(0)
  })

  it("still explains itself with no executable path recorded", async () => {
    const user = userEvent.setup()
    renderBadge({ unsandboxed: true })

    await user.hover(screen.getByTestId("unsandboxed-status-badge"))

    expect((await screen.findAllByText("badgeTooltip")).length).toBeGreaterThan(0)
  })

  it("accepts a caller className without losing its own layout", () => {
    renderBadge({ unsandboxed: true, className: "ml-2" })
    const badge = screen.getByTestId("unsandboxed-status-badge")
    expect(badge).toHaveClass("ml-2")
    expect(badge).toHaveClass("gap-1")
  })
})
