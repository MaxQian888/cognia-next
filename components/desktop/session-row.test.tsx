/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChatSession } from "@cognia/agent-config-types"

const logInfo = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  // The row formats its own activity timestamp (see `showTimestamp`). A fixed
  // formatter keeps the assertions locale- and clock-independent.
  useFormatter: () => ({
    dateTime: (value: Date, options: Record<string, unknown>) =>
      `dt(${value.getTime()}|${Object.keys(options).sort().join(",")})`,
  }),
  // Literal, not a hoisted const: jest.mock factories run before module-scope
  // bindings are initialized (TDZ).
  useNow: () => new Date(1_750_000_000_000),
}))

jest.mock("@cognia/logging", () => ({
  loggers: {
    ui: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: jest.fn(),
      error: jest.fn(),
    },
  },
}))

// The branch count behind the delete confirm is a Dexie live query. Stubbed so
// the count is a test input rather than a seeded database.
let branchCount = 0
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => branchCount,
}))

import { SessionRow } from "./session-row"

const baseSession: ChatSession = {
  id: "s-1",
  title: "Hello",
  kind: "direct",
  createdAt: 0,
  updatedAt: 0,
}

beforeEach(() => {
  logInfo.mockReset()
})

function setup(overrides: Partial<Parameters<typeof SessionRow>[0]> = {}) {
  const onSelect = jest.fn()
  const onDelete = jest.fn()
  const onRename = jest.fn()
  const utils = render(
    <ul>
      <SessionRow
        session={baseSession}
        active={false}
        onSelect={onSelect}
        onDelete={onDelete}
        onRename={onRename}
        {...overrides}
      />
    </ul>
  )
  return { ...utils, onSelect, onDelete, onRename }
}

test("renders title and clicking the row selects the session", async () => {
  const user = userEvent.setup()
  const { onSelect } = setup()
  await user.click(screen.getByRole("button", { name: /Hello/ }))
  expect(onSelect).toHaveBeenCalledWith("s-1", expect.any(Object))
  const event = onSelect.mock.calls[0][1] as { ctrlKey: boolean; shiftKey: boolean }
  expect(event.ctrlKey).toBe(false)
  expect(event.shiftKey).toBe(false)
  expect(logInfo).toHaveBeenCalledWith(
    "session select",
    expect.objectContaining({ sessionId: "s-1", ctrl: false, shift: false })
  )
})

test("renders a custom avatar subject in place of the generic session icon", () => {
  setup({
    iconSubject: {
      name: "Octopus",
      avatarEmoji: "🐙",
      avatarColor: "#123456",
    },
  })

  const avatar = screen.getByText("🐙").closest("span")
  expect(avatar).toHaveStyle({ backgroundColor: "#123456" })
})

test("scrolls a truncated conversation title without opening a native hover bubble", () => {
  const title = "A conversation title that is much wider than the sidebar"
  setup({ session: { ...baseSession, title } })

  const text = screen.getByText(title)
  const viewport = text.closest('[data-slot="hover-scroll-text"]')
  expect(viewport).not.toBeNull()
  Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 })
  Object.defineProperty(text, "scrollWidth", { configurable: true, value: 244 })

  fireEvent.mouseEnter(viewport!)

  expect(text).toHaveAttribute("data-scrolling", "true")
  expect(screen.getByRole("button", { name: title })).not.toHaveAttribute("title")
})

test("focused rows carry data-focused for the keyboard-nav ring", () => {
  const { container } = setup({ focused: true })
  expect(container.querySelector("li[data-focused]")).toBeInTheDocument()
})

test("compact density tightens the row padding", () => {
  const { container } = setup({ density: "compact" })
  expect(container.querySelector("li")).toHaveAttribute("data-density", "compact")
  // The padding lives on the select button so it stays part of the hit target.
  expect(screen.getByRole("button", { name: /Hello/ }).className).toContain("py-1")
  expect(container.querySelector("li")?.className).not.toMatch(/\bpy-/)
})

