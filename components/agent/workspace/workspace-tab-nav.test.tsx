/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { WorkspaceTabNav, WORKSPACE_TABS } from "./workspace-tab-nav"

// Use the shared manual mock for the shadcn sidebar so the menu renders as
// plain queryable buttons without mounting the real SidebarProvider context.
jest.mock("@/components/ui/sidebar")

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `tab.${key}`,
}))

const noop = () => {}

describe("WorkspaceTabNav", () => {
  it("renders a menu button for every workspace tab", () => {
    render(<WorkspaceTabNav value="overview" onValueChange={noop} onBack={noop} />)
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

  it("calls onValueChange with the tab value when a tab is clicked", () => {
    const onValueChange = jest.fn()
    render(<WorkspaceTabNav value="overview" onValueChange={onValueChange} onBack={noop} />)
    fireEvent.click(screen.getByTestId("tab-activity"))
    expect(onValueChange).toHaveBeenCalledWith("activity")
  })

  it("calls onBack when the back button is pressed", () => {
    const onBack = jest.fn()
    render(<WorkspaceTabNav value="overview" onValueChange={noop} onBack={onBack} />)
    fireEvent.click(screen.getByTestId("workspace-back"))
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it("renders a count badge only for tabs present in `counts`", () => {
    render(
      <WorkspaceTabNav
        value="overview"
        onValueChange={noop}
        onBack={noop}
        counts={{ members: 3 }}
      />
    )
    expect(screen.getByTestId("tab-members-count").textContent).toBe("3")
    expect(screen.queryByTestId("tab-tasks-count")).not.toBeInTheDocument()
  })

  it("renders the team name in the rail header", () => {
    render(
      <WorkspaceTabNav value="overview" onValueChange={noop} onBack={noop} teamName="Squad Alpha" />
    )
    expect(screen.getByText("Squad Alpha")).toBeInTheDocument()
  })
})
