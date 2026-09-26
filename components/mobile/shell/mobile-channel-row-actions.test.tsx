/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const moveToWorkspace = jest.fn()
let workspaceTargets = [
  { id: "w1", name: "Alpha" },
  { id: "w2", name: "Beta" },
]
jest.mock("@/hooks/workspace/use-move-session-workspace", () => ({
  useSessionWorkspaceMoveMenu: (session: { projectId?: string }) => ({
    workspaceTargets,
    canMoveWorkspace: workspaceTargets.some((workspace) => workspace.id !== session.projectId),
    movingWorkspace: false,
    onMoveWorkspace: (id: string) => moveToWorkspace(id),
  }),
}))

import {
  MobileChannelRowActions,
  type MobileChannelRowActionsProps,
} from "./mobile-channel-row-actions"

const session: ChatSession = {
  id: "s1",
  title: "Daily standup",
  createdAt: 1,
  updatedAt: 1,
  kind: "direct",
  projectId: "w1",
}

const folder = (id: string, projectId?: string): SessionFolder =>
  ({ id, name: `Folder ${id}`, order: 0, createdAt: 0, updatedAt: 0, projectId }) as SessionFolder

/** The sheet's items are the shared row menu's, named `session-row-sheet-<action>-<id>`. */
const item = (action: string, id = "s1") => `session-row-sheet-${action}-${id}`

function renderActions(overrides: Partial<MobileChannelRowActionsProps> = {}) {
  const props: MobileChannelRowActionsProps = {
    session,
    unread: 0,
    folders: [],
    onClose: jest.fn(),
    onRename: jest.fn(),
    onContinueOnDevice: jest.fn(),
    onDelete: jest.fn(),
    rowActions: {
      onTogglePinned: jest.fn(),
      onArchive: jest.fn(),
      onUnarchive: jest.fn(),
      onAssignToFolder: jest.fn(),
    },
    extraActions: {
      onMarkRead: jest.fn(),
      onMarkUnread: jest.fn(),
      onBranch: jest.fn(),
      onCopyLink: jest.fn(),
      onExportShare: jest.fn(),
    },
    ...overrides,
  }
  const utils = render(<MobileChannelRowActions {...props} />)
  return { ...utils, props }
}

beforeEach(() => {
  moveToWorkspace.mockReset()
  workspaceTargets = [
    { id: "w1", name: "Alpha" },
    { id: "w2", name: "Beta" },
  ]
})

/**
 * Clicks inside the sheet go through `fireEvent`: vaul reads the drawer's
 * computed transform on pointerup, which jsdom does not provide (the same
 * workaround `conversation-filter-controls.test.tsx` documents).
 */