test("comfortable density keeps the taller row padding on the select button", () => {
  const { container } = setup({ density: "comfortable" })
  expect(container.querySelector("li")).toHaveAttribute("data-density", "comfortable")
  expect(screen.getByRole("button", { name: /Hello/ }).className).toContain("py-2")
})

test("shows the message preview line only when showPreview is on", () => {
  const withPreview = {
    ...baseSession,
    lastMessagePreview: "last thing said",
  } as ChatSession
  const { rerender } = setup({ session: withPreview, showPreview: true })
  expect(screen.getByText("last thing said")).toBeInTheDocument()
  rerender(
    <ul>
      <SessionRow
        session={withPreview}
        active={false}
        showPreview={false}
        onSelect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    </ul>
  )
  expect(screen.queryByText("last thing said")).toBeNull()
})

test("renders the configured conversation details in their supplied order", () => {
  setup({
    metadata: [
      { kind: "agent", value: "Alice" },
      { kind: "model", value: "Claude Sonnet 4.6" },
      { kind: "provider", value: "Anthropic" },
    ],
  })

  const details = screen.getByTestId("session-row-metadata")
  expect(details).toHaveTextContent("Alice")
  expect(details).toHaveTextContent("Claude Sonnet 4.6")
  expect(details).toHaveTextContent("Anthropic")
  expect(
    Array.from(details.querySelectorAll("[data-metadata-kind]")).map((node) => node.textContent)
  ).toEqual(["Alice", "Claude Sonnet 4.6", "Anthropic"])
})

test("can keep long titles static when title motion is disabled", () => {
  setup({ titleMotion: "off" })
  const title = screen.getByText("Hello")
  expect(title.closest('[data-slot="hover-scroll-text"]')).toHaveAttribute("data-motion", "off")
})

test("renders a drag grip handle when drag wiring is supplied", () => {
  setup({ dragListeners: {}, dragAttributes: {} })
  const grip = screen.getByLabelText("dragHandle")
  expect(grip).toBeInTheDocument()
  // Overlaid in the row gutter — not in flow — so titles keep the same x
  // whether or not the list is reorderable, and the hidden grip never eats a
  // click meant for the row.
  expect(grip.className).toContain("absolute")
})

test("the row's trailing actions sit outside the select button so the whole row surface selects", async () => {
  const user = userEvent.setup()
  const { onSelect } = setup()
  const select = screen.getByRole("button", { name: /Hello/ })
  const actions = screen.getByRole("button", { name: "actionsMenu" })
  expect(select.contains(actions)).toBe(false)
  expect(select.className).toContain("flex-1")
  await user.click(select)
  expect(onSelect).toHaveBeenCalledTimes(1)
})

test("binds the sortable activator ref to the drag grip handle", () => {
  const dragActivatorRef = jest.fn()
  setup({ dragListeners: {}, dragAttributes: {}, dragActivatorRef })

  expect(dragActivatorRef).toHaveBeenCalledWith(screen.getByLabelText("dragHandle"))
})

test("Ctrl-click forwards the modifier flag through onSelect", async () => {
  const user = userEvent.setup()
  const { onSelect } = setup()
  await user.keyboard("{Control>}")
  await user.click(screen.getByRole("button", { name: /Hello/ }))
  await user.keyboard("{/Control}")
  const event = onSelect.mock.calls[0][1] as { ctrlKey: boolean; shiftKey: boolean }
  expect(event.ctrlKey).toBe(true)
  expect(logInfo).toHaveBeenCalledWith("session select", expect.objectContaining({ ctrl: true }))
})

test("Shift-click forwards the modifier flag through onSelect", async () => {
  const user = userEvent.setup()
  const { onSelect } = setup()
  await user.keyboard("{Shift>}")
  await user.click(screen.getByRole("button", { name: /Hello/ }))
  await user.keyboard("{/Shift}")
  const event = onSelect.mock.calls[0][1] as { ctrlKey: boolean; shiftKey: boolean }
  expect(event.shiftKey).toBe(true)
})

