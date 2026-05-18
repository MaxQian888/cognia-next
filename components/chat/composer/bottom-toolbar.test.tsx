/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { BottomToolbar } from "./bottom-toolbar"
import type { ChatSession } from "@/lib/claude/types"

// Mock next-intl translations.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Capture router.push calls.
const pushSpy = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy, replace: jest.fn(), prefetch: jest.fn(), back: jest.fn() }),
}))

// Stub the heavier sibling components — we only care about props.
const lastSelectorProps: Record<string, unknown> = {}
jest.mock("@/components/agent/agent-mode-selector", () => ({
  AgentModeSelector: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return <div data-testid="agent-mode-selector" />
  },
}))
jest.mock("@/components/agent/agent-runtime-selector", () => ({
  AgentRuntimeSelector: (props: Record<string, unknown>) => {
    Object.assign(lastSelectorProps, props)
    return <div data-testid="agent-runtime-selector" />
  },
}))
jest.mock("@/components/agent/external-agent-selector", () => ({
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
})

describe("BottomToolbar — agent-mode wiring", () => {
  it("passes onSelectTeam routing to /agent-teams/[teamId]", () => {
    render(<BottomToolbar session={session} />)
    const onSelectTeam = lastSelectorProps.onSelectTeam as (id: string) => void
    expect(typeof onSelectTeam).toBe("function")
    onSelectTeam("team-x")
    expect(pushSpy).toHaveBeenCalledWith("/agent-teams/team-x")
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
