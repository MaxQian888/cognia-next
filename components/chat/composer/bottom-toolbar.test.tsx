/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { BottomToolbar } from "./bottom-toolbar"
import { CHROME_BUDGET, countControls } from "@/lib/ui/chrome-budget"
import type { ChatSession } from "@cognia/agent-config-types"

// Mock next-intl translations.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Drive the measured-width responsive switch deterministically (jsdom has no
// layout, so the real hook would always report 0 = wide).
let mockToolbarWidth = 0
jest.mock("@/hooks/use-element-width", () => ({
  useElementWidth: () => mockToolbarWidth,
}))

// Capture router.push calls.
const pushSpy = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy, replace: jest.fn(), prefetch: jest.fn(), back: jest.fn() }),
}))

// Stub the heavier sibling components — we only care about props.
const lastSelectorProps: Record<string, unknown> = {}
jest.mock("@/components/agent/mode/mode-selector", () => ({
  AgentModeSelector: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return <div data-testid="agent-mode-selector" />
  },
}))
jest.mock("@/components/agent/mode/runtime-selector", () => ({
  AgentRuntimeSelector: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return <div data-testid="agent-runtime-selector" />
  },
}))
jest.mock("@/components/agent/external-agent/selector", () => ({
  ExternalAgentSelector: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return <div data-testid="external-agent-selector" />
  },
}))
jest.mock("../permission-mode-indicator", () => ({
  PermissionModeIndicator: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return <div data-testid="permission-mode-indicator" />
  },
}))
jest.mock("./web-search-toggle", () => ({
  WebSearchToggle: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return <div data-testid="web-search-toggle" />
  },
}))
jest.mock("./effort-selector", () => ({
  EffortSelector: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return <div data-testid="effort-selector" />
  },
}))
// EnhanceButton needs the composer controller context; stub it (and the
// controller hook) so these prop-branching tests don't require a provider.
jest.mock("./enhance-button", () => ({
  EnhanceButton: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return <div data-testid="enhance-button" />
  },
}))
jest.mock("@/components/ai-elements/prompt-input", () => ({
  usePromptInputController: () => ({ textInput: { value: "", setInput: jest.fn() } }),
}))
jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock("@/components/ai-elements/context", () => ({
  Context: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextTrigger: () => null,
  ContextContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextContentHeader: () => null,
  ContextContentBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextContentFooter: () => null,
  ContextInputUsage: () => null,
  ContextOutputUsage: () => null,
  ContextCacheUsage: () => null,
}))

// Agent store state — mutated by tests that need different runtime/mode.
let agentRuntimeState = {
  runtime: "claude-sdk" as string,
  modeId: "general" as string,
  setModeId: jest.fn(),
  externalAgentId: null as string | null,
  setExternalAgentId: jest.fn(),
}

jest.mock("@/stores/agent", () => ({
  useAgentRuntimeStore: <T,>(selector: (s: typeof agentRuntimeState) => T) =>
    selector(agentRuntimeState),
}))

const setActiveAgentMock = jest.fn()
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: {
    getState: () => ({ setActiveAgent: setActiveAgentMock }),
  },
}))

let chatStoreState = {
  messages: [] as unknown[],
  status: "idle" as string,
  setPermissionMode: jest.fn(),
}

jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign(
    <T,>(selector: (s: typeof chatStoreState) => T) => selector(chatStoreState),
    { getState: () => chatStoreState }
  ),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: { defaultModel: string } | null }) => T) =>
    selector({ settings: { defaultModel: "claude-sonnet-4-5" } }),
}))

const session: ChatSession = {
  id: "s1",
  title: "Test",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  characterId: "c1",
}

beforeEach(() => {
  pushSpy.mockClear()
  setActiveAgentMock.mockClear()
  chatStoreState = {
    messages: [],
    status: "idle",
    setPermissionMode: jest.fn(),
  }
  agentRuntimeState = {
    runtime: "claude-sdk",
    modeId: "general",
    setModeId: jest.fn(),
    externalAgentId: null,
    setExternalAgentId: jest.fn(),
  }
  for (const key of Object.keys(lastSelectorProps)) delete lastSelectorProps[key]
  mockToolbarWidth = 0
})

// Stub the workflow toolbar variant so the branching test doesn't need
// the full workflow context tree.
jest.mock("./workflow-bottom-toolbar", () => ({
  WorkflowBottomToolbar: () => <div data-testid="workflow-bottom-toolbar" />,
}))

