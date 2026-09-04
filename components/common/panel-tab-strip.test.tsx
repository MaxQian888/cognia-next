/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { PanelTabStrip, type PanelTab } from "./panel-tab-strip"

type TabId = "overview" | "audit" | "inspector"

const TABS: PanelTab<TabId>[] = [
  { id: "overview", label: "Overview" },
  { id: "audit", label: "Audit" },
  { id: "inspector", label: "Inspector" },
]

describe("PanelTabStrip", () => {
  it("renders one trigger per tab and marks the active one", () => {
    render(<PanelTabStrip tabs={TABS} value="audit" onValueChange={() => {}} />)
    expect(screen.getAllByRole("tab")).toHaveLength(3)
    expect(screen.getByTestId("panel-tab-audit")).toHaveAttribute("data-state", "active")
    expect(screen.getByTestId("panel-tab-overview")).toHaveAttribute("data-state", "inactive")
  })

  it("reports the picked tab id", async () => {
    const onValueChange = jest.fn()
    render(<PanelTabStrip tabs={TABS} value="overview" onValueChange={onValueChange} />)
    await userEvent.click(screen.getByTestId("panel-tab-inspector"))
    expect(onValueChange).toHaveBeenCalledWith("inspector")
  })

  /**
   * The whole point of the primitive. A bare `TabsList` keeps `w-fit` with
   * `whitespace-nowrap` triggers and overflows a narrow pane. This one caps the
   * list and lets every trigger shrink and truncate instead.
   */
  it("caps the list and lets every trigger shrink rather than scroll", () => {
    render(<PanelTabStrip tabs={TABS} value="overview" onValueChange={() => {}} />)
    const list = screen.getByRole("tablist")
    expect(list.className).toContain("max-w-full")
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).toContain("min-w-0")
      expect(tab.className).toContain("flex-initial")
      const label = tab.querySelector("span")
      expect(label?.className).toContain("truncate")
    }
  })

  it("renders an icon and a badge when the tab declares them", () => {
    const Icon = ({ className }: { className?: string }) => (
      <svg data-testid="tab-icon" className={className} />
    )
    render(
      <PanelTabStrip
        tabs={[
          { id: "overview", label: "Overview", icon: Icon },
          { id: "audit", label: "Audit", badge: <span data-testid="tab-badge">3</span> },
        ]}
        value="overview"
        onValueChange={() => {}}
      />
    )
    expect(screen.getByTestId("tab-icon")).toBeInTheDocument()
    expect(screen.getByTestId("tab-badge")).toHaveTextContent("3")
  })

  it("only wraps the list when a wrapper class is given", () => {
    const { rerender } = render(
      <PanelTabStrip tabs={TABS} value="overview" onValueChange={() => {}} />
    )
    expect(screen.getByRole("tablist").parentElement).toHaveAttribute("data-slot", "tabs")

    rerender(
      <PanelTabStrip
        tabs={TABS}
        value="overview"
        onValueChange={() => {}}
        listWrapperClassName="mx-4"
      />
    )
    expect(screen.getByRole("tablist").parentElement).toHaveClass("mx-4")
  })

  it("renders content children alongside the strip", () => {
    render(
      <PanelTabStrip tabs={TABS} value="overview" onValueChange={() => {}}>
        <div data-testid="panel-body">body</div>
      </PanelTabStrip>
    )
    expect(screen.getByTestId("panel-body")).toBeInTheDocument()
  })

  /**
   * Truncating six labels into "O.." and "P.." stops the strip overflowing
   * without making it readable. Below `sm` the icons carry the inactive tabs
   * and only the selected one keeps its text.
   */
  it("keeps only the selected label when the strip is narrow", () => {
    const Icon = () => <svg />
    render(
      <PanelTabStrip
        tabs={TABS.map((tab) => ({ ...tab, icon: Icon }))}
        value="audit"
        onValueChange={() => {}}
      />
    )
    const label = (id: string) => screen.getByTestId(`panel-tab-${id}`).querySelector("span")
    expect(label("audit")?.className).not.toContain("max-sm:hidden")
    expect(label("overview")?.className).toContain("max-sm:hidden")
    expect(label("inspector")?.className).toContain("max-sm:hidden")
  })

  it("keeps the text of a tab that has no icon to fall back to", () => {
    render(<PanelTabStrip tabs={TABS} value="audit" onValueChange={() => {}} />)
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.querySelector("span")?.className).not.toContain("max-sm:hidden")
    }
  })

  it("names every tab in full even where the label is not painted", () => {
    const Icon = () => <svg />
    render(
      <PanelTabStrip
        tabs={TABS.map((tab) => ({ ...tab, icon: Icon }))}
        value="audit"
        onValueChange={() => {}}
      />
    )
    expect(screen.getByRole("tab", { name: "Overview" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Inspector" })).toBeInTheDocument()
  })
})
