/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"

jest.mock("@cognia/logging", () => {
  const makeLogger = (): Record<string, unknown> => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    child: () => makeLogger(),
  })
  return {
    loggers: new Proxy({}, { get: () => makeLogger() }),
    createLogger: () => makeLogger(),
  }
})

// The delete confirm's branch note is a Dexie live query.
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => 0 }))
// The long-press haptic is a Capacitor call.
jest.mock("@/lib/capacitor/haptics", () => ({ impact: jest.fn(async () => undefined) }))

jest.mock("@/hooks/workspace/use-move-session-workspace", () => ({
  useSessionWorkspaceMoveMenu: () => ({}),
}))
jest.mock("@/hooks/project-coordinator/use-continue-as-project-menu", () => ({
  useContinueAsProjectMenu: () => ({}),
}))
const mockOnActionsOpenChange = jest.fn()
let mockReturned: ((id: string) => void) | undefined
jest.mock("@/hooks/chat/use-session-desktop-handoffs", () => ({
  useSessionDesktopHandoffs: (_session: unknown, onReturned: (id: string) => void) => {
    mockReturned = onReturned
    return { onActionsOpenChange: mockOnActionsOpenChange, desktop: undefined }
  },
}))
jest.mock("@/components/thread-handoff/thread-handoff-source-dialog", () => ({
  ThreadHandoffSourceDialog: () => <div data-testid="handoff-dialog" />,
}))

import type {
  ConversationRowActions,
  ConversationRowExtraActions,
} from "@/hooks/chat/use-conversation-row-actions"
import type { RowDecorations } from "@/components/desktop/channel-list/row-decorations"
import type { SessionUsageSummary } from "@/lib/usage/session-analytics"
import type { ChatStatus } from "@/stores/chat/chat-store"
import type { Goal } from "@/types/goal"
import {
  ConversationManagerList,
  type ConversationManagerListProps,
} from "./conversation-manager-list"

const NOW = new Date(1_750_000_000_000)

const session = (id: string, over: Partial<ChatSession> = {}): ChatSession =>
  ({
    id,
    title: `Title ${id}`,
    kind: "direct",
    createdAt: NOW.getTime() - 86_400_000,
    updatedAt: NOW.getTime() - 2 * 3_600_000,
    ...over,
  }) as ChatSession

const decorations: RowDecorations = {
  iconFor: () => undefined,
  accentFor: () => undefined,
  metadataFor: () =>
    [
      { kind: "agent", value: "Researcher" },
      { kind: "model", value: "Opus" },
    ] as ReturnType<RowDecorations["metadataFor"]>,
}

const folders: SessionFolder[] = [{ id: "f1", name: "Planning" } as SessionFolder]

function rowActions(): ConversationRowActions {
  return {
    onDelete: jest.fn(async () => true),
    onRename: jest.fn(async () => true),
    onTogglePinned: jest.fn(async () => true),
    onArchive: jest.fn(async () => true),
    onUnarchive: jest.fn(async () => true),
    onAssignToFolder: jest.fn(async () => true),
  } as unknown as ConversationRowActions
}

const usageFor = (sessionId: string, turns: number, tokens: number): SessionUsageSummary =>
  ({
    sessionId,
    turns,
    tokens,
    inputTokens: tokens,
    outputTokens: 0,
    costUsd: 0.1,
    unpricedTurns: 0,
  }) as SessionUsageSummary

function setup(over: Partial<ConversationManagerListProps> = {}) {
  const props: ConversationManagerListProps = {
    rows: [session("s1"), session("s2")],
    selecting: false,
    onStartSelecting: jest.fn(),
    isSelected: () => false,
    onToggleSelect: jest.fn(),
    decorations,
    folders,
    usage: new Map(),
    runStatusById: new Map(),
    unreadCountById: new Map(),
    contentOnlyIds: new Set(),
    goals: new Map(),
    now: NOW,
    rowActions: rowActions(),
    extraActions: {} as ConversationRowExtraActions,
    onOpen: jest.fn(),
    ...over,
  }
  const view = render(<ConversationManagerList {...props} />)
  return { props, ...view }
}

beforeEach(() => {
  mockOnActionsOpenChange.mockReset()
  mockReturned = undefined
})

