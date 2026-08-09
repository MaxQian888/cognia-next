/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { McpToolSelector } from "./mcp-tool-selector"
import type { McpToolReference } from "@/stores/agent/custom-mode-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, string>) => {
    if (params) {
      // Return key with param values appended so assertions can verify params.
      return `${key}:${Object.values(params).join(",")}`
    }
    return key
  },
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
    <label data-testid="mcp-label">{children}</label>
  ),
}))

jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    variant,
    size,
    className,
    type,
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    variant?: string
    size?: string
    className?: string
    type?: "button" | "reset" | "submit"
  }) => (
    <button
      data-variant={variant}
      data-size={size}
      className={className}
      disabled={disabled}
      type={type ?? "button"}
      onClick={onClick}
    >
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode
    open?: boolean
    onOpenChange?: (v: boolean) => void
  }) => (
    <div data-testid="collapsible" data-open={String(open)}>
      {/* Hidden button to trigger toggleServer without bubbling */}
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

jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}))

jest.mock("@/lib/utils", () => ({
  cn: (...args: (string | undefined | false | null)[]) => args.filter(Boolean).join(" "),
}))

// Stub DEFAULT_TOOL_SELECTION_CONFIG.
jest.mock("@/types/mcp", () => ({
  DEFAULT_TOOL_SELECTION_CONFIG: {
    enabled: true,
    allowList: [],
    denyList: [],
    autoLoadAll: true,
    maxTools: 10,
    minSelectedTools: 0,
  },
}))

// Stub getRecommendedMcpToolsForMode. The factory captures a mutable holder
// object so the returned value can be changed per-test without require().
const recommendationHolder = { returnValue: [] as unknown[] }
jest.mock("@/stores/agent/custom-mode-store", () => ({
  // The module factory closes over `recommendationHolder`, which IS defined
  // at factory-evaluation time (factories run lazily, after all hoisted mocks
  // are set up and after the module scope runs).
  getRecommendedMcpToolsForMode: (..._args: unknown[]) => recommendationHolder.returnValue,
}))

// Helper to configure per-test return value.
function mockGetRecommendedMcpTools(value: unknown[]) {
  recommendationHolder.returnValue = value
}

// MCP store state — shared reference mutated per test.
const mcpStoreState = {
  servers: [] as Array<{
    id: string
    name: string
    status: { type: string }
    tools?: Array<{ name: string; description?: string }>
  }>,
  toolSelectionConfig: {
    enabled: true,
    allowList: [] as string[],
    denyList: [] as string[],
    autoLoadAll: true,
    maxTools: 10,
    minSelectedTools: 0,
  },
  lastToolSelection: null as null | {
    selectedToolNames: string[]
    totalAvailable: number
    wasLimited: boolean
    fallbackApplied: boolean
  },
}

jest.mock("@/stores/mcp/mcp-store", () => ({
  useMcpStore: (selector: (s: typeof mcpStoreState) => unknown) => selector(mcpStoreState),
  refreshMcpStore: jest.fn().mockResolvedValue(undefined),
}))

const CONNECTED_SERVER = {
  id: "srv-1",
  name: "Test Server",
  status: { type: "connected" as const },
  tools: [
    { name: "file_read", description: "Read a file" },
    { name: "file_write", description: "Write a file" },
    { name: "git_status", description: "Git status" },
  ],
}

beforeEach(() => {
  mcpStoreState.servers = []
  mcpStoreState.lastToolSelection = null
  mcpStoreState.toolSelectionConfig = {
    enabled: true,
    allowList: [],
    denyList: [],
    autoLoadAll: true,
    maxTools: 10,
    minSelectedTools: 0,
  }
  mockGetRecommendedMcpTools([])
})

describe("McpToolSelector — empty state (no connected servers)", () => {
  it("renders without crashing when no servers are connected", () => {
    render(<McpToolSelector value={[]} onChange={jest.fn()} />)
  })

  it("shows the label for MCP tools", () => {
    render(<McpToolSelector value={[]} onChange={jest.fn()} />)
    expect(screen.getByTestId("mcp-label")).toBeInTheDocument()
  })

  it("shows the no-servers-connected message", () => {
    render(<McpToolSelector value={[]} onChange={jest.fn()} />)
    expect(screen.getByText("noMcpServers")).toBeInTheDocument()
  })

  it("does NOT render the scroll area when no servers", () => {
    render(<McpToolSelector value={[]} onChange={jest.fn()} />)
    expect(screen.queryByTestId("scroll-area")).not.toBeInTheDocument()
  })
})

