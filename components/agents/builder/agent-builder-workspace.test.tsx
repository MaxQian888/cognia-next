/** @jest-environment jsdom */

// "Build with AI", step two (ADR-0220): the builder conversation and the live
// draft, side by side or as tabs on a narrow window. The chat, the draft panel
// and the runtime selector are stubbed probes that record their props.

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { AgentBuilderSessionState, ChatSession } from "@cognia/agent-config-types"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("@/lib/chat/session-archive-writes", () => ({ deleteSessionsRouted: jest.fn() }))
const mockToastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}))
jest.mock("@/stores/settings", () => ({ useSettingsStore: jest.fn() }))
jest.mock("@/hooks/agents/use-agent-catalogs", () => ({ useAgentCatalogs: jest.fn() }))
jest.mock("@/hooks/agents/use-builder-tool-support", () => ({ useBuilderToolSupport: jest.fn() }))
jest.mock("@/hooks/ui/use-compact-layout", () => ({ useCompactLayout: jest.fn() }))
jest.mock("@/components/agent/mode/runtime-selector", () => ({
  AgentRuntimeSelector: (props: { sessionId: string; providerId: string }) => (
    <div
      data-testid="runtime-selector"
      data-session={props.sessionId}
      data-provider={props.providerId}
    />
  ),
}))
jest.mock("./agent-builder-chat", () => ({
  AgentBuilderChat: (props: { session: ChatSession }) => (
    <div data-testid="builder-chat" data-session={props.session.id} />
  ),
}))
interface PanelProps {
  sessionId: string
  state: AgentBuilderSessionState
  catalogs: unknown
  onCreated: (agent: { id: string }) => void
  onDiscard: () => void
}
let panelProps: PanelProps | undefined
jest.mock("./agent-builder-draft-panel", () => ({
  AgentBuilderDraftPanel: (props: PanelProps) => {
    panelProps = props
    return (
      <div data-testid="draft-panel">
        <button type="button" onClick={props.onDiscard}>
          stub-discard
        </button>
      </div>
    )
  },
}))

import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import { deleteSessionsRouted } from "@/lib/chat/session-archive-writes"
import { useSettingsStore } from "@/stores/settings"
import { useAgentCatalogs } from "@/hooks/agents/use-agent-catalogs"
import { useBuilderToolSupport } from "@/hooks/agents/use-builder-tool-support"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { AgentBuilderWorkspace, type AgentBuilderWorkspaceProps } from "./agent-builder-workspace"

const useLiveQueryMock = useLiveQuery as jest.Mock
const getDbMock = getDb as jest.Mock
const deleteMock = deleteSessionsRouted as jest.Mock
const useSettingsStoreMock = useSettingsStore as unknown as jest.Mock
const useCatalogsMock = useAgentCatalogs as jest.Mock
const useToolSupportMock = useBuilderToolSupport as jest.Mock
const useCompactMock = useCompactLayout as jest.Mock

const catalogs = { skills: [], mcpServers: [], knowledgeBases: [] }

function builderState(over: Partial<AgentBuilderSessionState> = {}): AgentBuilderSessionState {
  return {
    draft: { name: "Reviewer" },
    revision: 1,
    editedBy: "agent",
    status: "drafting",
    updatedAt: 10,
    ...over,
  }
}

function builderSession(over: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s1",
    title: "Agent Builder",
    kind: "agent-builder",
    agentBuilder: builderState(),
    ...over,
  } as unknown as ChatSession
}

let mockSession: ChatSession | null | undefined
let defaultProvider: string | undefined
const sessionsGet = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  panelProps = undefined
  mockSession = builderSession()
  defaultProvider = "openai"
  useLiveQueryMock.mockImplementation(() => mockSession)
  sessionsGet.mockResolvedValue(mockSession)
  getDbMock.mockReturnValue({ sessions: { get: sessionsGet } })
  deleteMock.mockResolvedValue(undefined)
  useSettingsStoreMock.mockImplementation(
    (selector: (s: { settings?: { defaultProvider?: string } }) => unknown) =>
      selector({ settings: { defaultProvider } })
  )
  useCatalogsMock.mockReturnValue(catalogs)
  useToolSupportMock.mockReturnValue("supported")
  useCompactMock.mockReturnValue(false)
})

