/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("@/lib/data-hooks/context", () => ({ useCharacters: () => [{ id: "c1", name: "Ava" }] }))
jest.mock("@/hooks/connectors/use-conversation-labels", () => ({
  useConversationLabels: () => [{ id: "l1", name: "VIP", scope: "conversation", sortOrder: 0 }],
}))
jest.mock("@/components/inbox/platform-badge", () => ({
  PlatformBadge: ({ platform }: { platform: string }) => <span data-testid={`badge-${platform}`} />,
}))

import type { ChatSession } from "@cognia/agent-config-types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import type { ConversationRowItem } from "@/lib/inbox/conversation-grouping"
import { SessionRowSheetMenu } from "@/components/mobile/shell/session-row-sheet-kit"
import {
  MobileConversationRowActions,
  TRIAGE_SHEET_KIT,
  type MobileConversationRowActionsProps,
} from "./mobile-conversation-row-actions"

function item(extra: Partial<ConversationRowItem> & { pinned?: boolean; archived?: boolean } = {}) {
  return {
    session: {
      id: "s1",
      title: "Acme support",
      pinned: extra.pinned,
      archivedAt: extra.archived ? 1 : undefined,
      platformBinding: { adapterId: "a1", conversationKey: "tg:a1:c1", platform: "telegram" },
    } as unknown as ChatSession,
    override: extra.override,
    unreadCount: extra.unreadCount ?? 2,
  } as ConversationRowItem
}

function renderSheet(props: Partial<MobileConversationRowActionsProps> = {}) {
  const handlers = {
    onClose: jest.fn(),
    onPreview: jest.fn(),
    onSelect: jest.fn(),
    onRun: jest.fn(),
  }
  const row = props.row === undefined ? item() : props.row
  render(<MobileConversationRowActions {...handlers} {...props} row={row} />)
  return { ...handlers, row }
}

describe("MobileConversationRowActions", () => {
  it("titles the sheet with the conversation and its platform", () => {
    renderSheet()
    expect(screen.getByRole("dialog", { name: "Acme support" })).toBeInTheDocument()
    expect(screen.getByTestId("badge-telegram")).toBeInTheDocument()
  })

  it("previews and selects, closing the sheet first", () => {
    const { onPreview, onSelect, onClose, row } = renderSheet()
    fireEvent.click(screen.getByTestId("mobile-row-action-preview"))
    expect(onClose).toHaveBeenCalled()
    expect(onPreview).toHaveBeenCalledWith(row)
    fireEvent.click(screen.getByTestId("mobile-row-action-select"))
    expect(onSelect).toHaveBeenCalledWith(row)
  })

  it("runs read, pin and archive toggles on the row", () => {
    const { onRun, row } = renderSheet()
    fireEvent.click(screen.getByTestId("mobile-row-action-read"))
    expect(onRun).toHaveBeenCalledWith({ kind: "markRead" }, row)
    fireEvent.click(screen.getByTestId("mobile-row-action-pin"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "setPinned", pinned: true }, row)
    fireEvent.click(screen.getByTestId("mobile-row-action-archive"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "setArchived", archived: true }, row)
  })

  it("words the toggles from the row's state", () => {
    renderSheet({ row: item({ unreadCount: 0, pinned: true, archived: true }) })
    expect(screen.getByTestId("mobile-row-action-read")).toHaveTextContent("Mark as unread")
    expect(screen.getByTestId("mobile-row-action-pin")).toHaveTextContent("Unpin")
    expect(screen.getByTestId("mobile-row-action-archive")).toHaveTextContent("Unarchive")
  })

  it("sets the status from the status page", () => {
    const { onRun, row } = renderSheet({
      row: item({
        override: {
          id: "o",
          conversationKey: "tg:a1:c1",
          status: "snoozed",
          labelIds: ["l1"],
        } as ConversationOverrideRow,
      }),
    })
    fireEvent.click(screen.getByTestId("mobile-row-action-status"))
    fireEvent.click(screen.getByTestId("triage-status-pending"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "setStatus", status: "pending" }, row)
  })

  it("wakes a snoozed conversation from the snooze page", () => {
    const snoozed = item({
      override: { id: "o", conversationKey: "tg:a1:c1", status: "snoozed" } as ConversationOverrideRow,
    })
    const { onRun } = renderSheet({ row: snoozed })
    fireEvent.click(screen.getByTestId("mobile-row-action-snooze"))
    fireEvent.click(screen.getByTestId("triage-snooze-wake"))
    expect(onRun).toHaveBeenLastCalledWith({ kind: "setStatus", status: "open" }, snoozed)
  })

  it("assigns from the assign page, under plain headings", () => {
    const { onRun, row } = renderSheet()
    fireEvent.click(screen.getByTestId("mobile-row-action-assign"))
    // A heading, not the sheet's amber warning note.
    expect(screen.getByText("Character")).not.toHaveAttribute("role", "note")
    fireEvent.click(screen.getByTestId("assignee-character-c1"))
    expect(onRun).toHaveBeenLastCalledWith(
      { kind: "setAssignee", assignee: { kind: "character", id: "c1", label: "Ava" } },
      row
    )
  })

  it("toggles a label from the labels page", () => {
    const labelled = item({
      override: { id: "o", conversationKey: "tg:a1:c1", labelIds: ["l1"] } as ConversationOverrideRow,
    })
    const { onRun } = renderSheet({ row: labelled })
    fireEvent.click(screen.getByTestId("mobile-row-action-labels"))
    const vip = screen.getByTestId("triage-label-l1")
    expect(vip).toHaveTextContent("On")
    fireEvent.click(vip)
    expect(onRun).toHaveBeenLastCalledWith({ kind: "removeLabel", labelId: "l1" }, labelled)
  })

  it("omits Select when the host offers no selection mode", () => {
    renderSheet({ onSelect: undefined })
    expect(screen.queryByTestId("mobile-row-action-select")).not.toBeInTheDocument()
  })

  it("is closed without a row", () => {
    renderSheet({ row: null })
    expect(screen.queryByTestId("mobile-conversation-actions")).not.toBeInTheDocument()
  })

  it("extends the sheet kit with a plain heading distinct from its warning label", () => {
    const { Heading, Label } = TRIAGE_SHEET_KIT
    if (!Heading) throw new Error("TRIAGE_SHEET_KIT must provide a Heading part")
    render(
      <SessionRowSheetMenu label="Acme support" onPicked={jest.fn()}>
        <Heading>Characters</Heading>
        <Label>Locked by the host</Label>
      </SessionRowSheetMenu>
    )
    // The triage lists head their groups with `Heading`; falling back to the
    // sheet's `Label` would render every group title as an amber warning note.
    const heading = screen.getByText("Characters")
    expect(heading).not.toHaveAttribute("role")
    expect(screen.getByRole("note")).toHaveTextContent("Locked by the host")
    expect(screen.getAllByRole("note")).toHaveLength(1)
    // The sheet draws checked state as an On/Off row, not a checkbox part.
    expect(TRIAGE_SHEET_KIT.CheckboxItem).toBeUndefined()
  })
})