describe("McpToolSelector — with connected server", () => {
  beforeEach(() => {
    mcpStoreState.servers = [CONNECTED_SERVER]
  })

  it("renders without crashing", () => {
    render(<McpToolSelector value={[]} onChange={jest.fn()} />)
  })

  it("renders the scroll area for tool selection", () => {
    render(<McpToolSelector value={[]} onChange={jest.fn()} />)
    expect(screen.getByTestId("scroll-area")).toBeInTheDocument()
  })

  it("renders the server name", () => {
    render(<McpToolSelector value={[]} onChange={jest.fn()} />)
    expect(screen.getByText("Test Server")).toBeInTheDocument()
  })

  it("renders tool buttons inside collapsible content", () => {
    render(<McpToolSelector value={[]} onChange={jest.fn()} />)
    const content = screen.getByTestId("collapsible-content")
    expect(content.querySelectorAll("button").length).toBe(CONNECTED_SERVER.tools.length)
  })

  it("shows selected count badge for the server (0 selected)", () => {
    render(<McpToolSelector value={[]} onChange={jest.fn()} />)
    const badges = screen.getAllByTestId("badge")
    const serverBadge = badges.find((b) =>
      b.textContent?.includes(`0/${CONNECTED_SERVER.tools.length}`)
    )
    expect(serverBadge).toBeDefined()
  })

  it("shows selected count badge for the server (1 selected)", () => {
    const selected: McpToolReference[] = [{ serverId: "srv-1", toolName: "file_read" }]
    render(<McpToolSelector value={selected} onChange={jest.fn()} />)
    const badges = screen.getAllByTestId("badge")
    const serverBadge = badges.find((b) =>
      b.textContent?.includes(`1/${CONNECTED_SERVER.tools.length}`)
    )
    expect(serverBadge).toBeDefined()
  })
})

describe("McpToolSelector — tool toggling", () => {
  beforeEach(() => {
    mcpStoreState.servers = [CONNECTED_SERVER]
  })

  it("calls onChange adding a tool when an unselected tool button is clicked", () => {
    const onChange = jest.fn()
    render(<McpToolSelector value={[]} onChange={onChange} />)
    const content = screen.getByTestId("collapsible-content")
    const toolButtons = content.querySelectorAll("button")
    fireEvent.click(toolButtons[0]) // file_read
    expect(onChange).toHaveBeenCalledTimes(1)
    const called = onChange.mock.calls[0][0] as McpToolReference[]
    expect(called.some((t) => t.toolName === "file_read" && t.serverId === "srv-1")).toBe(true)
  })

  it("calls onChange removing a tool when a selected tool button is clicked", () => {
    const onChange = jest.fn()
    const selected: McpToolReference[] = [{ serverId: "srv-1", toolName: "file_read" }]
    render(<McpToolSelector value={selected} onChange={onChange} />)
    const content = screen.getByTestId("collapsible-content")
    const toolButtons = content.querySelectorAll("button")
    fireEvent.click(toolButtons[0]) // file_read (currently selected)
    const called = onChange.mock.calls[0][0] as McpToolReference[]
    expect(called.some((t) => t.toolName === "file_read")).toBe(false)
  })

  it("marks selected tools with secondary variant", () => {
    const selected: McpToolReference[] = [{ serverId: "srv-1", toolName: "file_read" }]
    render(<McpToolSelector value={selected} onChange={jest.fn()} />)
    const content = screen.getByTestId("collapsible-content")
    const toolButtons = content.querySelectorAll("button")
    expect(toolButtons[0].getAttribute("data-variant")).toBe("secondary")
  })

  it("marks unselected tools with ghost variant", () => {
    render(<McpToolSelector value={[]} onChange={jest.fn()} />)
    const content = screen.getByTestId("collapsible-content")
    const toolButtons = content.querySelectorAll("button")
    expect(toolButtons[0].getAttribute("data-variant")).toBe("ghost")
  })
})