test("applies the multi-select visual when `selected` is true", () => {
  const { container } = setup({ selected: true })
  const li = container.querySelector("li")
  expect(li?.getAttribute("data-selected")).toBe("true")
  expect(li?.className).toMatch(/ring-/)
})

test("renders an insertion cue at the pending drop edge", () => {
  const { container, rerender } = setup({ dropPosition: "before" })
  expect(container.querySelector("li")).toHaveAttribute("data-drop-position", "before")

  rerender(
    <ul>
      <SessionRow
        session={baseSession}
        active={false}
        dropPosition="after"
        onSelect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    </ul>
  )
  expect(container.querySelector("li")).toHaveAttribute("data-drop-position", "after")
})

test("action menu toggles this row in the shared multi-selection", async () => {
  const user = userEvent.setup()
  const onToggleSelection = jest.fn()
  const { rerender } = setup({ onToggleSelection })

  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.click(await screen.findByText("select"))
  expect(onToggleSelection).toHaveBeenCalledWith("s-1")

  rerender(
    <ul>
      <SessionRow
        session={baseSession}
        active={false}
        selected
        onSelect={jest.fn()}
        onToggleSelection={onToggleSelection}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    </ul>
  )
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  expect(await screen.findByText("deselect")).toBeInTheDocument()
})

test("pinned sessions render a pin glyph next to the title", () => {
  setup({ session: { ...baseSession, pinned: true } })
  expect(screen.getByLabelText("pinned")).toBeInTheDocument()
})

test("renders the untitled fallback when title is blank", () => {
  setup({ session: { ...baseSession, title: "" } })
  expect(screen.getByText("untitled")).toBeInTheDocument()
})

test("shows unread badge with cap at 99+", () => {
  const { rerender } = setup({ unread: 5 })
  expect(screen.getByText("5")).toBeInTheDocument()
  rerender(
    <ul>
      <SessionRow
        session={baseSession}
        active={false}
        unread={250}
        onSelect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
      />
    </ul>
  )
  expect(screen.getByText("99+")).toBeInTheDocument()
})

test("double click enters rename mode and Enter commits a non-empty change", async () => {
  const user = userEvent.setup()
  const { onRename } = setup()
  const button = screen.getByRole("button", { name: /Hello/ })
  await user.dblClick(button)
  const input = screen.getByDisplayValue("Hello") as HTMLInputElement
  await user.clear(input)
  await user.type(input, "World{Enter}")
  expect(onRename).toHaveBeenCalledWith("s-1", "World")
  expect(logInfo).toHaveBeenCalledWith(
    "session rename commit",
    expect.objectContaining({ sessionId: "s-1", length: 5 })
  )
})

test("Escape cancels rename without calling onRename", async () => {
  const user = userEvent.setup()
  const { onRename } = setup()
  await user.dblClick(screen.getByRole("button", { name: /Hello/ }))
  const input = screen.getByDisplayValue("Hello") as HTMLInputElement
  await user.clear(input)
  await user.type(input, "Other{Escape}")
  expect(onRename).not.toHaveBeenCalled()
  expect(logInfo).toHaveBeenCalledWith(
    "session rename cancel",
    expect.objectContaining({ sessionId: "s-1" })
  )
})

test("commits no rename when title unchanged", async () => {
  const user = userEvent.setup()
  const { onRename } = setup()
  await user.dblClick(screen.getByRole("button", { name: /Hello/ }))
  const input = screen.getByDisplayValue("Hello") as HTMLInputElement
  await user.type(input, "{Enter}")
  expect(onRename).not.toHaveBeenCalled()
})

test("renders an accent dot when accentColor is provided", () => {
  setup({ accentColor: "#ff0000" })
  // Both the icon-less accent dot and the action menu show the title button.
  expect(screen.getByRole("button", { name: /Hello/ })).toBeInTheDocument()
})

test("renders different icons by session kind", () => {
  setup({ session: { ...baseSession, kind: "team", teamId: "t-1" } })
  expect(screen.getByRole("button", { name: /Hello/ })).toBeInTheDocument()
})