describe("ConversationManagerList", () => {
  it("draws one list item per conversation in a named list", () => {
    setup()
    const list = screen.getByRole("list", { name: "Conversations" })
    expect(within(list).getAllByRole("listitem")).toHaveLength(2)
    const row = screen.getByTestId("conversation-list-row-s1")
    expect(row).toHaveAttribute("data-conversation-row", "s1")
    expect(row).not.toHaveAttribute("data-state")
  })

  it("shows the title, pin, agent, activity and compact usage on two lines", () => {
    setup({
      rows: [session("s1", { pinned: true })],
      usage: new Map([["s1", usageFor("s1", 12, 42_000)]]),
    })
    const row = screen.getByTestId("conversation-list-row-s1")
    expect(within(row).getByText("Title s1")).toBeInTheDocument()
    expect(within(row).getByLabelText("Pinned")).toBeInTheDocument()
    expect(within(row).getByText("Researcher")).toBeInTheDocument()
    // The model only names a conversation that has no agent.
    expect(within(row).queryByText("Opus")).not.toBeInTheDocument()
    expect(within(row).getByText("12 turns · 42.0K")).toBeInTheDocument()
    // The setup's formatter renders a relative time as its ISO instant.
    expect(
      within(row).getByText(new Date(NOW.getTime() - 2 * 3_600_000).toISOString())
    ).toBeInTheDocument()
  })

  it("names a conversation with no agent by its model, and omits usage with no turns", () => {
    setup({
      rows: [session("s1")],
      decorations: {
        ...decorations,
        metadataFor: () =>
          [{ kind: "model", value: "Opus" }] as ReturnType<RowDecorations["metadataFor"]>,
      },
      usage: new Map([["s1", usageFor("s1", 0, 0)]]),
    })
    const row = screen.getByTestId("conversation-list-row-s1")
    expect(within(row).getByText("Opus")).toBeInTheDocument()
    expect(within(row).queryByText(/turns?/)).not.toBeInTheDocument()
  })

  it("shows a content match, the run state and unread on an active row", () => {
    setup({
      rows: [session("s1")],
      contentOnlyIds: new Set(["s1"]),
      runStatusById: new Map<string, ChatStatus>([["s1", "streaming"]]),
      unreadCountById: new Map([["s1", 3]]),
    })
    expect(screen.getByText("Matched in the messages")).toBeInTheDocument()
    expect(screen.getByTestId("conversation-list-run-s1-streaming")).toBeInTheDocument()
    expect(screen.getByTestId("conversation-list-unread-s1")).toBeInTheDocument()
  })

  it("shows no unread on an archived row", () => {
    setup({
      rows: [session("s1", { archivedAt: NOW.getTime() })],
      unreadCountById: new Map([["s1", 3]]),
    })
    expect(screen.queryByTestId("conversation-list-unread-s1")).not.toBeInTheDocument()
  })

  it("puts the conversation's goal on the second line, outside the row's button", () => {
    const goal = {
      id: "g1",
      sessionId: "s1",
      status: "active",
      awaitingAcceptance: false,
      turnsUsed: 4,
      config: { maxTurns: 20 },
      safeObjective: "Ship it",
      createdAt: 1,
    } as unknown as Goal
    setup({ rows: [session("s1")], goals: new Map([["s1", goal]]) })
    const chip = screen.getByTestId("conversation-goal-chip-g1")
    expect(chip).toHaveAttribute("href", "/goals?goal=g1")
    expect(chip).toHaveTextContent("4/20")
    // A link inside a button is not a valid tree.
    expect(screen.getByTestId("conversation-list-open-s1")).not.toContainElement(chip)
  })

  it("opens a conversation on a tap", () => {
    const { props } = setup()
    const open = screen.getByRole("button", { name: "Open Title s1" })
    expect(open).not.toHaveAttribute("aria-pressed")
    fireEvent.click(open)
    expect(props.onOpen).toHaveBeenCalledWith("s1")
    expect(props.onToggleSelect).not.toHaveBeenCalled()
  })

  it("opens where a conversation returned from Codex lands", () => {
    const { props } = setup({ rows: [session("s1")] })
    mockReturned?.("s-back")
    expect(props.onOpen).toHaveBeenCalledWith("s-back")
  })

  it("toggles instead of opening while selecting, with a drawn checkbox", () => {
    const { props } = setup({ selecting: true, isSelected: (id) => id === "s1" })
    const selected = screen.getByRole("button", { name: "Select Title s1" })
    expect(selected).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Select Title s2" })).toHaveAttribute(
      "aria-pressed",
      "false"
    )
    expect(screen.getByTestId("conversation-list-select-s1")).toHaveAttribute(
      "data-state",
      "checked"
    )
    expect(screen.getByTestId("conversation-list-select-s2")).toHaveAttribute(
      "data-state",
      "unchecked"
    )
    // Drawn, not a control: it is hidden from the accessibility tree.
    expect(screen.getByTestId("conversation-list-select-s1")).toHaveAttribute("aria-hidden")
    expect(screen.getByTestId("conversation-list-row-s1")).toHaveAttribute("data-state", "selected")

    fireEvent.click(screen.getByRole("button", { name: "Select Title s2" }))
    expect(props.onToggleSelect).toHaveBeenCalledWith("s2", {
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    })
    expect(props.onOpen).not.toHaveBeenCalled()
  })

  it("starts selecting on a long-press, without also opening the row", () => {
    jest.useFakeTimers()
    try {
      const { props } = setup({ rows: [session("s1")] })
      const open = screen.getByTestId("conversation-list-open-s1")
      fireEvent.pointerDown(open, { pointerType: "touch", button: 0, clientX: 5, clientY: 5 })
      act(() => {
        jest.advanceTimersByTime(600)
      })
      expect(props.onStartSelecting).toHaveBeenCalledWith("s1")
      fireEvent.pointerUp(open)
      fireEvent.click(open)
      expect(props.onOpen).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it("asks for selection mode from the row menu when not selecting", async () => {
    const user = userEvent.setup()
    const { props } = setup({ rows: [session("s1")] })
    await user.click(screen.getByTestId("conversation-list-actions-s1"))
    expect(mockOnActionsOpenChange).toHaveBeenCalledWith(true)
    await user.click(await screen.findByTestId("session-row-dropdown-select-s1"))
    expect(props.onStartSelecting).toHaveBeenCalledWith("s1")
    expect(props.onToggleSelect).not.toHaveBeenCalled()
  })

  it("toggles from the row menu while selecting", async () => {
    const user = userEvent.setup()
    const { props } = setup({ rows: [session("s1")], selecting: true })
    await user.click(screen.getByTestId("conversation-list-actions-s1"))
    await user.click(await screen.findByTestId("session-row-dropdown-select-s1"))
    expect(props.onToggleSelect).toHaveBeenCalledWith("s1", {
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    })
    expect(props.onStartSelecting).not.toHaveBeenCalled()
  })

  it("offers Rename in the row menu", async () => {
    const user = userEvent.setup()
    setup({ rows: [session("s1")] })
    await user.click(screen.getByTestId("conversation-list-actions-s1"))
    expect(await screen.findByTestId("session-row-dropdown-rename-s1")).not.toHaveAttribute(
      "data-disabled"
    )
  })

  // Regression: the row menu's Rename used to close the menu, which handed
  // focus back to its trigger, blurred the new field and cancelled the rename.
  it("renames in place from the row menu, committing on Enter", async () => {
    const user = userEvent.setup()
    const { props } = setup({ rows: [session("s1")] })
    await user.click(screen.getByTestId("conversation-list-actions-s1"))
    await user.click(await screen.findByTestId("session-row-dropdown-rename-s1"))
    const input = await screen.findByTestId("conversation-list-rename-s1", undefined, {
      timeout: 500,
    })
    expect(input).toHaveAccessibleName("Rename “Title s1”")
    expect(screen.queryByTestId("conversation-list-open-s1")).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: "Q3 plan" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(props.rowActions.onRename).toHaveBeenCalledWith("s1", "Q3 plan")
    expect(screen.queryByTestId("conversation-list-rename-s1")).not.toBeInTheDocument()
  })

  it("archives an active row and unarchives an archived one from the row menu", async () => {
    const user = userEvent.setup()
    const { props } = setup({
      rows: [session("s1"), session("old", { archivedAt: NOW.getTime() })],
    })
    await user.click(screen.getByTestId("conversation-list-actions-s1"))
    await user.click(await screen.findByTestId("session-row-dropdown-archive-s1"))
    expect(props.rowActions.onArchive).toHaveBeenCalledWith("s1")

    await user.click(screen.getByTestId("conversation-list-actions-old"))
    await user.click(await screen.findByTestId("session-row-dropdown-unarchive-old"))
    expect(props.rowActions.onUnarchive).toHaveBeenCalledWith("old")
  })

  it("pins from the row menu", async () => {
    const user = userEvent.setup()
    const { props } = setup({ rows: [session("s1")] })
    await user.click(screen.getByTestId("conversation-list-actions-s1"))
    await user.click(await screen.findByTestId("session-row-dropdown-pin-s1"))
    expect(props.rowActions.onTogglePinned).toHaveBeenCalledWith("s1", true)
  })

  it("confirms a delete before it writes", async () => {
    const user = userEvent.setup()
    const { props } = setup({ rows: [session("s1")] })
    await user.click(screen.getByTestId("conversation-list-actions-s1"))
    await user.click(await screen.findByTestId("session-row-dropdown-delete-s1"))
    const dialog = await screen.findByTestId("conversation-delete-confirm")
    expect(props.rowActions.onDelete).not.toHaveBeenCalled()
    await user.click(within(dialog).getByTestId("conversation-delete-confirm-action"))
    expect(props.rowActions.onDelete).toHaveBeenCalledWith("s1")
  })

  it("gives the row menu a touch-sized trigger named for the conversation", () => {
    setup({ rows: [session("s1")] })
    const trigger = screen.getByRole("button", { name: "Actions for Title s1" })
    expect(trigger.className).toContain("size-11")
  })
})
