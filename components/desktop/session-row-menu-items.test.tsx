/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  CONTEXT_MENU_KIT,
  DROPDOWN_MENU_KIT,
  SessionRowMenuItems,
  type SessionRowMenuItemsProps,
} from "./session-row-menu-items"

const session: ChatSession = {
  id: "s-1",
  title: "Hello",
  kind: "direct",
  createdAt: 0,
  updatedAt: 0,
}

const LOCK = { ticketId: "tk", lockedAt: 1 } as unknown as ChatSession["handoffLock"]

function baseProps(
  overrides: Partial<SessionRowMenuItemsProps> = {}
): Omit<SessionRowMenuItemsProps, "kit" | "surface"> {
  return {
    session,
    selected: false,
    unread: false,
    onRename: jest.fn(),
    assignableFolders: [],
    workspaceTargets: [],
    canMoveWorkspace: false,
    movingWorkspace: false,
    onMoveWorkspace: jest.fn(),
    onHandoff: jest.fn(),
    onDelete: jest.fn(),
    ...overrides,
  }
}

function renderDropdown(overrides: Partial<SessionRowMenuItemsProps> = {}) {
  const props = baseProps(overrides)
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <SessionRowMenuItems kit={DROPDOWN_MENU_KIT} surface="dropdown" {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
  return props
}

test("offers the core items and names each by surface and row", () => {
  const props = renderDropdown()
  fireEvent.click(screen.getByTestId("session-row-dropdown-rename-s-1"))
  expect(props.onRename).toHaveBeenCalled()
  fireEvent.click(screen.getByTestId("session-row-dropdown-delete-s-1"))
  expect(props.onDelete).toHaveBeenCalled()
  // Optional actions are absent without a handler.
  expect(screen.queryByTestId("session-row-dropdown-pin-s-1")).toBeNull()
  expect(screen.queryByTestId("session-row-dropdown-branch-s-1")).toBeNull()
  expect(screen.queryByTestId("session-row-dropdown-copy-link-s-1")).toBeNull()
  // The CLI / Codex hand-offs only render when the desktop block is supplied.
  expect(screen.queryByTestId("session-row-dropdown-terminal-s-1")).toBeNull()
})

test("flips the read-state item with the row's unread state", () => {
  const onMarkRead = jest.fn()
  const onMarkUnread = jest.fn()
  renderDropdown({ unread: true, onMarkRead, onMarkUnread })
  fireEvent.click(screen.getByTestId("session-row-dropdown-mark-read-s-1"))
  expect(onMarkRead).toHaveBeenCalled()
  expect(screen.queryByTestId("session-row-dropdown-mark-unread-s-1")).toBeNull()
})

test("disables every conversation write on a handed-off row and says why", () => {
  renderDropdown({
    session: { ...session, handoffLock: LOCK },
    onTogglePinned: jest.fn(),
    onArchive: jest.fn(),
    onBranch: jest.fn(),
    onCopyLink: jest.fn(),
    onExportShare: jest.fn(),
    onMarkUnread: jest.fn(),
  })
  expect(screen.getByText("lockedMenuNote")).toBeInTheDocument()
  for (const id of ["rename", "pin", "archive", "branch", "delete"]) {
    expect(screen.getByTestId(`session-row-dropdown-${id}-s-1`)).toHaveAttribute("data-disabled")
  }
  for (const id of ["copy-link", "export", "mark-unread", "handoff"]) {
    expect(screen.getByTestId(`session-row-dropdown-${id}-s-1`)).not.toHaveAttribute(
      "data-disabled"
    )
  }
  expect(screen.getByTestId("session-row-dropdown-handoff-s-1")).toHaveTextContent("handoffStatus")
})

test("switches archive for unarchive on an archived row", () => {
  const onUnarchive = jest.fn()
  renderDropdown({ session: { ...session, archivedAt: 5 }, onArchive: jest.fn(), onUnarchive })
  expect(screen.queryByTestId("session-row-dropdown-archive-s-1")).toBeNull()
  fireEvent.click(screen.getByTestId("session-row-dropdown-unarchive-s-1"))
  expect(onUnarchive).toHaveBeenCalled()
})

test("renders the desktop hand-offs with the CLI probe's answer", () => {
  renderDropdown({
    desktop: {
      codexDispatching: false,
      onOpenInCodexApp: jest.fn(),
      cogniaAgentStatus: "missing",
      onOpenInTerminal: jest.fn(),
    },
  })
  const terminal = screen.getByTestId("session-row-dropdown-terminal-s-1")
  expect(terminal).toHaveAttribute("data-disabled")
  expect(terminal).toHaveAttribute("title", "cogniaAgentNotInstalled")
  expect(screen.getByTestId("session-row-dropdown-codex-s-1")).toBeInTheDocument()
  expect(screen.queryByTestId("session-row-dropdown-codex-return-s-1")).toBeNull()
})

test("renders into a context menu with the same items", async () => {
  const onBranch = jest.fn()
  render(
    <ContextMenu>
      <ContextMenuTrigger>
        <div data-testid="target">row</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <SessionRowMenuItems
          kit={CONTEXT_MENU_KIT}
          surface="context"
          {...baseProps({ onBranch, onCopyLink: jest.fn() })}
        />
      </ContextMenuContent>
    </ContextMenu>
  )
  fireEvent.contextMenu(screen.getByTestId("target"))
  expect(await screen.findByTestId("session-row-context-copy-link-s-1")).toBeInTheDocument()
  // Selecting an item closes the menu, so it is the last thing checked.
  fireEvent.click(screen.getByTestId("session-row-context-branch-s-1"))
  expect(onBranch).toHaveBeenCalled()
})