describe("<MobileChannelRowActions />", () => {
  it("offers the desktop row menu's actions, titled by the conversation", async () => {
    renderActions()
    const sheet = await screen.findByTestId("mobile-channel-actions")
    expect(sheet).toHaveTextContent("Daily standup")
    // A sideways drag here must not close the navigation drawer beneath.
    expect(sheet).toHaveAttribute("data-edge-swipe-ignore")
    for (const action of [
      "rename",
      "pin",
      "mark-unread",
      "branch",
      "copy-link",
      "export",
      "archive",
      "handoff",
      "delete",
    ]) {
      expect(screen.getByTestId(item(action))).toBeEnabled()
    }
    // No desktop-only hand-offs, no multi-select, no key hints on a phone.
    expect(screen.queryByTestId(item("terminal"))).toBeNull()
    expect(screen.queryByTestId(item("select"))).toBeNull()
    expect(screen.queryByText("F2")).toBeNull()
    // No folders to file into.
    expect(screen.queryByTestId(item("move-folder"))).toBeNull()
  })

  it.each([
    ["rename", "onRename", [session]],
    ["handoff", "onContinueOnDevice", [session]],
    ["delete", "onDelete", [session]],
  ] as const)("closes the sheet, then runs %s", async (action, handler, args) => {
    const { props } = renderActions()
    fireEvent.click(await screen.findByTestId(item(action)))
    expect(props.onClose).toHaveBeenCalled()
    expect(props[handler]).toHaveBeenCalledWith(...args)
  })

  it("writes through the list's shared boundary by id", async () => {
    const { props } = renderActions({ session: { ...session, pinned: true } })
    fireEvent.click(await screen.findByTestId(item("pin")))
    expect(props.rowActions.onTogglePinned).toHaveBeenCalledWith("s1", false)
    fireEvent.click(screen.getByTestId(item("archive")))
    expect(props.rowActions.onArchive).toHaveBeenCalledWith("s1")
    for (const [action, handler] of [
      ["branch", "onBranch"],
      ["copy-link", "onCopyLink"],
      ["export", "onExportShare"],
      ["mark-unread", "onMarkUnread"],
    ] as const) {
      fireEvent.click(screen.getByTestId(item(action)))
      expect(props.extraActions[handler]).toHaveBeenCalledWith("s1")
    }
  })

  it("names each toggle for the row's current state", async () => {
    renderActions({ session: { ...session, pinned: true, archivedAt: 3 } })
    expect(await screen.findByTestId(item("pin"))).toHaveTextContent("unpin")
    expect(screen.getByTestId(item("unarchive"))).toHaveTextContent("unarchive")
  })

  it("offers Mark as read while something is unread, Mark as unread otherwise", async () => {
    const { props } = renderActions({ unread: 2 })
    expect(screen.queryByTestId(item("mark-unread"))).toBeNull()
    fireEvent.click(await screen.findByTestId(item("mark-read")))
    expect(props.extraActions.onMarkRead).toHaveBeenCalledWith("s1")
  })

  it("files into a folder of the conversation's own workspace from a second page", async () => {
    const { props } = renderActions({
      folders: [folder("mine", "w1"), folder("legacy"), folder("foreign", "w2")],
    })
    fireEvent.click(await screen.findByTestId(item("move-folder")))
    // The main page gives way to the folder page.
    expect(screen.queryByTestId(item("rename"))).toBeNull()
    expect(screen.getByTestId(item("folder-mine"))).toBeInTheDocument()
    expect(screen.getByTestId(item("folder-legacy"))).toBeInTheDocument()
    expect(screen.queryByTestId(item("folder-foreign"))).toBeNull()
    fireEvent.click(screen.getByTestId(item("folder-mine")))
    expect(props.onClose).toHaveBeenCalled()
    expect(props.rowActions.onAssignToFolder).toHaveBeenCalledWith("s1", "mine")
  })

  it("marks the current folder and does not re-file into it", async () => {
    const { props } = renderActions({
      session: { ...session, folderId: "mine" },
      folders: [folder("mine", "w1")],
    })
    fireEvent.click(await screen.findByTestId(item("move-folder")))
    expect(screen.getByTestId(item("folder-mine"))).toHaveAttribute("aria-current", "true")
    // Re-filing into the same folder is a no-op, not a write.
    fireEvent.click(screen.getByTestId(item("folder-mine")))
    expect(props.rowActions.onAssignToFolder).not.toHaveBeenCalled()
  })

  it("takes a conversation out of its folder", async () => {
    const { props } = renderActions({
      session: { ...session, folderId: "mine" },
      folders: [folder("mine", "w1")],
    })
    fireEvent.click(await screen.findByTestId(item("move-folder")))
    fireEvent.click(screen.getByTestId(item("folder-none")))
    expect(props.rowActions.onAssignToFolder).toHaveBeenCalledWith("s1", null)
  })

  it("returns from a second page", async () => {
    renderActions({ folders: [folder("mine", "w1")] })
    fireEvent.click(await screen.findByTestId(item("move-folder")))
    fireEvent.click(screen.getByTestId("session-row-sheet-back"))
    expect(screen.getByTestId(item("rename"))).toBeInTheDocument()
  })

  it("moves a conversation to another workspace from its own page", async () => {
    renderActions()
    fireEvent.click(await screen.findByTestId("session-row-move-workspace-s1"))
    expect(screen.getByTestId(item("workspace-w1"))).toHaveAttribute("aria-current", "true")
    expect(screen.getByTestId(item("workspace-w1"))).toBeDisabled()
    fireEvent.click(screen.getByTestId(item("workspace-w2")))
    expect(moveToWorkspace).toHaveBeenCalledWith("w2")
  })

  it("says a handed-off conversation is read-only and disables its writes", async () => {
    renderActions({
      unread: 1,
      session: {
        ...session,
        handoffLock: { ticketId: "t", state: "frozen" } as ChatSession["handoffLock"],
      },
    })
    expect(await screen.findByRole("note")).toHaveTextContent("lockedMenuNote")
    for (const action of ["rename", "pin", "archive", "branch", "delete"]) {
      expect(screen.getByTestId(item(action))).toBeDisabled()
    }
    // Reading is not a write to the conversation, and the handoff has a status.
    for (const action of ["mark-read", "copy-link", "export"]) {
      expect(screen.getByTestId(item(action))).toBeEnabled()
    }
    expect(screen.getByTestId(item("handoff"))).toHaveTextContent("handoffStatus")
  })

  it("is closed without a conversation", async () => {
    renderActions({ session: null })
    await waitFor(() => expect(screen.queryByTestId("mobile-channel-actions")).toBeNull())
  })

  it("keeps rows at the 44px touch floor", async () => {
    renderActions()
    expect(await screen.findByTestId(item("rename"))).toHaveClass("min-h-12")
  })
})
