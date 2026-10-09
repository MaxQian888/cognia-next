import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PET_CONSOLE_TABS, type PetConsoleTab } from "@/lib/pet/console-tabs"
import { PET_CONSOLE_NAV_GROUPS, PetConsoleNav } from "./pet-console-nav"

const WITHOUT_PLUGINS = PET_CONSOLE_TABS.filter((id) => id !== "plugins")

function Harness({
  visibleTabs = WITHOUT_PLUGINS,
  orientation = "vertical",
  desktopOnlyTabs,
}: {
  visibleTabs?: readonly PetConsoleTab[]
  orientation?: "horizontal" | "vertical"
  desktopOnlyTabs?: ReadonlySet<PetConsoleTab>
}) {
  const [tab, setTab] = useState<string>("nurture")
  return (
    <TooltipProvider>
      <Tabs value={tab} onValueChange={setTab} orientation={orientation}>
        <PetConsoleNav visibleTabs={visibleTabs} desktopOnlyTabs={desktopOnlyTabs} />
        {visibleTabs.map((id) => (
          <TabsContent key={id} value={id}>
            panel-{id}
          </TabsContent>
        ))}
      </Tabs>
    </TooltipProvider>
  )
}

describe("PetConsoleNav", () => {
  it("is a real tablist whose tabs control real tabpanels", () => {
    render(<Harness />)
    const list = screen.getByRole("tablist", { name: /pet navigation|console\.navigation/i })
    const tabs = within(list).getAllByRole("tab")
    expect(tabs).toHaveLength(WITHOUT_PLUGINS.length)
    const nurture = within(list).getByRole("tab", { name: /nurture/i })
    expect(nurture).toHaveAttribute("aria-selected", "true")
    const panel = screen.getByRole("tabpanel")
    expect(nurture.getAttribute("aria-controls")).toBe(panel.id)
    expect(panel).toHaveTextContent("panel-nurture")
  })

  it("switches tabs with one click", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("tab", { name: /shop/i }))
    expect(screen.getByRole("tabpanel")).toHaveTextContent("panel-shop")
  })

  it("moves between tabs with the arrow keys along the rail", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    act(() => screen.getByRole("tab", { name: /nurture/i }).focus())
    await user.keyboard("{ArrowDown}")
    expect(screen.getByRole("tab", { name: /chat/i })).toHaveFocus()
    expect(screen.getByRole("tabpanel")).toHaveTextContent("panel-chat")
  })

  it("moves with left/right on the horizontal phone strip", async () => {
    const user = userEvent.setup()
    render(<Harness orientation="horizontal" />)
    act(() => screen.getByRole("tab", { name: /nurture/i }).focus())
    await user.keyboard("{ArrowRight}")
    expect(screen.getByRole("tab", { name: /chat/i })).toHaveFocus()
  })

  it("labels each group and separates groups after the first", () => {
    render(<Harness />)
    for (const group of ["nurture", "personalize", "records"]) {
      expect(document.querySelector(`[data-nav-group="${group}"]`)).not.toBeNull()
    }
    // No extensions group without the plugins tab, and no separator before
    // the first group.
    expect(document.querySelector('[data-nav-group="extensions"]')).toBeNull()
    expect(document.querySelector('[data-nav-separator="nurture"]')).toBeNull()
    expect(document.querySelector('[data-nav-separator="records"]')).not.toBeNull()
  })

  it("adds the plugins tab only when it is visible", () => {
    render(<Harness visibleTabs={PET_CONSOLE_TABS} />)
    expect(screen.getByRole("tab", { name: /plugins/i })).toBeInTheDocument()
    expect(document.querySelector('[data-nav-group="extensions"]')).not.toBeNull()
  })

  it("keeps each label as the tab's accessible name for the icon rail", () => {
    render(<Harness />)
    const label = within(screen.getByRole("tab", { name: /journal/i })).getByText(/journal/i)
    expect(label).toHaveClass("md:sr-only")
  })

  it("covers every console tab in exactly one group", () => {
    const grouped = PET_CONSOLE_NAV_GROUPS.flatMap((group) => group.tabs)
    expect([...grouped].sort()).toEqual([...PET_CONSOLE_TABS].sort())
  })

  // Remote care (ADR-0219): desktop-only tabs stay listed, badged, and
  // selectable, so the reader learns where they live.
  it("badges desktop-only tabs and keeps them selectable", async () => {
    const user = userEvent.setup()
    render(<Harness desktopOnlyTabs={new Set<PetConsoleTab>(["customize", "insights"])} />)
    const customize = screen.getByRole("tab", { name: /customize/i })
    expect(customize).toHaveAttribute("data-desktop-only", "true")
    expect(within(customize).getByTestId("pet-console-desktop-badge")).toHaveTextContent("Desktop")
    expect(screen.getAllByTestId("pet-console-desktop-badge")).toHaveLength(2)
    expect(screen.getByRole("tab", { name: /^nurture$/i })).not.toHaveAttribute("data-desktop-only")
    await user.click(customize)
    expect(customize).toHaveAttribute("aria-selected", "true")
    expect(screen.getByText("panel-customize")).toBeInTheDocument()
  })

  it("badges nothing on the desktop", () => {
    render(<Harness />)
    expect(screen.queryByTestId("pet-console-desktop-badge")).toBeNull()
  })
})
