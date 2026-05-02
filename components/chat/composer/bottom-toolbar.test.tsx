/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"
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
  AgentRuntimeSelector: () => null,
}))
jest.mock("@/components/agent/external-agent-selector", () => ({
  ExternalAgentSelector: () => null,
}))
jest.mock("../permission-mode-indicator", () => ({
  PermissionModeIndicator: () => null,
}))
jest.mock("./web-search-toggle", () => ({
  WebSearchToggle: () => null,
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

// Force the selector branch we care about: runtime === "claude-sdk".
jest.mock("@/stores/agent", () => ({
  useAgentRuntimeStore: <T,>(
    selector: (s: {
      runtime: string
      modeId: string
      setModeId: (s: string) => void
      externalAgentId: string | null
      setExternalAgentId: (id: string | null) => void
    }) => T
  ) =>
    selector({
      runtime: "claude-sdk",
      modeId: "general",
      setModeId: jest.fn(),
      externalAgentId: null,
      setExternalAgentId: jest.fn(),
    }),
}))

jest.mock("@/stores/chat", () => ({
  useChatStore: <T,>(selector: (s: { messages: unknown[]; setPermissionMode: jest.Mock }) => T) =>
    selector({ messages: [], setPermissionMode: jest.fn() }),
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
  for (const key of Object.keys(lastSelectorProps)) delete lastSelectorProps[key]
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
})
