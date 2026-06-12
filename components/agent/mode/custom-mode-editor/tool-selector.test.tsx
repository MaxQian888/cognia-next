/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { ToolSelector } from "./tool-selector"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="scroll-area" className={className}>
      {children}
    </div>
  ),
}))

jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
    <span data-testid="badge" data-variant={variant}>
      {children}
    </span>
  ),
}))

jest.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children: React.ReactNode }) => (
    <label data-testid="tools-label">{children}</label>
  ),
}))

// Collapsible: always shows content. The wrapper div also emits a toggle
// button via a data-attribute so tests can trigger category expand/collapse
// without bubbling conflicts from inner button clicks.
jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode
    open?: boolean
    onOpenChange?: (v: boolean) => void
    id?: string
  }) => (
    <div data-testid="collapsible" data-open={String(open)}>
      {/* Hidden button that triggers toggleCategory without bubbling */}
      <button
        data-testid="collapsible-toggle"
        type="button"
        style={{ display: "none" }}
        onClick={(e) => {
          e.stopPropagation()
          onOpenChange?.(!open)
        }}
      />
      {children}
    </div>
  ),
  CollapsibleTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="collapsible-content">{children}</div>
  ),
}))

jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    variant,
    size,
    className,
  }: {
    children: React.ReactNode
    onClick?: () => void
    variant?: string
    size?: string
    className?: string
  }) => (
    <button data-variant={variant} data-size={size} className={className} onClick={onClick}>
      {children}
    </button>
  ),
}))

jest.mock("@/lib/agent/resolve-icon", () => ({
  LucideIcons: new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        const Icon = ({ className }: { className?: string }) => (
          <svg data-testid={`icon-${prop}`} className={className} />
        )
        Icon.displayName = prop
        return Icon
      },
    }
  ),
}))

// Inline the stub inside the factory to avoid TDZ (jest.mock is hoisted above const).
jest.mock("@/stores/agent/custom-mode-store", () => ({
  TOOL_CATEGORIES: {
    sdk_builtin: {
      name: "Built-in (SDK)",
      icon: "Sparkles",
      tools: ["Bash", "Read", "Write"],
    },
    cognia_git: {
      name: "Git",
      icon: "GitBranch",
      tools: ["git_status", "git_diff"],
    },
  },
}))

// Mirror of the stub — kept for documentation/reference.
const _STUB_TOOL_CATEGORIES = {
  sdk_builtin: {
    name: "Built-in (SDK)",
    icon: "Sparkles",
    tools: ["Bash", "Read", "Write"] as readonly string[],
  },
  cognia_git: {
    name: "Git",
    icon: "GitBranch",
    tools: ["git_status", "git_diff"] as readonly string[],
  },
} as const

describe("ToolSelector — render", () => {
  it("renders without crashing", () => {
    render(<ToolSelector value={[]} onChange={jest.fn()} />)
  })

  it("renders the tools label", () => {
    render(<ToolSelector value={[]} onChange={jest.fn()} />)
    expect(screen.getByTestId("tools-label")).toBeInTheDocument()
    expect(screen.getByTestId("tools-label").textContent).toBe("tools")
  })

  it("renders a badge showing zero selected tools when value is empty", () => {
    render(<ToolSelector value={[]} onChange={jest.fn()} />)
    const badges = screen.getAllByTestId("badge")
    // The header badge should include "0"
    expect(badges[0].textContent).toContain("0")
  })

  it("renders a category row for each category key", () => {
    render(<ToolSelector value={[]} onChange={jest.fn()} />)
    expect(screen.getByText("Built-in (SDK)")).toBeInTheDocument()
    expect(screen.getByText("Git")).toBeInTheDocument()
  })

  it("renders tool buttons inside collapsible content", () => {
    render(<ToolSelector value={[]} onChange={jest.fn()} />)
    const contents = screen.getAllByTestId("collapsible-content")
    const allToolButtons = contents.flatMap((c) => Array.from(c.querySelectorAll("button")))
    const toolNames = allToolButtons.map((b) => b.textContent ?? "")
    expect(toolNames.some((n) => n.includes("Bash"))).toBe(true)
    expect(toolNames.some((n) => n.includes("git_status"))).toBe(true)
  })
})

describe("ToolSelector — selection count badge", () => {
  it("shows the correct selected count in the header badge", () => {
    render(<ToolSelector value={["Bash", "Read"]} onChange={jest.fn()} />)
    const badges = screen.getAllByTestId("badge")
    expect(badges[0].textContent).toContain("2")
  })

  it("shows per-category selected count in category badge", () => {
    render(<ToolSelector value={["Bash"]} onChange={jest.fn()} />)
    // Category badge for sdk_builtin shows "1/3"
    const badges = screen.getAllByTestId("badge")
    const categoryBadge = badges.find((b) => b.textContent?.includes("1/3"))
    expect(categoryBadge).toBeDefined()
  })
})