describe("BottomToolbar — session-kind branching", () => {
  it("delegates to WorkflowBottomToolbar when session.kind === 'workflow-editor'", () => {
    const wfSession: ChatSession = {
      id: "workflow:wf_x",
      title: "Test workflow",
      kind: "workflow-editor",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    render(<BottomToolbar session={wfSession} />)
    expect(screen.getByTestId("workflow-bottom-toolbar")).toBeInTheDocument()
    // Generic-toolbar controls should not be rendered when the branch fires.
    expect(screen.queryByTestId("agent-runtime-selector")).toBeNull()
    expect(screen.queryByTestId("agent-mode-selector")).toBeNull()
    expect(screen.queryByTestId("web-search-toggle")).toBeNull()
  })

  it("embeds the workflow toolbar inside compact composer mode", () => {
    const wfSession: ChatSession = {
      id: "workflow:wf_x",
      title: "Test workflow",
      kind: "workflow-editor",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    render(<BottomToolbar session={wfSession} variant="embedded" />)

    const embedded = screen.getByTestId("composer-toolbar-embedded")
    expect(embedded).toContainElement(screen.getByTestId("workflow-bottom-toolbar"))
    expect(screen.queryByTestId("agent-runtime-selector")).toBeNull()
  })

  it("renders the generic toolbar for a direct session", () => {
    render(<BottomToolbar session={session} />)
    expect(screen.queryByTestId("workflow-bottom-toolbar")).toBeNull()
    // The execution row keeps the model and Agent runtime visible. Detailed
    // mode/agent configuration stays behind "\u22ef", and capability toggles
    // live under the composer's `+`.
    expect(screen.getByTestId("permission-mode-indicator")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-mode-selector")).toBeNull()
    expect(screen.queryByTestId("web-search-toggle")).toBeNull()
    expect(screen.queryByTestId("enhance-button")).toBeNull()
  })

  it("keeps capability toggles out of the advanced-controls overflow", () => {
    render(<BottomToolbar session={session} />)
    fireEvent.click(screen.getByTestId("composer-toolbar-more"))
    expect(screen.queryByTestId("web-search-toggle")).toBeNull()
    expect(screen.queryByTestId("enhance-button")).toBeNull()
  })

  // Effort is a qualifier of the model, meaningless without one, so it renders
  // inside the model picker's popover instead of as a chip beside it.
  it("no longer carries a standalone effort chip", () => {
    render(<BottomToolbar session={session} />)
    expect(screen.queryByTestId("effort-selector")).toBeNull()
  })

  // Regression: the row must wrap instead of pinning both ends with
  // `justify-between`, which let the left controls slide under the
  // right-aligned context indicator on a narrow (welcome) composer.
  it("lays the generic toolbar out as one row so status controls stay aligned", () => {
    const { container } = render(<BottomToolbar session={session} />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain("flex-nowrap")
    expect(root.className).not.toContain("justify-between")
  })

  // Regression: a long provider model id must ellipsize the model chip rather
  // than push Permission onto a second line. They share one `flex-nowrap` +
  // `min-w-0` row so the group shrinks as a unit.
  it("groups Tier 1 controls in a non-wrapping, shrinkable row", () => {
    const { container } = render(<BottomToolbar session={session} />)
    const nowrapRow = container.querySelector(".flex-nowrap")
    expect(nowrapRow).not.toBeNull()
    expect(nowrapRow?.className).toContain("min-w-0")
    expect(nowrapRow?.querySelector('[data-testid="permission-mode-indicator"]')).not.toBeNull()
  })

  // The wide branch is the one the user stares at all day, so it carries the
  // budget. Ratchet, not a target — see lib/ui/chrome-budget.ts.
  it("stays within the composer-toolbar chrome control budget", () => {
    const { container } = render(<BottomToolbar session={session} />)
    expect(countControls(container)).toBeLessThanOrEqual(CHROME_BUDGET.composerToolbar)
  })
})

describe("BottomToolbar — narrow-width More menu", () => {
  it("embeds primary controls and keeps advanced controls in overflow for compact composer mode", () => {
    render(<BottomToolbar session={session} variant="embedded" />)

    expect(screen.getByTestId("composer-toolbar-embedded")).toBeInTheDocument()
    expect(screen.getByTestId("permission-mode-indicator")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("composer-toolbar-more"))
    expect(screen.getByTestId("agent-mode-selector")).toBeInTheDocument()
  })

  // Every width now shows the SAME roster — the branches differ only in how the
  // row is packed. That is what keeps each control mounted in exactly one place.
  it("shows the same controls wide as compact, differing only in packing", () => {
    mockToolbarWidth = 600
    const wide = render(<BottomToolbar session={session} />)
    expect(screen.getByTestId("permission-mode-indicator")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-mode-selector")).toBeNull()
    fireEvent.click(screen.getByTestId("composer-toolbar-more"))
    expect(screen.getByTestId("agent-mode-selector")).toBeInTheDocument()
    wide.unmount()

    mockToolbarWidth = 300
    render(<BottomToolbar session={session} />)
    expect(screen.getByTestId("permission-mode-indicator")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-mode-selector")).toBeNull()
    fireEvent.click(screen.getByTestId("composer-toolbar-more"))
    expect(screen.getByTestId("agent-mode-selector")).toBeInTheDocument()
  })

  it("keeps a medium-width toolbar on one row instead of splitting status chrome early", () => {
    mockToolbarWidth = 420
    const { container } = render(<BottomToolbar session={session} />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain("flex-nowrap")
    expect(root.className).not.toContain("flex-col")
  })

  // Regression: the compact toolbar must cap at TWO rows (Tier 1, then the
  // overflow menu + context indicator sharing the second row) instead of
  // letting `⋯` and the usage `%` each wrap onto their own line (three rows).
  it("caps the compact toolbar at two rows and groups secondary status controls at the end", () => {
    mockToolbarWidth = 300
    const { container } = render(<BottomToolbar session={session} />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain("flex-col")
    // Context usage and More belong to one secondary cluster, not opposite
    // edges of an otherwise empty row.
    const more = screen.getByTestId("composer-toolbar-more")
    expect((more.parentElement as HTMLElement).className).toContain("justify-end")
    expect((more.parentElement as HTMLElement).className).not.toContain("justify-between")
  })
})

describe("BottomToolbar — agent-mode wiring", () => {
  /**
   * The mode / external-agent selectors moved into the overflow Popover, so
   * they do not mount until it opens. Render, open, then read the props the
   * stubs captured.
   */
  function renderWithOverflowOpen(node: React.ReactElement) {
    const result = render(node)
    fireEvent.click(screen.getByTestId("composer-toolbar-more"))
    return result
  }

  it("passes onSelectTeam routing to /agent-teams/workspace", () => {
    renderWithOverflowOpen(<BottomToolbar session={session} />)
    const onSelectTeam = lastSelectorProps.onSelectTeam as (id: string) => void
    expect(typeof onSelectTeam).toBe("function")
    onSelectTeam("team-x")
    expect(pushSpy).toHaveBeenCalledWith("/agent-teams/workspace?teamId=team-x")
  })

  it("passes onCreateTeam routing to /agent-teams", () => {
    renderWithOverflowOpen(<BottomToolbar session={session} />)
    const onCreateTeam = lastSelectorProps.onCreateTeam as () => void
    expect(typeof onCreateTeam).toBe("function")
    onCreateTeam()
    expect(pushSpy).toHaveBeenCalledWith("/agent-teams")
  })

  it("still passes selectedModeId + onModeChange (existing wiring intact)", () => {
    renderWithOverflowOpen(<BottomToolbar session={session} />)
    expect(lastSelectorProps.selectedModeId).toBe("general")
    expect(typeof lastSelectorProps.onModeChange).toBe("function")
  })

  it("passes disabled=true to child controls when streaming", () => {
    chatStoreState.status = "streaming"
    renderWithOverflowOpen(<BottomToolbar session={session} />)
    expect(lastSelectorProps.disabled).toBe(true)
  })

  it("passes disabled=false to child controls when idle", () => {
    renderWithOverflowOpen(<BottomToolbar session={session} />)
    expect(lastSelectorProps.disabled).toBe(false)
  })

  it("syncs externalAgentId to useExternalAgentStore on agent change", () => {
    agentRuntimeState.runtime = "external"
    renderWithOverflowOpen(<BottomToolbar session={session} />)
    const onAgentChange = lastSelectorProps.onAgentChange as (id: string | null) => void
    expect(typeof onAgentChange).toBe("function")
    onAgentChange("agent-1")
    expect(setActiveAgentMock).toHaveBeenCalledWith("agent-1")
  })
})
