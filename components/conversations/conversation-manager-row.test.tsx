/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useFormatter: () => ({
    dateTime: (value: Date) => `dt(${value.getTime()})`,
    relativeTime: (value: Date, now: Date) => `rel(${now.getTime() - value.getTime()})`,
  }),
}))

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
import {
  ConversationManagerRow,
  type ConversationManagerRowProps,
} from "./conversation-manager-row"

const NOW = new Date(1_750_000_000_000)

const session = (over: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: "s1",
    title: "Quarterly plan",
    kind: "direct",
    createdAt: NOW.getTime() - 86_400_000,
    updatedAt: NOW.getTime() - 60_000,
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

function setup(over: Partial<ConversationManagerRowProps> = {}) {
  const props: ConversationManagerRowProps = {
    session: session(),
    selected: false,
    onToggleSelect: jest.fn(),
    decorations,
    workspaceName: "Cognia",
    folders,
    usage: undefined,
    runStatus: undefined,
    unread: 0,
    contentMatch: false,
    now: NOW,
    rowActions: rowActions(),
    extraActions: {} as ConversationRowExtraActions,
    onOpen: jest.fn(),
    ...over,
  }
  render(
    <table>
      <tbody>
        <ConversationManagerRow {...props} />
      </tbody>
    </table>
  )
  return props
}

beforeEach(() => {
  mockOnActionsOpenChange.mockReset()
  mockReturned = undefined
})

describe("ConversationManagerRow", () => {
  it("shows the conversation's facts in its columns", () => {
    const usage: SessionUsageSummary = {
      sessionId: "s1",
      turns: 4,
      tokens: 12_345,
      inputTokens: 10_000,
      outputTokens: 2_345,
      costUsd: 0.42,
      unpricedTurns: 0,
    } as SessionUsageSummary
    setup({ usage })
    const row = screen.getByTestId("conversation-row-s1")
    expect(within(row).getByText("Cognia")).toBeInTheDocument()
    expect(within(row).getByText("Researcher")).toBeInTheDocument()
    expect(within(row).getByText("Opus")).toBeInTheDocument()
    expect(within(row).getByText("rel(60000)")).toBeInTheDocument()
    expect(within(row).getByText(`dt(${NOW.getTime() - 86_400_000})`)).toBeInTheDocument()
    expect(within(row).getByText("4")).toBeInTheDocument()
    expect(within(row).getByText("12.3K")).toBeInTheDocument()
  })

  it("names a conversation with no agent by its model alone", () => {
    setup({
      decorations: {
        ...decorations,
        metadataFor: () =>
          [{ kind: "model", value: "Opus" }] as ReturnType<RowDecorations["metadataFor"]>,
      },
    })
    const row = screen.getByTestId("conversation-row-s1")
    expect(within(row).getAllByText("Opus")).toHaveLength(1)
  })

  it("says none where a fact is missing", () => {
    setup({ workspaceName: undefined, decorations: { ...decorations, metadataFor: () => [] } })
    const row = screen.getByTestId("conversation-row-s1")
    expect(within(row).getByText("noWorkspace")).toBeInTheDocument()
    // agent, tokens and cost read "none" for a conversation with no turns
    expect(within(row).getAllByText("none")).toHaveLength(3)
  })

  it("opens the conversation from its title", () => {
    const props = setup()
    fireEvent.click(screen.getByTestId("conversation-row-open-s1"))
    expect(props.onOpen).toHaveBeenCalledWith("s1")
  })

  it("opens where a conversation returned from Codex lands", () => {
    const props = setup()
    mockReturned?.("s-back")
    expect(props.onOpen).toHaveBeenCalledWith("s-back")
  })

  it("toggles selection as a modified click, extending with Shift", () => {
    const props = setup()
    fireEvent.click(screen.getByTestId("conversation-row-select-s1"))
    expect(props.onToggleSelect).toHaveBeenLastCalledWith("s1", {
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    })
    fireEvent.click(screen.getByTestId("conversation-row-select-s1"), { shiftKey: true })
    expect(props.onToggleSelect).toHaveBeenLastCalledWith("s1", {
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    })
  })

  it("renames in place with F2 and commits on Enter", () => {
    const props = setup()
    fireEvent.keyDown(screen.getByTestId("conversation-row-open-s1"), { key: "F2" })
    const input = screen.getByTestId("conversation-row-rename-s1")
    fireEvent.change(input, { target: { value: "Q3 plan" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(props.rowActions.onRename).toHaveBeenCalledWith("s1", "Q3 plan")
    expect(screen.queryByTestId("conversation-row-rename-s1")).not.toBeInTheDocument()
  })

  it("asks before deleting on Delete or ⌘Backspace from the title", () => {
    const props = setup()
    const title = screen.getByTestId("conversation-row-open-s1")
    expect(title).toHaveAttribute("aria-keyshortcuts", expect.stringContaining("F2 Delete"))
    fireEvent.keyDown(title, { key: "Delete" })
    expect(screen.getByTestId("conversation-delete-confirm")).toBeInTheDocument()
    expect(props.rowActions.onDelete).not.toHaveBeenCalled()
  })

  it("reads ⌘Backspace as delete too, but not with Alt or Ctrl held", () => {
    setup()
    const title = screen.getByTestId("conversation-row-open-s1")
    fireEvent.keyDown(title, { key: "Delete", ctrlKey: true })
    expect(screen.queryByTestId("conversation-delete-confirm")).not.toBeInTheDocument()
    fireEvent.keyDown(title, { key: "Backspace", metaKey: true })
    expect(screen.getByTestId("conversation-delete-confirm")).toBeInTheDocument()
  })

  it("does not rename a handed-off conversation", () => {
    setup({ session: session({ handoffLock: { ticketId: "t1", state: "committed", at: 1 } }) })
    fireEvent.doubleClick(screen.getByTestId("conversation-row-open-s1"))
    expect(screen.queryByTestId("conversation-row-rename-s1")).not.toBeInTheDocument()
    expect(screen.getByLabelText("handoffReadonly")).toBeInTheDocument()
    // Nor delete it: every write to a handed-off row is refused.
    fireEvent.keyDown(screen.getByTestId("conversation-row-open-s1"), { key: "Delete" })
    expect(screen.queryByTestId("conversation-delete-confirm")).not.toBeInTheDocument()
  })

  it("shows pin, folder, content match, and unread on an active row", () => {
    setup({
      session: session({ pinned: true, folderId: "f1" }),
      contentMatch: true,
      unread: 3,
    })
    expect(screen.getByLabelText("pinned")).toBeInTheDocument()
    expect(screen.getByTestId("conversation-row-folder-s1")).toHaveTextContent(
      'inFolder:{"name":"Planning"}'
    )
    expect(screen.getByText("contentMatch")).toBeInTheDocument()
    expect(screen.getByTestId("conversation-row-unread-s1")).toBeInTheDocument()
  })

  it("keeps an archived row's pin and folder as facts but shows no unread", () => {
    setup({
      session: session({ pinned: true, folderId: "f1", archivedAt: NOW.getTime() }),
      unread: 3,
    })
    expect(screen.getByLabelText("pinned")).toBeInTheDocument()
    expect(screen.getByTestId("conversation-row-folder-s1")).toBeInTheDocument()
    expect(screen.queryByTestId("conversation-row-unread-s1")).not.toBeInTheDocument()
  })

  it("draws the run state", () => {
    setup({ runStatus: "streaming" })
    expect(screen.getByTestId("conversation-row-run-s1-streaming")).toBeInTheDocument()
  })

  it("archives from the row menu and probes desktop hand-offs when it opens", async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(screen.getByTestId("conversation-row-actions-s1"))
    expect(mockOnActionsOpenChange).toHaveBeenCalledWith(true)
    // The active row's menu pins and files — what the archive freezes.
    expect(await screen.findByRole("menuitem", { name: /^pin/ })).toBeInTheDocument()
    expect(screen.getByText("moveToFolder")).toBeInTheDocument()
    await user.click(await screen.findByRole("menuitem", { name: /^archive/ }))
    expect(props.rowActions.onArchive).toHaveBeenCalledWith("s1")
  })

  it("freezes pin and folder on an archived row's menu and offers unarchive", async () => {
    const user = userEvent.setup()
    const props = setup({ session: session({ archivedAt: NOW.getTime(), folderId: "f1" }) })
    await user.click(screen.getByTestId("conversation-row-actions-s1"))
    const menu = await screen.findByRole("menu")
    expect(within(menu).queryByRole("menuitem", { name: /^pin/ })).not.toBeInTheDocument()
    expect(within(menu).queryByText("moveToFolder")).not.toBeInTheDocument()
    await user.click(within(menu).getByRole("menuitem", { name: /^unarchive/ }))
    expect(props.rowActions.onUnarchive).toHaveBeenCalledWith("s1")
  })

  it("confirms a delete before it writes", async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(screen.getByTestId("conversation-row-actions-s1"))
    await user.click(await screen.findByRole("menuitem", { name: /^delete/ }))
    const dialog = await screen.findByTestId("conversation-delete-confirm")
    expect(props.rowActions.onDelete).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole("button", { name: "deleteConfirmAction" }))
    expect(props.rowActions.onDelete).toHaveBeenCalledWith("s1")
  })
})