describe("ToolSelector — toggleTool", () => {
  it("calls onChange adding the tool when an unselected tool button is clicked", () => {
    const onChange = jest.fn()
    render(<ToolSelector value={[]} onChange={onChange} />)
    const contents = screen.getAllByTestId("collapsible-content")
    const bashButton = Array.from(contents[0].querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Bash")
    )
    expect(bashButton).toBeDefined()
    fireEvent.click(bashButton!)
    expect(onChange).toHaveBeenCalledWith(["Bash"])
  })

  it("calls onChange removing the tool when a selected tool button is clicked", () => {
    const onChange = jest.fn()
    render(<ToolSelector value={["Bash"]} onChange={onChange} />)
    const contents = screen.getAllByTestId("collapsible-content")
    const bashButton = Array.from(contents[0].querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Bash")
    )
    fireEvent.click(bashButton!)
    expect(onChange).toHaveBeenCalledWith([])
  })

  it("marks selected tools with secondary variant", () => {
    render(<ToolSelector value={["Bash"]} onChange={jest.fn()} />)
    const contents = screen.getAllByTestId("collapsible-content")
    const bashButton = Array.from(contents[0].querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Bash")
    )
    expect(bashButton!.getAttribute("data-variant")).toBe("secondary")
  })

  it("marks unselected tools with ghost variant", () => {
    render(<ToolSelector value={[]} onChange={jest.fn()} />)
    const contents = screen.getAllByTestId("collapsible-content")
    const bashButton = Array.from(contents[0].querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Bash")
    )
    expect(bashButton!.getAttribute("data-variant")).toBe("ghost")
  })
})

describe("ToolSelector — toggleCategory (expand/collapse)", () => {
  it("expands a category collapsible when the hidden toggle is clicked", () => {
    render(<ToolSelector value={[]} onChange={jest.fn()} />)
    const collapsibles = screen.getAllByTestId("collapsible")
    // Initially open=false (expandedCategories is empty Set).
    expect(collapsibles[0].getAttribute("data-open")).toBe("false")
    const toggleBtn = collapsibles[0].querySelector("[data-testid='collapsible-toggle']")!
    fireEvent.click(toggleBtn)
    // After clicking, the category should be open.
    expect(collapsibles[0].getAttribute("data-open")).toBe("true")
  })

  it("collapses a category collapsible when clicked while expanded", () => {
    render(<ToolSelector value={[]} onChange={jest.fn()} />)
    const collapsibles = screen.getAllByTestId("collapsible")
    const toggleBtn = collapsibles[0].querySelector("[data-testid='collapsible-toggle']")!
    // First expand.
    fireEvent.click(toggleBtn)
    expect(collapsibles[0].getAttribute("data-open")).toBe("true")
    // Then collapse.
    fireEvent.click(toggleBtn)
    expect(collapsibles[0].getAttribute("data-open")).toBe("false")
  })
})

describe("ToolSelector — toggleAllInCategory", () => {
  function getHeaderButtons() {
    const scrollArea = screen.getByTestId("scroll-area")
    const contentElements = scrollArea.querySelectorAll("[data-testid='collapsible-content']")
    const allButtons = Array.from(scrollArea.querySelectorAll("button"))
    const contentButtons = new Set(
      Array.from(contentElements).flatMap((c) => Array.from(c.querySelectorAll("button")))
    )
    // Exclude the hidden collapsible-toggle buttons added by the mock.
    return allButtons.filter(
      (b) => !contentButtons.has(b) && b.getAttribute("data-testid") !== "collapsible-toggle"
    )
  }

  it("selects all tools in a category when none are selected", () => {
    const onChange = jest.fn()
    render(<ToolSelector value={[]} onChange={onChange} />)
    // headerButtons: sdk_builtin trigger, sdk_builtin toggle-all, git trigger, git toggle-all
    const headerButtons = getHeaderButtons()
    fireEvent.click(headerButtons[1]) // sdk_builtin toggle-all → select all 3
    const called = onChange.mock.calls[0][0] as string[]
    expect(called).toContain("Bash")
    expect(called).toContain("Read")
    expect(called).toContain("Write")
  })

  it("deselects all tools in a category when all are selected", () => {
    const onChange = jest.fn()
    render(<ToolSelector value={["Bash", "Read", "Write"]} onChange={onChange} />)
    const headerButtons = getHeaderButtons()
    fireEvent.click(headerButtons[1]) // sdk_builtin toggle-all → deselect
    const called = onChange.mock.calls[0][0] as string[]
    expect(called).not.toContain("Bash")
    expect(called).not.toContain("Read")
    expect(called).not.toContain("Write")
  })
})
