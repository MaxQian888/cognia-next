/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("@/components/ui/dropdown-menu")
jest.mock("@/components/ui/tooltip")
jest.mock("@/lib/data-hooks/context", () => ({ useCharacters: () => [] }))
jest.mock("@/hooks/connectors/use-conversation-labels", () => ({
  useConversationLabels: () => [
    { id: "l1", name: "VIP", scope: "conversation", sortOrder: 0 },
    { id: "l2", name: "Bug", scope: "conversation", sortOrder: 1 },
  ],
}))

import type { ChatSession } from "@cognia/agent-config-types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import type { ConversationRowItem } from "@/lib/inbox/conversation-grouping"
import {
  bulkSelectionFacts,
  ConversationBulkBar,
  type ConversationBulkBarProps,
} from "./conversation-bulk-bar"

function row(
  id: string,
  extra: {
    unread?: number
    pinned?: boolean
    archived?: boolean
    override?: Partial<ConversationOverrideRow>
  } = {}
): ConversationRowItem {
  return {
    session: {
      id,
      title: id,
      pinned: extra.pinned,
      archivedAt: extra.archived ? 1 : undefined,
      platformBinding: { adapterId: "a1", conversationKey: `k-${id}`, platform: "telegram" },
    } as unknown as ChatSession,
    override: extra.override
      ? ({
          id: `o-${id}`,
          conversationKey: `k-${id}`,
          ...extra.override,
        } as ConversationOverrideRow)
      : undefined,
    unreadCount: extra.unread ?? 0,
  }
}

function renderBar(props: Partial<ConversationBulkBarProps> = {}) {
  const handlers = {
    onSelectAll: jest.fn(),
    onClear: jest.fn(),
    onRun: jest.fn(),
    onMenuChange: jest.fn(),
  }
  render(
    <ConversationBulkBar
      rows={[row("a", { unread: 1 }), row("b")]}
      visibleCount={5}
      {...handlers}
      {...props}
    />
  )
  return handlers
}

describe("bulkSelectionFacts", () => {
  it("derives the toggles and what the selection has in common", () => {
    const facts = bulkSelectionFacts([
      row("a", { pinned: true, override: { status: "snoozed", assignee: { kind: "human" } } }),
      row("b", { override: { status: "snoozed", assignee: { kind: "human" } } }),
    ])
    expect(facts.readAction).toEqual({ kind: "markUnread" })
    expect(facts.pinAction).toEqual({ kind: "setPinned", pinned: true })
    expect(facts.archiveAction).toEqual({ kind: "setArchived", archived: true })
    expect(facts.allSnoozed).toBe(true)
    expect(facts.commonAssignee).toEqual({ kind: "human" })
  })

  it("has no common assignee when they differ, and none for an empty selection", () => {
    expect(
      bulkSelectionFacts([row("a", { override: { assignee: { kind: "human" } } }), row("b")])
        .commonAssignee
    ).toBeUndefined()
    expect(bulkSelectionFacts([row("a"), row("b")]).commonAssignee).toBeNull()
    expect(bulkSelectionFacts([]).allSnoozed).toBe(false)
  })
})

describe("ConversationBulkBar", () => {
  it("counts the selection in a labelled toolbar", () => {
    renderBar()
    expect(
      screen.getByRole("toolbar", { name: "Actions for 2 selected conversations" })
    ).toBeInTheDocument()
    expect(screen.getByTestId("conversation-bulk-count")).toHaveTextContent("2 selected")
  })

  it("selects all from a partial selection and clears from a full one", () => {
    const partial = renderBar()
    fireEvent.click(screen.getByTestId("conversation-bulk-select-all"))
    expect(partial.onSelectAll).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("conversation-bulk-clear"))
    expect(partial.onClear).toHaveBeenCalled()
  })

  it("clears from the select-all box once everything is checked", () => {
    const full = renderBar({ visibleCount: 2 })
    expect(screen.getByTestId("conversation-bulk-select-all")).toHaveAccessibleName(
      "Clear selection"
    )
    fireEvent.click(screen.getByTestId("conversation-bulk-select-all"))
    expect(full.onClear).toHaveBeenCalled()
  })

  it("runs read, resolve, snooze and archive over the selection", () => {
    const { onRun } = renderBar()
    fireEvent.click(screen.getByTestId("conversation-bulk-read"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "markRead" })
    fireEvent.click(screen.getByTestId("conversation-bulk-resolve"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "setStatus", status: "resolved" })
    fireEvent.click(screen.getByTestId("triage-snooze-1h"))
    expect(onRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "setStatus", status: "snoozed" })
    )
    fireEvent.click(screen.getByTestId("conversation-bulk-archive"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "setArchived", archived: true })
  })

  it("offers unread, pin, assignee and tri-state labels under More", () => {
    const { onRun } = renderBar({
      rows: [row("a", { override: { labelIds: ["l1"] } }), row("b")],
    })
    fireEvent.click(screen.getByTestId("conversation-bulk-mark-unread"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "markUnread" })
    fireEvent.click(screen.getByTestId("conversation-bulk-mark-read"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "markRead" })
    fireEvent.click(screen.getByTestId("conversation-bulk-pin"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "setPinned", pinned: true })
    fireEvent.click(screen.getByTestId("assignee-unassign"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "setAssignee", assignee: null })
    // l1 is on one of two rows: mixed, so a toggle adds it everywhere.
    const vip = screen.getByTestId("triage-label-l1")
    expect(vip).toHaveAttribute("aria-checked", "indeterminate")
    fireEvent.click(vip)
    expect(onRun).toHaveBeenLastCalledWith({ kind: "addLabel", labelId: "l1" })
  })

  it("shows just the assignee list when the keyboard opens it", () => {
    renderBar({ menu: "assign" })
    expect(screen.getByTestId("assignee-me")).toBeInTheDocument()
    expect(screen.queryByTestId("conversation-bulk-mark-unread")).not.toBeInTheDocument()
  })

  it("shows just the labels when the keyboard opens them", () => {
    renderBar({ menu: "label" })
    expect(screen.getByTestId("triage-label-l2")).toBeInTheDocument()
    expect(screen.queryByTestId("conversation-bulk-mark-unread")).not.toBeInTheDocument()
  })

  it("words the toggles for an archived, already-read, pinned selection", () => {
    renderBar({ rows: [row("a", { archived: true, pinned: true })], visibleCount: 3 })
    expect(screen.getByTestId("conversation-bulk-read")).toHaveAccessibleName("Mark as unread")
    expect(screen.getByTestId("conversation-bulk-archive")).toHaveAccessibleName("Unarchive")
    expect(screen.getByTestId("conversation-bulk-pin")).toHaveTextContent("Unpin")
  })
})
