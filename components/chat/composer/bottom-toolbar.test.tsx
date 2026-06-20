/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { BottomToolbar } from "./bottom-toolbar"
import type { ChatSession } from "@/lib/claude/types"

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
  useChatStore: <T,>(selector: (s: typeof chatStoreState) => T) => selector(chatStoreState),
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

  it("renders the generic toolbar for a direct session", () => {
    render(<BottomToolbar session={session} />)
    expect(screen.queryByTestId("workflow-bottom-toolbar")).toBeNull()
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()
    expect(screen.getByTestId("web-search-toggle")).toBeInTheDocument()
  })

  // Regression: the row must wrap instead of pinning both ends with
  // `justify-between`, which let the left controls slide under the
  // right-aligned context indicator on a narrow (welcome) composer.
  it("lays the generic toolbar out as a wrapping row so controls can't overlap", () => {
    const { container } = render(<BottomToolbar session={session} />)
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain("flex-wrap")
    expect(root.className).not.toContain("justify-between")
  })
})

describe("BottomToolbar — narrow-width More menu", () => {
  it("keeps Tier 2/3 inline when the toolbar is wide", () => {
    mockToolbarWidth = 600
    render(<BottomToolbar session={session} />)
    expect(screen.getByTestId("web-search-toggle")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()
    expect(screen.queryByTestId("composer-toolbar-more")).toBeNull()
  })

  it("collapses Tier 2/3 into a More menu below the compact threshold", () => {
    mockToolbarWidth = 300
    render(<BottomToolbar session={session} />)
    // Tier 1 stays inline.
    expect(screen.getByTestId("permission-mode-indicator")).toBeInTheDocument()
    // Tier 2/3 are not mounted until the menu opens (single mount point).
    expect(screen.queryByTestId("web-search-toggle")).toBeNull()
    expect(screen.queryByTestId("agent-runtime-selector")).toBeNull()
    // The More trigger is present and opens the collapsed controls.
    const more = screen.getByTestId("composer-toolbar-more")
    fireEvent.click(more)
    expect(screen.getByTestId("web-search-toggle")).toBeInTheDocument()
    expect(screen.getByTestId("agent-runtime-selector")).toBeInTheDocument()
  })
})

describe("BottomToolbar — agent-mode wiring", () => {
  it("passes onSelectTeam routing to /agent-teams/workspace", () => {
    render(<BottomToolbar session={session} />)
    const onSelectTeam = lastSelectorProps.onSelectTeam as (id: string) => void
    expect(typeof onSelectTeam).toBe("function")
    onSelectTeam("team-x")
    expect(pushSpy).toHaveBeenCalledWith("/agent-teams/workspace?teamId=team-x")
  })

  it("passes onCreateTeam routing to /agent-teams", () => {
    render(<BottomToolbar session={session} />)
    const onCreateTeam = lastSelectorProps.onCreateTeam as () => void
    expect(typeof onCreateTeam).toBe("function")
    onCreateTeam()
    expect(pushSpy).toHaveBeenCalledWith("/agent-teams")
  })

  it("still passes selectedModeId + onModeChange (existing wiring intact)", () => {
    render(<BottomToolbar session={session} />)
    expect(lastSelectorProps.selectedModeId).toBe("general")
    expect(typeof lastSelectorProps.onModeChange).toBe("function")
  })

  it("passes disabled=true to child controls when streaming", () => {
    chatStoreState.status = "streaming"
    render(<BottomToolbar session={session} />)
    expect(lastSelectorProps.disabled).toBe(true)
  })

  it("passes disabled=false to child controls when idle", () => {
    render(<BottomToolbar session={session} />)
    expect(lastSelectorProps.disabled).toBe(false)
  })

  it("syncs externalAgentId to useExternalAgentStore on agent change", () => {
    agentRuntimeState.runtime = "external"
    render(<BottomToolbar session={session} />)
    const onAgentChange = lastSelectorProps.onAgentChange as (id: string | null) => void
    expect(typeof onAgentChange).toBe("function")
    onAgentChange("agent-1")
    expect(setActiveAgentMock).toHaveBeenCalledWith("agent-1")
  })
})
