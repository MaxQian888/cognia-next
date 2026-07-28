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

let reducedMotion = false
jest.mock("motion/react", () => ({
  motion: {
    span: ({ children, ...props }: Record<string, unknown>) => {
      const { layoutId, transition: _t, ...rest } = props
      return (
        <span data-layout-id={layoutId as string} {...(rest as object)}>
          {children as React.ReactNode}
        </span>
      )
    },
  },
  useReducedMotion: () => reducedMotion,
}))

const noop = () => {}

beforeEach(() => {
  reducedMotion = false
})

describe("WorkspaceTabNav", () => {
  it("renders a menu button for every workspace tab", () => {
    render(<WorkspaceTabNav value="overview" onValueChange={noop} onBack={noop} />)
    for (const { value } of WORKSPACE_TABS) {
      expect(screen.getByTestId(`tab-${value}`)).toBeInTheDocument()
    }
  })

  it("exposes the eight canonical tabs in order", () => {
    expect(WORKSPACE_TABS.map((t) => t.value)).toEqual([
      "overview",
      "tasks",
      "chat",
      "activity",
      "worktrees",
      "editor",
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

  describe("active-tab indicator", () => {
    it("renders exactly one shared-layout pill, on the active tab", () => {
      const { container } = render(
        <WorkspaceTabNav value="tasks" onValueChange={noop} onBack={noop} />
      )
      const pills = container.querySelectorAll("[data-layout-id]")
      expect(pills).toHaveLength(1)
      // A single element sliding between stops is the whole point — a per-tab
      // pill would cross-fade instead and lose the sense of direction.
      expect(pills[0].getAttribute("data-layout-id")).toBe("agent-team-workspace-tab-indicator")
    })

    it("drops the pill entirely under reduced motion", () => {
      reducedMotion = true
      const { container } = render(
        <WorkspaceTabNav value="tasks" onValueChange={noop} onBack={noop} />
      )
      // SidebarMenuButton's own isActive styling still marks the tab, so the
      // pill is pure decoration once it cannot slide.
      expect(container.querySelectorAll("[data-layout-id]")).toHaveLength(0)
      expect(screen.getByTestId("tab-tasks")).toBeInTheDocument()
    })
  })

  describe("live signals", () => {
    it("renders a count badge from `signals`", () => {
      render(
        <WorkspaceTabNav
          value="overview"
          onValueChange={noop}
          onBack={noop}
          signals={{ chat: { count: 4 } }}
        />
      )
      expect(screen.getByTestId("tab-chat-count").textContent).toBe("4")
    })

    it("lets a signal count win over the same tab's `counts` entry", () => {
      render(
        <WorkspaceTabNav
          value="overview"
          onValueChange={noop}
          onBack={noop}
          counts={{ members: 3 }}
          signals={{ members: { count: 9 } }}
        />
      )
      expect(screen.getByTestId("tab-members-count").textContent).toBe("9")
    })

    it("falls back to `counts` when the signal carries no count", () => {
      render(
        <WorkspaceTabNav
          value="overview"
          onValueChange={noop}
          onBack={noop}
          counts={{ members: 3 }}
          signals={{ members: { live: true } }}
        />
      )
      expect(screen.getByTestId("tab-members-count").textContent).toBe("3")
    })

    it("omits the badge when the count is undefined (a zeroed unread must not read '0')", () => {
      render(
        <WorkspaceTabNav
          value="overview"
          onValueChange={noop}
          onBack={noop}
          signals={{ chat: { count: undefined } }}
        />
      )
      expect(screen.queryByTestId("tab-chat-count")).not.toBeInTheDocument()
    })

    it("shows a live dot on an inactive tab", () => {
      render(
        <WorkspaceTabNav
          value="overview"
          onValueChange={noop}
          onBack={noop}
          signals={{ activity: { live: true } }}
        />
      )
      expect(screen.getByTestId("tab-activity-live")).toBeInTheDocument()
    })

    it("suppresses the live dot on the tab you are already looking at", () => {
      render(
        <WorkspaceTabNav
          value="activity"
          onValueChange={noop}
          onBack={noop}
          signals={{ activity: { live: true } }}
        />
      )
      expect(screen.queryByTestId("tab-activity-live")).not.toBeInTheDocument()
    })

    it("leaves unsignalled tabs completely quiet", () => {
      render(
        <WorkspaceTabNav
          value="overview"
          onValueChange={noop}
          onBack={noop}
          signals={{ chat: { count: 2 } }}
        />
      )
      for (const { value } of WORKSPACE_TABS) {
        if (value === "chat") continue
        expect(screen.queryByTestId(`tab-${value}-count`)).not.toBeInTheDocument()
        expect(screen.queryByTestId(`tab-${value}-live`)).not.toBeInTheDocument()
      }
    })
  })
})
