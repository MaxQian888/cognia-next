/** @jest-environment jsdom */

// One agent's detail (ADR-0220): the masthead's verbs per mode and source, and
// which body each mode draws — the profile, the form, or the full-width board.
// Children are stubbed to probes that record their props.

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { Character } from "@cognia/agent-config-types"
import type { AgentCatalogs } from "@/hooks/agents/use-agent-catalogs"
import type { AgentSource } from "@/lib/agents/agent-source"
import type { AgentDetailMode } from "@/lib/agents/routes"

let mockSource: AgentSource
jest.mock("@/lib/agents/agent-source", () => ({
  describeAgentSource: () => mockSource,
}))

let mockActivity: { status: "idle" | "running" | "awaiting" } | undefined
jest.mock("@/hooks/agents/use-agent-activity", () => ({
  useAgentActivity: () => mockActivity,
}))

const mockDuplicate = jest.fn()
jest.mock("@/hooks/agents/use-agent-actions", () => ({
  useAgentActions: () => ({ duplicate: mockDuplicate }),
}))

jest.mock("@/hooks/plugins/use-plugin-metadata", () => ({
  usePluginMetadata: (id?: string) => (id ? { name: "Pack Plugin" } : undefined),
}))

jest.mock("../agent-visuals", () => ({
  AgentAvatar: () => <span data-testid="avatar" />,
  AgentSourceBadges: () => null,
  AgentStatusLabel: ({ status }: { status: string }) => (
    <span data-testid="status-label">{status}</span>
  ),
}))

jest.mock("../agent-actions-menu", () => ({
  AgentActionsMenu: () => <div data-testid="actions-menu" />,
}))

let assignProps: { open: boolean; onOpenChange: (open: boolean) => void } | undefined
jest.mock("./agent-assign-work-dialog", () => ({
  AgentAssignWorkDialog: (props: { open: boolean; onOpenChange: (open: boolean) => void }) => {
    assignProps = props
    return props.open ? <div data-testid="assign-dialog" /> : null
  },
}))

let editProps: { editable: boolean; onDone: () => void; onDuplicate: () => void } | undefined
jest.mock("./agent-edit-view", () => ({
  AgentEditView: (props: { editable: boolean; onDone: () => void; onDuplicate: () => void }) => {
    editProps = props
    return <div data-testid="edit-stub" />
  },
}))

let profileProps:
  | { sourceLabel: string; onEdit?: () => void; onOpenTasks: () => void; compact?: boolean }
  | undefined
jest.mock("./agent-profile", () => ({
  AgentProfile: (props: NonNullable<typeof profileProps>) => {
    profileProps = props
    return <div data-testid="profile-stub" />
  },
}))

let boardProps: { agentId: string; showCreateForm?: boolean } | undefined
jest.mock("@/components/agent/agent-task-board", () => ({
  AgentTaskBoard: (props: { agentId: string; showCreateForm?: boolean }) => {
    boardProps = props
    return <div data-testid="board-stub" />
  },
}))

import { AgentDetailView } from "./agent-detail-view"

function agent(over: Partial<Character> = {}): Character {
  return {
    id: "char_1",
    name: "Alpha",
    description: "Does things.",
    avatarColor: "#123456",
    systemPrompt: "",
    createdAt: 1,
    updatedAt: 2,
    ...over,
  } as Character
}

function source(over: Partial<AgentSource> = {}): AgentSource {
  return {
    isOverlay: false,
    isCloned: false,
    fromLocalFile: false,
    updateAvailable: false,
    warnings: [],
    editable: true,
    deletable: true,
    ...over,
  }
}

const catalogs = { skills: [], mcpServers: [], knowledgeBases: [] } as unknown as AgentCatalogs

function renderDetail(
  mode: AgentDetailMode = "overview",
  props: Partial<React.ComponentProps<typeof AgentDetailView>> = {}
) {
  const handlers = {
    onModeChange: jest.fn(),
    onOpenAgent: jest.fn(),
    onDeleted: jest.fn(),
    onStartChat: jest.fn(),
  }
  const a = props.agent ?? agent()
  render(
    <AgentDetailView
      agent={a}
      agents={[a]}
      catalogs={catalogs}
      mode={mode}
      {...handlers}
      {...props}
    />
  )
  return { ...handlers, agent: a }
}

beforeEach(() => {
  mockSource = source()
  mockActivity = { status: "idle" }
  mockDuplicate.mockReset()
  assignProps = undefined
  editProps = undefined
  profileProps = undefined
  boardProps = undefined
})

