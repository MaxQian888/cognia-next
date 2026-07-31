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
