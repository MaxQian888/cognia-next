/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { ChatSession, SessionFolder } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import {
  assignableFoldersFor,
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

function renderActions(overrides: Partial<MobileChannelRowActionsProps> = {}) {
  const props: MobileChannelRowActionsProps = {
    session,
    unread: 0,
    folders: [],
    onClose: jest.fn(),
    onRename: jest.fn(),
    onTogglePin: jest.fn(),
    onMarkRead: jest.fn(),
    onToggleArchive: jest.fn(),
    onMoveToFolder: jest.fn(),
    onContinueOnDevice: jest.fn(),
    onDelete: jest.fn(),
    ...overrides,
  }
  const utils = render(<MobileChannelRowActions {...props} />)
  return { ...utils, props }
}

/**
 * Clicks inside the sheet go through `fireEvent`: vaul reads the drawer's
 * computed transform on pointerup, which jsdom does not provide (the same
 * workaround `conversation-filter-controls.test.tsx` documents).
 */
describe("<MobileChannelRowActions />", () => {
  it("lists every row action for the conversation, titled by it", async () => {
    renderActions()
    const sheet = await screen.findByTestId("mobile-channel-actions")
    expect(sheet).toHaveTextContent("Daily standup")
    // A sideways drag here must not close the navigation drawer beneath.
    expect(sheet).toHaveAttribute("data-edge-swipe-ignore")
    for (const id of ["rename", "pin", "archive", "handoff", "delete"]) {
      expect(screen.getByTestId(`mobile-channel-action-${id}`)).toBeEnabled()
    }
    // Nothing unread, no folders to file into.
    expect(screen.queryByTestId("mobile-channel-action-mark-read")).toBeNull()
    expect(screen.queryByTestId("mobile-channel-action-move")).toBeNull()
  })

  it.each([
    ["rename", "onRename"],
    ["pin", "onTogglePin"],
    ["archive", "onToggleArchive"],
    ["handoff", "onContinueOnDevice"],
    ["delete", "onDelete"],
  ] as const)("closes the sheet, then runs %s", async (id, handler) => {
    const { props } = renderActions()
    fireEvent.click(await screen.findByTestId(`mobile-channel-action-${id}`))
    expect(props.onClose).toHaveBeenCalled()
    expect(props[handler]).toHaveBeenCalledWith(session)
  })

  it("names each toggle for the row's current state", async () => {
    renderActions({ session: { ...session, pinned: true, archivedAt: 3 } })
    expect(await screen.findByTestId("mobile-channel-action-pin")).toHaveTextContent("unpin")
    expect(screen.getByTestId("mobile-channel-action-archive")).toHaveTextContent("unarchive")
  })

  it("offers Mark as read only while something is unread", async () => {
    const { props } = renderActions({ unread: 2 })
    fireEvent.click(await screen.findByTestId("mobile-channel-action-mark-read"))
    expect(props.onMarkRead).toHaveBeenCalledWith(session)
  })

  it("files into a folder of the conversation's own workspace from a second page", async () => {
    const { props } = renderActions({
      folders: [folder("mine", "w1"), folder("legacy"), folder("foreign", "w2")],
    })
    fireEvent.click(await screen.findByTestId("mobile-channel-action-move"))
    expect(screen.getByTestId("mobile-channel-action-folder-mine")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-channel-action-folder-legacy")).toBeInTheDocument()
    expect(screen.queryByTestId("mobile-channel-action-folder-foreign")).toBeNull()
    fireEvent.click(screen.getByTestId("mobile-channel-action-folder-mine"))
    expect(props.onMoveToFolder).toHaveBeenCalledWith(session, "mine")
  })

  it("marks the current folder and does not re-file into it", async () => {
    const { props } = renderActions({
      session: { ...session, folderId: "mine" },
      folders: [folder("mine", "w1")],
    })
    fireEvent.click(await screen.findByTestId("mobile-channel-action-move"))
    expect(screen.getByTestId("mobile-channel-action-folder-mine")).toHaveAttribute(
      "aria-current",
      "true"
    )
    // Re-filing into the same folder is a no-op, not a write.
    fireEvent.click(screen.getByTestId("mobile-channel-action-folder-mine"))
    expect(props.onMoveToFolder).not.toHaveBeenCalled()
  })

  it("takes a conversation out of its folder", async () => {
    const { props } = renderActions({
      session: { ...session, folderId: "mine" },
      folders: [folder("mine", "w1")],
    })
    fireEvent.click(await screen.findByTestId("mobile-channel-action-move"))
    fireEvent.click(screen.getByTestId("mobile-channel-action-folder-remove"))
    expect(props.onMoveToFolder).toHaveBeenCalledWith({ ...session, folderId: "mine" }, null)
  })

  it("returns from the folder page", async () => {
    renderActions({ folders: [folder("mine", "w1")] })
    fireEvent.click(await screen.findByTestId("mobile-channel-action-move"))
    fireEvent.click(screen.getByTestId("mobile-channel-action-folders-back"))
    expect(screen.getByTestId("mobile-channel-action-rename")).toBeInTheDocument()
  })

  it("says a handed-off conversation is read-only and disables its writes", async () => {
    renderActions({
      unread: 1,
      session: {
        ...session,
        handoffLock: { ticketId: "t", state: "frozen" } as ChatSession["handoffLock"],
      },
    })
    expect(await screen.findByTestId("mobile-channel-actions-locked")).toHaveTextContent(
      "actionLocked"
    )
    for (const id of ["rename", "pin", "archive", "delete"]) {
      expect(screen.getByTestId(`mobile-channel-action-${id}`)).toBeDisabled()
    }
    // Reading is not a write to the conversation, and the handoff has a status.
    expect(screen.getByTestId("mobile-channel-action-mark-read")).toBeEnabled()
    expect(screen.getByTestId("mobile-channel-action-handoff")).toHaveTextContent("handoffStatus")
  })

  it("is closed without a conversation", async () => {
    renderActions({ session: null })
    await waitFor(() => expect(screen.queryByTestId("mobile-channel-actions")).toBeNull())
  })

  it("keeps rows at the 44px touch floor", async () => {
    renderActions()
    expect(await screen.findByTestId("mobile-channel-action-rename")).toHaveClass("min-h-12")
  })
})

describe("assignableFoldersFor", () => {
  it("keeps same-workspace and unscoped folders, drops foreign ones", () => {
    const folders = [folder("a", "w1"), folder("b"), folder("c", "w2")]
    expect(assignableFoldersFor({ projectId: "w1" }, folders).map((f) => f.id)).toEqual(["a", "b"])
    // A conversation from before workspace isolation can go anywhere.
    expect(assignableFoldersFor({}, folders).map((f) => f.id)).toEqual(["a", "b", "c"])
  })
})