test("dropdown Pin menu item invokes onTogglePinned with the inverted value", async () => {
  const user = userEvent.setup()
  const onTogglePinned = jest.fn()
  setup({ onTogglePinned })
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.click(await screen.findByText("pin"))
  expect(onTogglePinned).toHaveBeenCalledWith("s-1", true)
  expect(logInfo).toHaveBeenCalledWith(
    "session toggle-pinned",
    expect.objectContaining({ sessionId: "s-1", pinned: true })
  )
})

test("dropdown shows Unpin for an already-pinned session and toggles off", async () => {
  const user = userEvent.setup()
  const onTogglePinned = jest.fn()
  setup({ session: { ...baseSession, pinned: true }, onTogglePinned })
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.click(await screen.findByText("unpin"))
  expect(onTogglePinned).toHaveBeenCalledWith("s-1", false)
})

test("Pin menu item is hidden when no onTogglePinned callback is provided", async () => {
  const user = userEvent.setup()
  setup()
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  expect(screen.queryByText("pin")).toBeNull()
  expect(screen.queryByText("unpin")).toBeNull()
})

test("Archive menu item fires onArchive for an active session", async () => {
  const user = userEvent.setup()
  const onArchive = jest.fn()
  setup({ onArchive })
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.click(await screen.findByText("archive"))
  expect(onArchive).toHaveBeenCalledWith("s-1")
  // An active session offers Archive, not Unarchive.
  expect(screen.queryByText("unarchive")).toBeNull()
})

test("Unarchive menu item fires onUnarchive for an archived session", async () => {
  const user = userEvent.setup()
  const onUnarchive = jest.fn()
  setup({ session: { ...baseSession, archivedAt: 123 }, onArchive: jest.fn(), onUnarchive })
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.click(await screen.findByText("unarchive"))
  expect(onUnarchive).toHaveBeenCalledWith("s-1")
  expect(screen.queryByText("archive")).toBeNull()
})

test("Archive menu item is hidden when no onArchive callback is provided", async () => {
  const user = userEvent.setup()
  setup()
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  expect(screen.queryByText("archive")).toBeNull()
})

test("Delete requires confirmation before removing the session", async () => {
  const user = userEvent.setup()
  const { onDelete } = setup()

  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.click(await screen.findByText("delete"))

  expect(onDelete).not.toHaveBeenCalled()
  const dialog = await screen.findByRole("alertdialog")
  expect(dialog).toHaveTextContent('deleteConfirmTitle:{"title":"Hello"}')
  await user.click(screen.getByRole("button", { name: "deleteConfirmAction" }))
  expect(onDelete).toHaveBeenCalledWith("s-1")
})

test("delete confirm says branches survive, but only when there are any", async () => {
  // `direct` branching copies the messages outright, so a branch is a standalone
  // conversation and deleting the parent leaves it alone. Without this sentence
  // the sidebar count not dropping reads as a bug.
  const user = userEvent.setup()
  branchCount = 2
  try {
    setup()
    await user.click(screen.getByRole("button", { name: "actionsMenu" }))
    await user.click(await screen.findByText("delete"))
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      'deleteConfirmBranches:{"count":2}'
    )
  } finally {
    branchCount = 0
  }
})

test("delete confirm omits the branch note for a session with no branches", async () => {
  const user = userEvent.setup()
  setup()
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.click(await screen.findByText("delete"))
  expect(await screen.findByRole("alertdialog")).not.toHaveTextContent("deleteConfirmBranches")
})

test("cancelling delete closes the confirmation without removing the session", async () => {
  const user = userEvent.setup()
  const { onDelete } = setup()

  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.click(await screen.findByText("delete"))
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "cancel" }))
  expect(screen.queryByRole("alertdialog")).toBeNull()
  expect(onDelete).not.toHaveBeenCalled()
})