describe("AgentDetailView — overview", () => {
  it("names the agent and draws the profile with its source label", () => {
    renderDetail()
    expect(screen.getByTestId("agent-detail")).toHaveAttribute("data-mode", "overview")
    expect(screen.getByTestId("agent-detail-name")).toHaveTextContent("Alpha")
    expect(screen.getByText("Does things.")).toBeInTheDocument()
    expect(screen.getByTestId("profile-stub")).toBeInTheDocument()
    expect(profileProps?.sourceLabel).toBe("Created by you")
    expect(screen.queryByTestId("agent-edit-back")).not.toBeInTheDocument()
  })

  it("says when there is no description", () => {
    renderDetail("overview", { agent: agent({ description: "" }) })
    expect(screen.getByText("No description.")).toBeInTheDocument()
  })

  it("shows the live status word only when the agent is not idle", () => {
    renderDetail()
    expect(screen.queryByTestId("status-label")).not.toBeInTheDocument()
  })

  it("shows the live status word while the agent works", () => {
    mockActivity = { status: "running" }
    renderDetail()
    expect(screen.getByTestId("status-label")).toHaveTextContent("running")
  })

  it("starts a chat, opens Assign work, and switches to edit", () => {
    const { onStartChat, onModeChange, agent: a } = renderDetail()
    fireEvent.click(screen.getByTestId("agent-start-chat"))
    expect(onStartChat).toHaveBeenCalledWith(a)
    fireEvent.click(screen.getByTestId("agent-assign-work"))
    expect(screen.getByTestId("assign-dialog")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("agent-edit"))
    expect(onModeChange).toHaveBeenCalledWith("edit")
    expect(screen.getByTestId("actions-menu")).toBeInTheDocument()
  })

  it("disables Chat while a chat is starting", () => {
    renderDetail("overview", { starting: true })
    expect(screen.getByTestId("agent-start-chat")).toBeDisabled()
  })

  it("routes the profile's board link and Edit to their modes", () => {
    const { onModeChange } = renderDetail("overview", { compact: true })
    profileProps?.onOpenTasks()
    expect(onModeChange).toHaveBeenCalledWith("tasks")
    profileProps?.onEdit?.()
    expect(onModeChange).toHaveBeenCalledWith("edit")
    expect(profileProps?.compact).toBe(true)
  })

  it("offers Duplicate to edit for an agent that cannot be edited in place", async () => {
    mockSource = source({ editable: false })
    mockDuplicate.mockResolvedValue({ id: "copy_1" })
    const { onOpenAgent } = renderDetail("overview", { agent: agent({ isBuiltIn: true }) })
    expect(screen.queryByTestId("agent-edit")).not.toBeInTheDocument()
    expect(profileProps?.onEdit).toBeUndefined()
    expect(profileProps?.sourceLabel).toBe("Built-in")
    fireEvent.click(screen.getByTestId("agent-duplicate-to-edit"))
    await waitFor(() => expect(onOpenAgent).toHaveBeenCalledWith("copy_1", "edit"))
  })

  it("stays put when the duplicate fails", async () => {
    mockSource = source({ editable: false })
    mockDuplicate.mockResolvedValue(undefined)
    const { onOpenAgent } = renderDetail()
    fireEvent.click(screen.getByTestId("agent-duplicate-to-edit"))
    await waitFor(() => expect(mockDuplicate).toHaveBeenCalled())
    expect(onOpenAgent).not.toHaveBeenCalled()
  })

  it.each([
    [{ isOverlay: true, fromLocalFile: true }, "From local file"],
    [{ isOverlay: true, sourcePluginId: "p1" }, "Pack Plugin"],
    [{ isCloned: true, sourcePluginId: "p1" }, "Pack Plugin"],
  ] as const)("words the source of %o", (over, expected) => {
    mockSource = source(over)
    renderDetail()
    expect(profileProps?.sourceLabel).toContain(expected)
  })
})

describe("AgentDetailView — edit", () => {
  it("swaps the profile for the form, with a way back and no action bar", () => {
    const { onModeChange } = renderDetail("edit")
    expect(screen.getByTestId("edit-stub")).toBeInTheDocument()
    expect(screen.queryByTestId("profile-stub")).not.toBeInTheDocument()
    expect(screen.getByTestId("agent-detail-name")).toHaveTextContent("Editing Alpha")
    expect(screen.queryByTestId("agent-start-chat")).not.toBeInTheDocument()
    expect(screen.queryByTestId("agent-assign-work")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("agent-edit-back"))
    expect(onModeChange).toHaveBeenCalledWith("overview")
    editProps?.onDone()
    expect(onModeChange).toHaveBeenCalledTimes(2)
    expect(editProps?.editable).toBe(true)
  })
})

describe("AgentDetailView — tasks", () => {
  it("gives the task board the whole body, keeps Assign work, and leads back to the profile", () => {
    const { onModeChange } = renderDetail("tasks")
    expect(screen.getByTestId("board-stub")).toBeInTheDocument()
    expect(boardProps).toMatchObject({
      agentId: "char_1",
      showCreateForm: false,
      className: "flex-1",
    })
    expect(screen.queryByTestId("profile-stub")).not.toBeInTheDocument()
    expect(screen.getByTestId("agent-detail-name")).toHaveTextContent("Alpha · Task board")
    expect(screen.queryByTestId("agent-start-chat")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("agent-assign-work"))
    expect(assignProps?.open).toBe(true)
    fireEvent.click(screen.getByTestId("agent-edit-back"))
    expect(onModeChange).toHaveBeenCalledWith("overview")
  })
})
