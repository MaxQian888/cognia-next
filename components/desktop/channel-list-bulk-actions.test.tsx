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