describe("McpToolSelector — toggleServer (expand/collapse)", () => {
  beforeEach(() => {
    mcpStoreState.servers = [CONNECTED_SERVER]
  })

  it("expands a server collapsible when the hidden toggle is clicked", () => {
    render(<McpToolSelector value={[]} onChange={jest.fn()} />)
    const collapsibles = screen.getAllByTestId("collapsible")
    expect(collapsibles[0].getAttribute("data-open")).toBe("false")
    const toggleBtn = collapsibles[0].querySelector("[data-testid='collapsible-toggle']")!
    fireEvent.click(toggleBtn)
    expect(collapsibles[0].getAttribute("data-open")).toBe("true")
  })

  it("collapses a server collapsible when clicked while expanded", () => {
    render(<McpToolSelector value={[]} onChange={jest.fn()} />)
    const collapsibles = screen.getAllByTestId("collapsible")
    const toggleBtn = collapsibles[0].querySelector("[data-testid='collapsible-toggle']")!
    fireEvent.click(toggleBtn)
    expect(collapsibles[0].getAttribute("data-open")).toBe("true")
    fireEvent.click(toggleBtn)
    expect(collapsibles[0].getAttribute("data-open")).toBe("false")
  })
})

describe("McpToolSelector — toggleAllInServer", () => {
  beforeEach(() => {
    mcpStoreState.servers = [CONNECTED_SERVER]
  })

  function getHeaderButtons() {
    const scrollArea = screen.getByTestId("scroll-area")
    const contentEl = screen.getByTestId("collapsible-content")
    const allButtons = Array.from(scrollArea.querySelectorAll("button"))
    const contentButtons = new Set(Array.from(contentEl.querySelectorAll("button")))
    return allButtons.filter(
      (b) => !contentButtons.has(b) && b.getAttribute("data-testid") !== "collapsible-toggle"
    )
  }

  it("selects all tools in the server when toggle-all button is clicked and none are selected", () => {
    const onChange = jest.fn()
    render(<McpToolSelector value={[]} onChange={onChange} />)
    // headerButtons[0] = server trigger, headerButtons[1] = toggle-all
    const headerButtons = getHeaderButtons()
    fireEvent.click(headerButtons[1])
    const called = onChange.mock.calls[0][0] as McpToolReference[]
    expect(called.length).toBe(CONNECTED_SERVER.tools.length)
    expect(called.every((t) => t.serverId === "srv-1")).toBe(true)
  })

  it("deselects all tools in the server when all are selected and toggle-all is clicked", () => {
    const onChange = jest.fn()
    const allSelected: McpToolReference[] = CONNECTED_SERVER.tools.map((t) => ({
      serverId: "srv-1",
      toolName: t.name,
    }))
    render(<McpToolSelector value={allSelected} onChange={onChange} />)
    const headerButtons = getHeaderButtons()
    fireEvent.click(headerButtons[1])
    const called = onChange.mock.calls[0][0] as McpToolReference[]
    expect(called.filter((t) => t.serverId === "srv-1").length).toBe(0)
  })
})

describe("McpToolSelector — over-budget badge", () => {
  beforeEach(() => {
    mcpStoreState.servers = [CONNECTED_SERVER]
    mcpStoreState.toolSelectionConfig = {
      enabled: true,
      allowList: [],
      denyList: [],
      autoLoadAll: true,
      maxTools: 2, // small cap
      minSelectedTools: 0,
    }
  })

  it("shows destructive badge when selected tools exceed maxTools", () => {
    const allSelected: McpToolReference[] = CONNECTED_SERVER.tools.map((t) => ({
      serverId: "srv-1",
      toolName: t.name,
    })) // 3 tools, maxTools=2
    render(<McpToolSelector value={allSelected} onChange={jest.fn()} />)
    const badges = screen.getAllByTestId("badge")
    const destructiveBadge = badges.find((b) => b.getAttribute("data-variant") === "destructive")
    expect(destructiveBadge).toBeDefined()
  })

  it("does NOT show destructive badge when within budget", () => {
    const oneSelected: McpToolReference[] = [{ serverId: "srv-1", toolName: "file_read" }]
    render(<McpToolSelector value={oneSelected} onChange={jest.fn()} />)
    const badges = screen.getAllByTestId("badge")
    // The header count badge should be secondary, not destructive
    const headerBadge = badges.find((b) => b.textContent?.includes("1"))
    expect(headerBadge?.getAttribute("data-variant")).toBe("secondary")
  })
})