// The Move-to-folder submenu is a Radix sub-menu whose items don't reliably
// fire `onSelect` through the nested portal under jsdom (a documented gotcha);
// the assignment itself is covered in the useSessions + db layers. Here we
// verify the submenu and its items RENDER for each branch.
test("Move to folder submenu lists the workspace folders", async () => {
  const user = userEvent.setup()
  const folders = [
    { id: "f1", name: "Work", projectId: "p", order: 0, createdAt: 0, updatedAt: 0 },
  ] as never
  setup({ folders, onAssignToFolder: jest.fn() })
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.hover(await screen.findByText("moveToFolder"))
  expect(await screen.findByText("Work")).toBeInTheDocument()
  // A loose session has no "remove" affordance.
  expect(screen.queryByText("removeFromFolder")).toBeNull()
})

test("Move to folder offers Remove from folder when the session is foldered", async () => {
  const user = userEvent.setup()
  const folders = [
    { id: "f1", name: "Work", projectId: "p", order: 0, createdAt: 0, updatedAt: 0 },
  ] as never
  setup({ session: { ...baseSession, folderId: "f1" }, folders, onAssignToFolder: jest.fn() })
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.hover(await screen.findByText("moveToFolder"))
  expect(await screen.findByText("removeFromFolder")).toBeInTheDocument()
})

test("Move to folder omits folders that belong to another workspace", async () => {
  // Under `groupBy: "workspace"` the list spans every workspace while the
  // folders it carries belong to the active one. Filing this row into "Work"
  // would point it at a folder that is not loaded where it lives, so the
  // membership would show here and be gone after the next workspace switch.
  const user = userEvent.setup()
  const folders = [
    { id: "f1", name: "Work", projectId: "p", order: 0, createdAt: 0, updatedAt: 0 },
    { id: "f2", name: "Legacy", order: 1, createdAt: 0, updatedAt: 0 },
  ] as never
  setup({
    session: { ...baseSession, projectId: "other" },
    folders,
    onAssignToFolder: jest.fn(),
  })
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.hover(await screen.findByText("moveToFolder"))
  // The un-scoped folder predates workspace isolation and is still offered.
  expect(await screen.findByText("Legacy")).toBeInTheDocument()
  expect(screen.queryByText("Work")).toBeNull()
})

test("Move to folder submenu is hidden when every folder is another workspace's", async () => {
  const user = userEvent.setup()
  const folders = [
    { id: "f1", name: "Work", projectId: "p", order: 0, createdAt: 0, updatedAt: 0 },
  ] as never
  setup({
    session: { ...baseSession, projectId: "other" },
    folders,
    onAssignToFolder: jest.fn(),
  })
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  expect(screen.queryByText("moveToFolder")).toBeNull()
})

test("Move to folder submenu is hidden without folders or a current folder", async () => {
  const user = userEvent.setup()
  setup({ folders: [], onAssignToFolder: jest.fn() })
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  expect(screen.queryByText("moveToFolder")).toBeNull()
})

test("branched session shows a lineage chip that jumps to the parent", async () => {
  const user = userEvent.setup()
  const onJumpToParent = jest.fn()
  setup({
    session: { ...baseSession, parentSessionId: "parent-1" },
    onJumpToParent,
  })
  const chip = screen.getByRole("button", { name: "branchedFrom" })
  await user.click(chip)
  expect(onJumpToParent).toHaveBeenCalledWith("parent-1")
})

test("no lineage chip without a parentSessionId", () => {
  setup({ onJumpToParent: jest.fn() })
  expect(screen.queryByRole("button", { name: "branchedFrom" })).toBeNull()
})

test("no lineage chip when onJumpToParent is not provided", () => {
  setup({ session: { ...baseSession, parentSessionId: "parent-1" } })
  expect(screen.queryByRole("button", { name: "branchedFrom" })).toBeNull()
})

