/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { Tabs } from "@/components/ui/tabs"
import { WorkspaceTabNav, WORKSPACE_TABS } from "./workspace-tab-nav"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `tab.${key}`,
}))

function renderNav() {
  return render(
    <Tabs value="overview">
      <WorkspaceTabNav />
    </Tabs>
  )
}

describe("WorkspaceTabNav", () => {
  it("renders a trigger for every workspace tab", () => {
    renderNav()
    for (const { value } of WORKSPACE_TABS) {
      expect(screen.getByTestId(`tab-${value}`)).toBeInTheDocument()
    }
  })

  it("exposes the six canonical tabs in order", () => {
    expect(WORKSPACE_TABS.map((t) => t.value)).toEqual([
      "overview",
      "tasks",
      "chat",
      "activity",
      "members",
      "settings",
    ])
  })

  it("applies the desktop vertical-sidebar classes to the list", () => {
    const { container } = renderNav()
    const list = container.querySelector('[role="tablist"]')
    // Collapses to a left rail at lg; stays a horizontal strip below.
    expect(list?.className).toContain("lg:flex-col")
    expect(list?.className).toContain("lg:w-48")
  })

  it("keeps each trigger label hidden on mobile but the icon visible", () => {
    renderNav()
    const overview = screen.getByTestId("tab-overview")
    const label = overview.querySelector("span")
    expect(label?.className).toContain("hidden")
    expect(label?.className).toContain("sm:inline")
    // The lucide icon renders as an svg and is always present.
    expect(overview.querySelector("svg")).toBeInTheDocument()
  })
})
