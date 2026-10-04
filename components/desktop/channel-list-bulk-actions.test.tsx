/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () =>
    function ShareDialog({
      sessions,
      open,
      onOpenChange,
    }: {
      sessions: ChatSession[]
      open: boolean
      onOpenChange: (open: boolean) => void
    }) {
      return open ? (
        <div role="dialog">
          <ul>
            {sessions.map((session) => (
              <li key={session.id}>{session.title}</li>
            ))}
          </ul>
          <button type="button" onClick={() => onOpenChange(false)}>
            close
          </button>
        </div>
      ) : null
    },
}))

jest.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
}))

jest.mock("@/lib/ui/motion", () => ({
  useReducedMotionVariants: (variants: unknown) => variants,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { ChannelListBulkActions } from "./channel-list-bulk-actions"

function session(id: string, title: string): ChatSession {
  return {
    id,
    title,
    kind: "direct",
    createdAt: 1,
    updatedAt: 1,
  } as ChatSession
}

it("opens selected conversations for sharing in visible order and clears on close", async () => {
  const user = userEvent.setup()
  const onClear = jest.fn()
  render(
    <ChannelListBulkActions
      visible
      selected={new Set(["second", "first"])}
      orderedIds={["first", "second"]}
      sessions={[session("second", "Second"), session("first", "First")]}
      archived={false}
      onClear={onClear}
    />
  )

  await user.click(screen.getByRole("button", { name: "share" }))

  const dialog = screen.getByRole("dialog")
  expect(
    within(dialog)
      .getAllByRole("listitem")
      .map((item) => item.textContent)
  ).toEqual(["First", "Second"])
  await user.click(within(dialog).getByRole("button", { name: "close" }))
  expect(onClear).toHaveBeenCalledTimes(1)
})

it("runs a bulk mutation with the selected ids and clears after it settles", async () => {
  const user = userEvent.setup()
  const onSetPinned = jest.fn(async () => {})
  const onClear = jest.fn()
  render(
    <ChannelListBulkActions
      visible
      selected={new Set(["second", "first"])}
      orderedIds={["first", "second"]}
      sessions={[]}
      archived={false}
      onSetPinned={onSetPinned}
      onClear={onClear}
    />
  )

  await user.click(screen.getByRole("button", { name: "pin" }))

  expect(onSetPinned).toHaveBeenCalledWith(["second", "first"], true)
  expect(onClear).toHaveBeenCalledTimes(1)
})

it("offers only the folders every selected conversation can go into", async () => {
  // A folder is workspace-scoped. With a cross-workspace selection, another
  // workspace's folder would take the move and then drop it on screen.
  const user = userEvent.setup()
  const onMoveToFolder = jest.fn(async () => {})
  const onClear = jest.fn()
  const inP1 = { ...session("a", "A"), projectId: "p1" } as ChatSession
  const inP2 = { ...session("b", "B"), projectId: "p2" } as ChatSession
  const folders = [
    { id: "f-p1", name: "P1 folder", projectId: "p1", order: 0 },
    { id: "f-any", name: "Legacy folder", order: 1 },
  ] as never
  render(
    <ChannelListBulkActions
      visible
      selected={new Set(["a", "b"])}
      orderedIds={["a", "b"]}
      sessions={[inP1, inP2]}
      archived={false}
      folders={folders}
      onMoveToFolder={onMoveToFolder}
      onClear={onClear}
    />
  )

  await user.click(screen.getByTestId("channel-list-bulk-move-to-folder"))
  expect(screen.getByTestId("channel-list-bulk-folder-f-p1")).toHaveAttribute("data-disabled")
  expect(screen.getByTestId("channel-list-bulk-folder-f-any")).not.toHaveAttribute("data-disabled")
  expect(screen.getByTestId("channel-list-bulk-folder-blocked-note")).toHaveTextContent(
    "folderOtherWorkspace"
  )
  await user.click(screen.getByTestId("channel-list-bulk-folder-f-any"))
  expect(onMoveToFolder).toHaveBeenCalledWith(["a", "b"], "f-any")
  expect(onClear).toHaveBeenCalledTimes(1)
})

it("leaves every folder open when the selection shares its workspace", async () => {
  const user = userEvent.setup()
  const inP1 = { ...session("a", "A"), projectId: "p1" } as ChatSession
  render(
    <ChannelListBulkActions
      visible
      selected={new Set(["a"])}
      orderedIds={["a"]}
      sessions={[inP1, { ...session("z", "Z"), projectId: "p2" } as ChatSession]}
      archived={false}
      folders={[{ id: "f-p1", name: "P1 folder", projectId: "p1", order: 0 }] as never}
      onMoveToFolder={jest.fn()}
      onClear={jest.fn()}
    />
  )
  await user.click(screen.getByTestId("channel-list-bulk-move-to-folder"))
  // An unselected row in another workspace does not narrow anything.
  expect(screen.getByTestId("channel-list-bulk-folder-f-p1")).not.toHaveAttribute("data-disabled")
  expect(screen.queryByTestId("channel-list-bulk-folder-blocked-note")).toBeNull()
})

it("keeps the selection when the list refuses or fails the write", async () => {
  const user = userEvent.setup()
  // The action boundary resolves `false` after it has told the user why.
  const onArchive = jest.fn(async () => false)
  const onClear = jest.fn()
  render(
    <ChannelListBulkActions
      visible
      selected={new Set(["a", "b"])}
      orderedIds={["a", "b"]}
      sessions={[]}
      archived={false}
      onArchive={onArchive}
      onClear={onClear}
    />
  )
  await user.click(screen.getByRole("button", { name: "archive" }))
  expect(onArchive).toHaveBeenCalledWith(["a", "b"])
  expect(onClear).not.toHaveBeenCalled()
})

it("marks the selection read and lets it go", async () => {
  const user = userEvent.setup()
  const onMarkRead = jest.fn(async () => true)
  const onClear = jest.fn()
  render(
    <ChannelListBulkActions
      visible
      selected={new Set(["a"])}
      orderedIds={["a"]}
      sessions={[]}
      archived={false}
      onMarkRead={onMarkRead}
      onClear={onClear}
    />
  )
  await user.click(screen.getByRole("button", { name: "markRead" }))
  expect(onMarkRead).toHaveBeenCalledWith(["a"])
  expect(onClear).toHaveBeenCalledTimes(1)
})

it("offers no action whose writer is missing", () => {
  render(
    <ChannelListBulkActions
      visible
      selected={new Set(["a"])}
      orderedIds={["a"]}
      sessions={[]}
      archived={false}
      onClear={jest.fn()}
    />
  )
  for (const name of ["pin", "unpin", "archive", "delete", "markRead"]) {
    expect(screen.queryByRole("button", { name })).toBeNull()
  }
})

describe("reading the selection's state", () => {
  const pinnedA = { ...session("a", "A"), pinned: true } as ChatSession
  const pinnedB = { ...session("b", "B"), pinned: true } as ChatSession
  const loose = session("c", "C")

  function renderWith(props: Partial<Parameters<typeof ChannelListBulkActions>[0]>) {
    return render(
      <ChannelListBulkActions
        visible
        selected={new Set(["a", "b"])}
        orderedIds={["a", "b", "c"]}
        sessions={[pinnedA, pinnedB, loose]}
        archived={false}
        onSetPinned={jest.fn(async () => true)}
        onClear={jest.fn()}
        {...props}
      />
    )
  }

  it("offers Unpin to an all-pinned selection and Pin to a mixed one", async () => {
    const user = userEvent.setup()
    const onSetPinned = jest.fn(async () => true)
    const { unmount } = renderWith({ onSetPinned })
    await user.click(screen.getByRole("button", { name: "unpin" }))
    expect(onSetPinned).toHaveBeenLastCalledWith(["a", "b"], false)
    unmount()
    renderWith({ onSetPinned, selected: new Set(["a", "c"]) })
    expect(screen.queryByRole("button", { name: "unpin" })).toBeNull()
    await user.click(screen.getByRole("button", { name: "pin" }))
    expect(onSetPinned).toHaveBeenLastCalledWith(["a", "c"], true)
  })

  it("flips the read switch to unread once nothing selected is unread", async () => {
    const user = userEvent.setup()
    const onMarkRead = jest.fn(async () => true)
    const onMarkUnread = jest.fn(async () => true)
    const { unmount } = renderWith({ onMarkRead, onMarkUnread, unreadIds: new Set(["b"]) })
    expect(screen.getByRole("button", { name: "markRead" })).toBeInTheDocument()
    unmount()
    renderWith({ onMarkRead, onMarkUnread, unreadIds: new Set(["c"]) })
    await user.click(screen.getByRole("button", { name: "markUnread" }))
    expect(onMarkUnread).toHaveBeenCalledWith(["a", "b"])
    expect(onMarkRead).not.toHaveBeenCalled()
  })

  it("offers Remove from folder only when a selected row is filed", async () => {
    const user = userEvent.setup()
    const folders = [{ id: "f1", name: "F1", order: 0 }] as never
    const { unmount } = renderWith({ folders, onMoveToFolder: jest.fn() })
    await user.click(screen.getByTestId("channel-list-bulk-move-to-folder"))
    expect(screen.queryByTestId("channel-list-bulk-folder-none")).toBeNull()
    unmount()
    renderWith({
      folders,
      onMoveToFolder: jest.fn(),
      sessions: [{ ...pinnedA, folderId: "f1" } as ChatSession, pinnedB, loose],
    })
    await user.click(screen.getByTestId("channel-list-bulk-move-to-folder"))
    expect(screen.getByTestId("channel-list-bulk-folder-none")).toBeInTheDocument()
  })

  it("makes a folder for the selection when the new folder can hold all of it", async () => {
    const user = userEvent.setup()
    const onNewFolder = jest.fn(async () => true)
    const onClear = jest.fn()
    renderWith({
      sessions: [
        { ...pinnedA, projectId: "p1" } as ChatSession,
        { ...pinnedB, projectId: "p1" } as ChatSession,
      ],
      folders: [],
      onMoveToFolder: jest.fn(),
      onNewFolder,
      newFolderProjectId: "p1",
      onClear,
    })
    await user.click(screen.getByTestId("channel-list-bulk-move-to-folder"))
    await user.click(screen.getByTestId("channel-list-bulk-folder-new"))
    expect(onNewFolder).toHaveBeenCalledWith(["a", "b"])
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it("does not offer a new folder that could not hold a row from another workspace", () => {
    renderWith({
      sessions: [
        { ...pinnedA, projectId: "p1" } as ChatSession,
        { ...pinnedB, projectId: "p2" } as ChatSession,
      ],
      folders: [],
      onMoveToFolder: jest.fn(),
      onNewFolder: jest.fn(async () => true),
      newFolderProjectId: "p1",
    })
    // Nothing else to offer either, so the control itself steps aside.
    expect(screen.queryByTestId("channel-list-bulk-move-to-folder")).toBeNull()
  })

  it("keeps the selection when making the folder failed", async () => {
    const user = userEvent.setup()
    const onClear = jest.fn()
    renderWith({
      folders: [],
      onMoveToFolder: jest.fn(),
      onNewFolder: jest.fn(async () => false),
      onClear,
    })
    await user.click(screen.getByTestId("channel-list-bulk-move-to-folder"))
    await user.click(screen.getByTestId("channel-list-bulk-folder-new"))
    expect(onClear).not.toHaveBeenCalled()
  })

  it("passes select all / deselect all through against the rows on screen", async () => {
    const user = userEvent.setup()
    const onSelectAll = jest.fn()
    renderWith({ onSelectAll, onDeselectAll: jest.fn() })
    // Two of three on screen are selected.
    await user.click(screen.getByRole("button", { name: "selectAll" }))
    expect(onSelectAll).toHaveBeenCalledTimes(1)
  })
})

it("hands the delete confirm the selection's titles in list order, placeholders translated", async () => {
  const user = userEvent.setup()
  render(
    <ChannelListBulkActions
      visible
      selected={new Set(["b", "a"])}
      orderedIds={["a", "b"]}
      sessions={[session("b", ""), session("a", "Alpha")]}
      archived={false}
      onDelete={jest.fn()}
      onClear={jest.fn()}
    />
  )
  await user.click(screen.getByRole("button", { name: "delete" }))
  const list = await screen.findByTestId("channel-list-bulk-delete-titles")
  expect(Array.from(list.querySelectorAll("li")).map((item) => item.textContent)).toEqual([
    "Alpha",
    "untitled",
  ])
})

it("routes each verb to the rows it applies to in a mixed selection", async () => {
  const user = userEvent.setup()
  const onArchive = jest.fn(async () => true)
  const onUnarchive = jest.fn(async () => true)
  const onMarkRead = jest.fn(async () => true)
  const rows = [
    session("active", "Active"),
    { ...session("archived", "Archived"), archivedAt: 5 } as ChatSession,
  ]
  const { rerender } = render(
    <ChannelListBulkActions
      visible
      selected={new Set(["active", "archived"])}
      orderedIds={["active", "archived"]}
      sessions={rows}
      archived={false}
      onArchive={onArchive}
      onUnarchive={onUnarchive}
      onMarkRead={onMarkRead}
      onClear={jest.fn()}
    />
  )
  await user.click(screen.getByRole("button", { name: "archive" }))
  expect(onArchive).toHaveBeenCalledWith(["active"])
  await user.click(screen.getByRole("button", { name: "unarchive" }))
  expect(onUnarchive).toHaveBeenCalledWith(["archived"])
  await user.click(screen.getByRole("button", { name: "markRead" }))
  expect(onMarkRead).toHaveBeenCalledWith(["active"])
  rerender(
    <ChannelListBulkActions
      visible
      selected={new Set(["active", "archived"])}
      orderedIds={["active", "archived"]}
      sessions={rows}
      archived={false}
      layout="bar"
      onClear={jest.fn()}
    />
  )
  expect(screen.getByTestId("channel-list-bulk-toolbar")).toHaveAttribute("data-layout", "bar")
})
