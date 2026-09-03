/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { PlusIcon, RefreshCwIcon } from "lucide-react"

jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    ...props
  }: {
    children: React.ReactNode
    onSelect?: () => void
    disabled?: boolean
    "data-testid"?: string
  }) => (
    <button
      type="button"
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect?.()
      }}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}))

import { FeaturePageHeader } from "./feature-page-header"
import { TooltipProvider } from "@/components/ui/tooltip"

function renderHeader(header: React.ReactNode) {
  return render(<TooltipProvider>{header}</TooltipProvider>)
}

test("renders the management identity, context, summary, actions, and controls", () => {
  const onCreate = jest.fn()
  const onRefresh = jest.fn()

  renderHeader(
    <FeaturePageHeader
      variant="management"
      icon={<PlusIcon data-testid="identity-icon" />}
      title="Workflows"
      description="Build and run repeatable automations"
      context={<span>Root folder</span>}
      status={<span>Ready</span>}
      summary={<span>12 workflows</span>}
      primaryAction={{
        id: "create",
        label: "New workflow",
        icon: PlusIcon,
        onSelect: onCreate,
      }}
      secondaryActions={[
        {
          id: "refresh",
          label: "Refresh",
          icon: RefreshCwIcon,
          onSelect: onRefresh,
        },
      ]}
      overflowLabel="More workflow actions"
      actions={<button type="button">Custom action</button>}
      navigation={<nav aria-label="Workflow views">Library</nav>}
      controls={<input aria-label="Search workflows" />}
    />
  )

  const header = screen.getByRole("banner")
  expect(header).toHaveAttribute("data-variant", "management")
  expect(screen.getByRole("heading", { name: "Workflows" })).toBeInTheDocument()
  expect(screen.getByText("Build and run repeatable automations")).toBeInTheDocument()
  expect(screen.getByText("Root folder")).toBeInTheDocument()
  expect(screen.getByText("Ready")).toBeInTheDocument()
  expect(screen.getByText("12 workflows")).toBeInTheDocument()
  expect(screen.getByTestId("identity-icon")).toBeInTheDocument()
  expect(screen.getByRole("navigation", { name: "Workflow views" })).toBeInTheDocument()
  expect(screen.getByRole("textbox", { name: "Search workflows" })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Custom action" })).toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "New workflow" }))
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  expect(onCreate).toHaveBeenCalledTimes(1)
  expect(onRefresh).toHaveBeenCalledTimes(1)
})

test("renders compact chrome without requiring a secondary row", () => {
  renderHeader(<FeaturePageHeader variant="compact" title="Source control" />)

  const header = screen.getByRole("banner")
  expect(header).toHaveAttribute("data-variant", "compact")
  expect(header).toHaveAttribute("data-has-secondary", "false")
  expect(screen.getByRole("heading", { name: "Source control" })).toBeInTheDocument()
})

test("renders destructive and disabled overflow actions with stable test ids", () => {
  const onDelete = jest.fn()

  renderHeader(
    <FeaturePageHeader
      title="Plugins"
      overflowLabel="More plugin actions"
      overflowActions={[
        {
          id: "disabled",
          label: "Checking updates",
          disabled: true,
        },
        {
          id: "delete",
          label: "Remove plugin",
          destructive: true,
          onSelect: onDelete,
          testId: "remove-plugin",
        },
      ]}
    />
  )

  expect(screen.getByRole("button", { name: "Checking updates" })).toBeDisabled()
  fireEvent.click(screen.getByTestId("remove-plugin"))
  expect(onDelete).toHaveBeenCalledTimes(1)
})

test("keeps overflow actions keyboard accessible", () => {
  const onExport = jest.fn()
  renderHeader(
    <FeaturePageHeader
      title="Logs"
      overflowLabel="More log actions"
      overflowActions={[{ id: "export", label: "Export logs", onSelect: onExport }]}
    />
  )

  fireEvent.keyDown(screen.getByRole("button", { name: "Export logs" }), { key: "Enter" })
  expect(onExport).toHaveBeenCalledTimes(1)
})

test("renders navigation in its own row by default", () => {
  renderHeader(
    <FeaturePageHeader
      testId="secondary-nav-header"
      title="Logs"
      navigation={<nav aria-label="Channels">Logs</nav>}
    />
  )

  const header = screen.getByTestId("secondary-nav-header")
  expect(header).toHaveAttribute("data-navigation-placement", "secondary")
  expect(header).toHaveAttribute("data-has-secondary", "true")
  expect(screen.getByRole("navigation", { name: "Channels" })).toBeInTheDocument()
})

test("folds navigation into the identity row when placement is inline", () => {
  // A short tab set does not earn a band of its own; `inline` is what lets a
  // page collapse to a single header row.
  renderHeader(
    <FeaturePageHeader
      testId="inline-nav-header"
      title="Logs"
      navigation={<nav aria-label="Channels">Logs</nav>}
      navigationPlacement="inline"
    />
  )

  const header = screen.getByTestId("inline-nav-header")
  expect(header).toHaveAttribute("data-navigation-placement", "inline")
  expect(header).toHaveAttribute("data-has-secondary", "false")
  const nav = screen.getByRole("navigation", { name: "Channels" })
  expect(nav.closest("[data-slot='feature-header-inline-navigation']")).not.toBeNull()
})

test("still renders the secondary row for controls when navigation is inline", () => {
  renderHeader(
    <FeaturePageHeader
      testId="inline-nav-controls-header"
      title="Logs"
      navigation={<nav aria-label="Channels">Logs</nav>}
      navigationPlacement="inline"
      controls={<input aria-label="Search logs" />}
    />
  )

  expect(screen.getByTestId("inline-nav-controls-header")).toHaveAttribute(
    "data-has-secondary",
    "true"
  )
  expect(screen.getByLabelText("Search logs")).toBeInTheDocument()
})

test("every navigation and control slot can scroll its own overflow", () => {
  // The header is `overflow-hidden`, so a slot that can neither shrink nor
  // scroll does not spill visibly, it disappears: /eval shipped four secondary
  // tabs of which two were unreachable at 375px, and /logs lost its refresh
  // and overflow buttons the same way. The three slots have to agree.
  const { rerender } = renderHeader(
    <FeaturePageHeader
      title="Logs"
      navigation={<nav aria-label="Channels">Logs</nav>}
      controls={<input aria-label="Search logs" />}
    />
  )

  const secondary = screen
    .getByRole("navigation", { name: "Channels" })
    .closest("[data-slot='feature-header-secondary-navigation']")
  expect(secondary).not.toBeNull()
  expect(secondary).toHaveClass("overflow-x-auto")
  expect(secondary).not.toHaveClass("shrink-0")
  expect(screen.getByLabelText("Search logs").parentElement).toHaveClass("overflow-x-auto")

  rerender(
    <TooltipProvider>
      <FeaturePageHeader
        title="Logs"
        navigation={<nav aria-label="Channels">Logs</nav>}
        navigationPlacement="inline"
      />
    </TooltipProvider>
  )
  const inline = screen
    .getByRole("navigation", { name: "Channels" })
    .closest("[data-slot='feature-header-inline-navigation']")
  expect(inline).toHaveClass("overflow-x-auto")
  expect(inline).not.toHaveClass("shrink-0")

  // The fourth slot. It was `shrink-0` while `actions` beside it is also
  // `shrink-0`, so on a narrow pane the two competed and the actions lost.
  rerender(
    <TooltipProvider>
      <FeaturePageHeader title="Source Control" breadcrumb={<button>Root</button>} />
    </TooltipProvider>
  )
  const breadcrumb = screen
    .getByRole("button", { name: "Root" })
    .closest("[data-slot='feature-header-breadcrumb']")
  expect(breadcrumb).not.toBeNull()
  expect(breadcrumb).toHaveClass("overflow-x-auto")
  expect(breadcrumb).not.toHaveClass("shrink-0")
})
