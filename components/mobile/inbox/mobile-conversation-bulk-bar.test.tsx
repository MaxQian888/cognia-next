/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("@/lib/data-hooks/context", () => ({ useCharacters: () => [] }))
jest.mock("@/hooks/connectors/use-conversation-labels", () => ({
  useConversationLabels: () => [{ id: "l1", name: "VIP", scope: "conversation", sortOrder: 0 }],
}))
jest.mock("@/lib/capacitor/haptics", () => ({ impact: jest.fn(async () => ({ kind: "ok" })) }))

import type { ChatSession } from "@cognia/agent-config-types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import type { ConversationRowItem } from "@/lib/inbox/conversation-grouping"
import { impact } from "@/lib/capacitor/haptics"
import {
  MobileConversationBulkBar,
  type MobileConversationBulkBarProps,
} from "./mobile-conversation-bulk-bar"

function row(id: string, extra: { unread?: number; override?: Partial<ConversationOverrideRow> } = {}) {
  return {
    session: {
      id,
      title: id,
      platformBinding: { adapterId: "a1", conversationKey: `k-${id}`, platform: "telegram" },
    } as unknown as ChatSession,
    override: extra.override
      ? ({ id: `o-${id}`, conversationKey: `k-${id}`, ...extra.override } as ConversationOverrideRow)
      : undefined,
    unreadCount: extra.unread ?? 0,
  } as ConversationRowItem
}

function renderDock(props: Partial<MobileConversationBulkBarProps> = {}) {
  const handlers = { onSelectAll: jest.fn(), onClear: jest.fn(), onRun: jest.fn() }
  render(
    <MobileConversationBulkBar
      rows={[row("a", { unread: 1 }), row("b")]}
      visibleCount={4}
      {...handlers}
      {...props}
    />
  )
  return handlers
}

describe("MobileConversationBulkBar", () => {
  it("counts the selection and selects all", () => {
    const { onSelectAll } = renderDock()
    expect(screen.getByTestId("mobile-bulk-count")).toHaveTextContent("2 selected")
    fireEvent.click(screen.getByTestId("mobile-bulk-select-all"))
    expect(onSelectAll).toHaveBeenCalled()
  })

  it("clears once everything is selected", () => {
    const { onClear } = renderDock({ visibleCount: 2 })
    expect(screen.getByTestId("mobile-bulk-select-all")).toHaveTextContent("Clear selection")
    fireEvent.click(screen.getByTestId("mobile-bulk-select-all"))
    expect(onClear).toHaveBeenCalled()
  })

  it("hints and disables the actions while nothing is checked", () => {
    renderDock({ rows: [] })
    expect(screen.getByTestId("mobile-bulk-count")).toHaveTextContent(
      "Tap conversations to select them"
    )
    for (const id of ["read", "resolve", "snooze", "archive", "more"]) {
      expect(screen.getByTestId(`mobile-bulk-${id}`)).toBeDisabled()
    }
  })

  it("runs read, resolve and archive with a haptic tap, as 44px+ targets", () => {
    const { onRun } = renderDock()
    const read = screen.getByTestId("mobile-bulk-read")
    expect(read).toHaveTextContent("Read")
    expect(read.className).toContain("min-h-14")
    fireEvent.click(read)
    expect(onRun).toHaveBeenLastCalledWith({ kind: "markRead" })
    expect(impact).toHaveBeenCalledWith("light")
    fireEvent.click(screen.getByTestId("mobile-bulk-resolve"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "setStatus", status: "resolved" })
    fireEvent.click(screen.getByTestId("mobile-bulk-archive"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "setArchived", archived: true })
  })

  it("snoozes from a sheet, offering Wake now when all are snoozed", () => {
    const { onRun } = renderDock({
      rows: [row("a", { override: { status: "snoozed" } }), row("b", { override: { status: "snoozed" } })],
    })
    fireEvent.click(screen.getByTestId("mobile-bulk-snooze"))
    expect(screen.getByTestId("mobile-bulk-sheet")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("triage-snooze-wake"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "setStatus", status: "open" })
  })

  it("offers unread, pin, assignee and labels under More", () => {
    const { onRun } = renderDock()
    fireEvent.click(screen.getByTestId("mobile-bulk-more"))
    fireEvent.click(screen.getByTestId("mobile-bulk-mark-unread"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "markUnread" })

    fireEvent.click(screen.getByTestId("mobile-bulk-more"))
    fireEvent.click(screen.getByTestId("mobile-bulk-pin"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "setPinned", pinned: true })

    fireEvent.click(screen.getByTestId("mobile-bulk-more"))
    fireEvent.click(screen.getByTestId("mobile-bulk-assign"))
    fireEvent.click(screen.getByTestId("assignee-me"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "setAssignee", assignee: { kind: "human" } })

    fireEvent.click(screen.getByTestId("mobile-bulk-more"))
    fireEvent.click(screen.getByTestId("mobile-bulk-labels"))
    fireEvent.click(screen.getByTestId("triage-label-l1"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "addLabel", labelId: "l1" })
  })
})
