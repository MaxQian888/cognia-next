import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { LOGS_NAV_GROUPS, LOGS_NAV_ITEMS } from "../nav-config"
import { LogsNav } from "./logs-nav"

function renderNav(overrides: Partial<React.ComponentProps<typeof LogsNav>> = {}) {
  const onSelect = jest.fn()
  render(
    <LogsNav groups={LOGS_NAV_GROUPS} activeId="overview" onSelect={onSelect} {...overrides} />
  )
  return { onSelect }
}

describe("LogsNav", () => {
  it("renders one row per panel, grouped", () => {
    renderNav()
    const list = screen.getByRole("list", { name: "Logging settings" })
    expect(within(list).getAllByRole("listitem")).toHaveLength(LOGS_NAV_ITEMS.length)
  })

  it("labels every group", () => {
    renderNav()
    expect(screen.getByTestId("logs-nav-group-statusGroup")).toHaveTextContent("Status")
    expect(screen.getByTestId("logs-nav-group-captureGroup")).toHaveTextContent("Capture")
    expect(screen.getByTestId("logs-nav-group-deliveryGroup")).toHaveTextContent("Delivery")
  })

  it("renders each row's label and description", () => {
    renderNav()
    const row = screen.getByTestId("logs-nav-item-transports")
    expect(row).toHaveTextContent("Transports")
    expect(row).toHaveTextContent("Where log entries are sent and stored")
  })

  it("marks the active panel for assistive tech", () => {
    renderNav({ activeId: "filters" })
    expect(screen.getByTestId("logs-nav-item-filters")).toHaveAttribute("aria-current", "true")
    expect(screen.getByTestId("logs-nav-item-overview")).not.toHaveAttribute("aria-current")
  })

  it("reports the selected panel id", async () => {
    const user = userEvent.setup()
    const { onSelect } = renderNav()

    await user.click(screen.getByTestId("logs-nav-item-retention"))

    expect(onSelect).toHaveBeenCalledWith("retention")
  })

  it("renders a badge with the meaning spelled out for screen readers", () => {
    renderNav({
      badges: { transports: { text: "6/7", variant: "secondary", ariaLabel: "6 of 7 enabled" } },
    })
    const badge = screen.getByTestId("logs-nav-badge-transports")
    expect(badge).toHaveTextContent("6/7")
    expect(badge).toHaveAttribute("aria-label", "6 of 7 enabled")
  })

  it("namespaces its test ids so the rail and the mobile sheet copy can coexist", () => {
    // Both are mounted while the sheet is open — the rail is only
    // `display:none` below `md`.
    renderNav({ idPrefix: "logs-sheet" })
    expect(screen.getByTestId("logs-sheet-nav-item-overview")).toBeInTheDocument()
  })
})