describe("row chrome", () => {
  it("marks the open conversation with an accent bar, not just a hover-coloured background", () => {
    // Hover and active were both `bg-accent`, which made every hovered row look
    // like the open one. The bar is the unambiguous signal.
    const { container } = setup({ active: true })
    expect(screen.getByTestId("session-row-active-bar")).toBeInTheDocument()
    expect(container.querySelector("li")?.className).toContain("bg-accent")
  })

  it("renders no accent bar on an inactive row", () => {
    setup({ active: false })
    expect(screen.queryByTestId("session-row-active-bar")).toBeNull()
  })

  it("omits the timestamp column unless asked", () => {
    setup()
    expect(screen.queryByTestId("session-row-timestamp")).toBeNull()
  })

  it("renders the last-activity timestamp when enabled", () => {
    setup({
      showTimestamp: true,
      session: { ...baseSession, lastMessageAt: 1_749_990_000_000 } as ChatSession,
    })
    const stamp = screen.getByTestId("session-row-timestamp")
    // Same day as the mocked `now` → the compact clock-time shape.
    expect(stamp).toHaveTextContent("dt(1749990000000|hour,minute)")
    // The full value stays reachable as a tooltip.
    expect(stamp).toHaveAttribute("title", expect.stringContaining("dateStyle"))
  })

  it("falls back to updatedAt when the session was never message-stamped", () => {
    setup({ showTimestamp: true, session: { ...baseSession, updatedAt: 1_749_000_000_000 } })
    expect(screen.getByTestId("session-row-timestamp")).toHaveTextContent("1749000000000")
  })

  it("drops the timestamp entirely when there is nothing to stamp", () => {
    setup({
      showTimestamp: true,
      session: { ...baseSession, updatedAt: undefined } as unknown as ChatSession,
    })
    expect(screen.queryByTestId("session-row-timestamp")).toBeNull()
  })

  it("emphasizes the matched run in the title while searching", () => {
    const { container } = setup({
      session: { ...baseSession, title: "Quarterly planning" },
      searchQuery: "plan",
    })
    const mark = container.querySelector("mark")
    expect(mark?.textContent).toBe("plan")
  })

  it("leaves the title untouched without a query", () => {
    const { container } = setup({ session: { ...baseSession, title: "Quarterly planning" } })
    expect(container.querySelector("mark")).toBeNull()
  })

  it("explains a hit that only matched message content", () => {
    // Otherwise a result whose title has nothing to do with the query reads as
    // a broken search rather than a deeper one.
    setup({ contentMatch: true })
    expect(screen.getByTestId("session-row-content-match")).toHaveTextContent("contentMatch")
  })

  it("adds no explanation for a plain title hit", () => {
    setup({ contentMatch: false })
    expect(screen.queryByTestId("session-row-content-match")).toBeNull()
  })
})

test("choosing a folder from the submenu assigns the session to it", async () => {
  // The sibling tests above only assert the submenu RENDERS. Radix fires
  // `onSelect` off the item's own click event, which `fireEvent` can deliver
  // through the nested portal even where `userEvent`'s pointer sequence can't.
  const onAssignToFolder = jest.fn()
  const user = userEvent.setup()
  const folders = [
    { id: "f1", name: "Work", projectId: "p", order: 0, createdAt: 0, updatedAt: 0 },
  ] as never
  setup({ folders, onAssignToFolder })
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.hover(await screen.findByText("moveToFolder"))
  fireEvent.click(await screen.findByText("Work"))
  expect(onAssignToFolder).toHaveBeenCalledWith("s-1", "f1")
})

test("Remove from folder detaches the session", async () => {
  const onAssignToFolder = jest.fn()
  const user = userEvent.setup()
  const folders = [
    { id: "f1", name: "Work", projectId: "p", order: 0, createdAt: 0, updatedAt: 0 },
  ] as never
  setup({ session: { ...baseSession, folderId: "f1" }, folders, onAssignToFolder })
  await user.click(screen.getByRole("button", { name: "actionsMenu" }))
  await user.hover(await screen.findByText("moveToFolder"))
  fireEvent.click(await screen.findByText("removeFromFolder"))
  expect(onAssignToFolder).toHaveBeenCalledWith("s-1", null)
})