describe("McpToolSelector — recommendations", () => {
  beforeEach(() => {
    mcpStoreState.servers = [CONNECTED_SERVER]
  })

  it("disables the apply-recommendations button when no name/desc/prompt context", () => {
    render(
      <McpToolSelector
        value={[]}
        onChange={jest.fn()}
        recommendationContext={{ name: "", description: "", systemPrompt: "", category: "other" }}
      />
    )
    const applyBtn = screen.getByText("applyRecommendedMcpTools")
    expect(applyBtn.closest("button")).toBeDisabled()
  })

  it("disables the apply-recommendations button when no recommendations returned", () => {
    mockGetRecommendedMcpTools([])
    render(
      <McpToolSelector
        value={[]}
        onChange={jest.fn()}
        recommendationContext={{ name: "My Mode", description: "desc", systemPrompt: "sys" }}
      />
    )
    const applyBtn = screen.getByText("applyRecommendedMcpTools")
    expect(applyBtn.closest("button")).toBeDisabled()
  })

  it("enables the apply-recommendations button when recommendations are available", () => {
    mockGetRecommendedMcpTools([
      { serverId: "srv-1", toolName: "file_read", displayName: "file_read", relevanceScore: 0.9 },
    ])
    render(
      <McpToolSelector
        value={[]}
        onChange={jest.fn()}
        recommendationContext={{ name: "My Mode", description: "desc", systemPrompt: "sys" }}
      />
    )
    const applyBtn = screen.getByText("applyRecommendedMcpTools")
    expect(applyBtn.closest("button")).not.toBeDisabled()
  })

  it("calls onChange with recommended tools when apply button is clicked", () => {
    const onChange = jest.fn()
    mockGetRecommendedMcpTools([
      { serverId: "srv-1", toolName: "file_read", displayName: "file_read", relevanceScore: 0.9 },
    ])
    render(
      <McpToolSelector
        value={[]}
        onChange={onChange}
        recommendationContext={{ name: "My Mode", description: "desc", systemPrompt: "sys" }}
      />
    )
    const applyBtn = screen.getByText("applyRecommendedMcpTools")
    fireEvent.click(applyBtn.closest("button")!)
    expect(onChange).toHaveBeenCalledTimes(1)
    const called = onChange.mock.calls[0][0] as McpToolReference[]
    expect(called.some((t) => t.toolName === "file_read")).toBe(true)
    // relevanceScore should be stripped from the result
    expect(called[0]).not.toHaveProperty("relevanceScore")
  })

  it("shows recommended tool badges when context is provided and recommendations exist", () => {
    mockGetRecommendedMcpTools([
      { serverId: "srv-1", toolName: "file_read", displayName: "file_read", relevanceScore: 0.9 },
    ])
    render(
      <McpToolSelector
        value={[]}
        onChange={jest.fn()}
        recommendationContext={{ name: "My Mode", description: "desc", systemPrompt: "sys" }}
      />
    )
    expect(screen.getAllByText(/file_read/).length).toBeGreaterThan(0)
  })
})

describe("McpToolSelector — lastToolSelection info", () => {
  beforeEach(() => {
    mcpStoreState.servers = [CONNECTED_SERVER]
  })

  it("shows last selection summary when lastToolSelection is present", () => {
    mcpStoreState.lastToolSelection = {
      selectedToolNames: ["file_read"],
      totalAvailable: 3,
      wasLimited: false,
      fallbackApplied: false,
    }
    render(<McpToolSelector value={[]} onChange={jest.fn()} />)
    // The translation fn returns "mcpLastSelectionSummary:1,3" (key:params)
    expect(screen.getByText(/mcpLastSelectionSummary/)).toBeInTheDocument()
  })

  it("shows limited badge when wasLimited is true", () => {
    mcpStoreState.lastToolSelection = {
      selectedToolNames: ["file_read"],
      totalAvailable: 3,
      wasLimited: true,
      fallbackApplied: false,
    }
    render(<McpToolSelector value={[]} onChange={jest.fn()} />)
    expect(screen.getByText("mcpSelectionLimited")).toBeInTheDocument()
  })

  it("shows fallback badge when fallbackApplied is true", () => {
    mcpStoreState.lastToolSelection = {
      selectedToolNames: ["file_read"],
      totalAvailable: 3,
      wasLimited: false,
      fallbackApplied: true,
    }
    render(<McpToolSelector value={[]} onChange={jest.fn()} />)
    expect(screen.getByText("mcpSelectionFallback")).toBeInTheDocument()
  })
})