function props(over: Partial<AgentBuilderWorkspaceProps> = {}): AgentBuilderWorkspaceProps {
  return { sessionId: "s1", onOpenAgent: jest.fn(), onLeave: jest.fn(), ...over }
}

describe("reading the session", () => {
  it("reads the builder session by id", async () => {
    render(<AgentBuilderWorkspace {...props()} />)
    const [querier, deps] = useLiveQueryMock.mock.calls[0]! as [() => Promise<unknown>, unknown[]]
    expect(deps).toEqual(["s1"])
    await expect(querier()).resolves.toBe(mockSession)
    expect(sessionsGet).toHaveBeenCalledWith("s1")
    sessionsGet.mockResolvedValue(undefined)
    await expect(querier()).resolves.toBeNull()
  })

  it("says it is loading until the read settles", () => {
    mockSession = undefined
    render(<AgentBuilderWorkspace {...props()} />)
    expect(screen.getByText("Loading the builder…")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-builder-workspace")).not.toBeInTheDocument()
  })

  it.each([
    ["was deleted", null],
    ["is not a builder", builderSession({ kind: undefined })],
    ["has no builder state", builderSession({ agentBuilder: undefined })],
  ])("offers the way back when the conversation %s", async (_n, s) => {
    const user = userEvent.setup()
    mockSession = s
    const p = props()
    render(<AgentBuilderWorkspace {...p} />)
    const missing = screen.getByTestId("agent-builder-missing")
    expect(within(missing).getByText("Draft not found")).toBeInTheDocument()
    expect(within(missing).getByText(/isn't building an agent/)).toBeInTheDocument()
    await user.click(within(missing).getByRole("button", { name: "Back to agents" }))
    expect(p.onLeave).toHaveBeenCalledTimes(1)
  })
})

describe("desktop layout", () => {
  it("puts the conversation and the draft side by side under the header", () => {
    render(<AgentBuilderWorkspace {...props()} />)
    expect(screen.getByTestId("agent-builder-workspace")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Agent Builder" })).toBeInTheDocument()
    expect(screen.getByTestId("builder-chat")).toHaveAttribute("data-session", "s1")
    expect(screen.getByTestId("draft-panel")).toBeInTheDocument()
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
    expect(useToolSupportMock).toHaveBeenCalledWith("s1")
  })

  it("names the runtime on the session's provider, falling back to the default, then Anthropic", () => {
    mockSession = builderSession({ providerOverride: "deepseek" })
    const { unmount } = render(<AgentBuilderWorkspace {...props()} />)
    expect(screen.getByTestId("runtime-selector")).toHaveAttribute("data-provider", "deepseek")
    expect(screen.getByTestId("runtime-selector")).toHaveAttribute("data-session", "s1")
    unmount()

    mockSession = builderSession()
    const second = render(<AgentBuilderWorkspace {...props()} />)
    expect(screen.getByTestId("runtime-selector")).toHaveAttribute("data-provider", "openai")
    second.unmount()

    defaultProvider = undefined
    render(<AgentBuilderWorkspace {...props()} />)
    expect(screen.getByTestId("runtime-selector")).toHaveAttribute("data-provider", "anthropic")
  })

  it("warns when the runtime cannot edit the draft", () => {
    useToolSupportMock.mockReturnValue("unsupported")
    render(<AgentBuilderWorkspace {...props()} />)
    expect(screen.getByTestId("agent-builder-tools-unsupported")).toHaveTextContent(
      "This runtime can't edit the draft — fill it in yourself"
    )
  })

  it("does not warn otherwise", () => {
    render(<AgentBuilderWorkspace {...props()} />)
    expect(screen.queryByTestId("agent-builder-tools-unsupported")).not.toBeInTheDocument()
  })
})

describe("draft panel", () => {
  it("feeds the panel the session, its builder state and the catalogs", () => {
    render(<AgentBuilderWorkspace {...props()} />)
    expect(panelProps?.sessionId).toBe("s1")
    expect(panelProps?.state).toEqual(builderState())
    expect(panelProps?.catalogs).toBe(catalogs)
  })

  it("opens the agent the panel created", () => {
    const p = props()
    render(<AgentBuilderWorkspace {...p} />)
    panelProps?.onCreated({ id: "char_new" })
    expect(p.onOpenAgent).toHaveBeenCalledWith("char_new")
  })

  it("asks before discarding, then deletes the conversation and leaves", async () => {
    const user = userEvent.setup()
    const p = props()
    render(<AgentBuilderWorkspace {...p} />)
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "stub-discard" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText("Discard this draft?")).toBeInTheDocument()
    expect(
      within(dialog).getByText(/this builder conversation will be deleted/)
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "Discard" }))
    expect(deleteMock).toHaveBeenCalledWith(["s1"])
    await waitFor(() => expect(p.onLeave).toHaveBeenCalledTimes(1))
  })

  it("stays and says so when the discard fails", async () => {
    const user = userEvent.setup()
    const p = props()
    deleteMock.mockRejectedValueOnce(new Error("locked"))
    render(<AgentBuilderWorkspace {...p} />)
    await user.click(screen.getByRole("button", { name: "stub-discard" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Discard" }))
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Couldn't discard the draft: locked")
    )
    expect(p.onLeave).not.toHaveBeenCalled()
  })

  it("keeps the draft when the discard is cancelled", async () => {
    const user = userEvent.setup()
    const p = props()
    render(<AgentBuilderWorkspace {...p} />)
    await user.click(screen.getByRole("button", { name: "stub-discard" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(deleteMock).not.toHaveBeenCalled()
    expect(p.onLeave).not.toHaveBeenCalled()
  })
})

describe("created draft", () => {
  it("replaces the form with a link to the created agent", async () => {
    const user = userEvent.setup()
    mockSession = builderSession({
      agentBuilder: builderState({ status: "created", createdCharacterId: "char_9" }),
    })
    const p = props()
    render(<AgentBuilderWorkspace {...p} />)
    const created = screen.getByTestId("agent-builder-created")
    expect(screen.queryByTestId("draft-panel")).not.toBeInTheDocument()
    expect(within(created).getByText("Agent created")).toBeInTheDocument()
    expect(within(created).getByText(/The draft is closed/)).toBeInTheDocument()
    await user.click(within(created).getByRole("button", { name: "Open agent" }))
    expect(p.onOpenAgent).toHaveBeenCalledWith("char_9")
  })

  it("has no link when the created agent's id is unknown", () => {
    mockSession = builderSession({ agentBuilder: builderState({ status: "created" }) })
    render(<AgentBuilderWorkspace {...props()} />)
    expect(screen.getByTestId("agent-builder-created")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Open agent" })).not.toBeInTheDocument()
  })
})

describe("compact layout", () => {
  it("shows the conversation first and the draft on its own tab", async () => {
    useCompactMock.mockReturnValue(true)
    const user = userEvent.setup()
    render(<AgentBuilderWorkspace {...props()} />)
    const chatTab = screen.getByRole("tab", { name: "Chat" })
    const draftTab = screen.getByRole("tab", { name: "Draft" })
    expect(chatTab).toHaveAttribute("aria-selected", "true")
    expect(screen.getByTestId("builder-chat")).toBeInTheDocument()
    expect(screen.queryByTestId("draft-panel")).not.toBeInTheDocument()

    await user.click(draftTab)
    expect(screen.getByRole("tab", { name: "Draft" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByTestId("draft-panel")).toBeInTheDocument()
    expect(screen.queryByTestId("builder-chat")).not.toBeInTheDocument()

    await user.click(screen.getByRole("tab", { name: "Chat" }))
    expect(screen.getByTestId("builder-chat")).toBeInTheDocument()
  })
})
