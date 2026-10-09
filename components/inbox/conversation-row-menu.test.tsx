/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("@/components/ui/dropdown-menu")
jest.mock("@/lib/data-hooks/context", () => ({ useCharacters: () => [] }))
jest.mock("@/hooks/connectors/use-conversation-labels", () => ({
  useConversationLabels: () => [
    { id: "l1", name: "VIP", scope: "conversation", sortOrder: 0 },
    { id: "l2", name: "Bug", scope: "conversation", sortOrder: 1 },
  ],
}))

import { useRouter } from "next/navigation"
import type { TriageTarget } from "@/lib/inbox/bulk-triage"
import { ConversationRowMenu, type ConversationRowMenuProps } from "./conversation-row-menu"

function target(extra: Partial<TriageTarget> = {}): TriageTarget {
  return {
    sessionId: "s1",
    conversationKey: "tg:a1:c1",
    adapterId: "a1",
    status: "open",
    labelIds: ["l1"],
    pinned: false,
    archived: false,
    unread: true,
    ...extra,
  }
}

function renderMenu(props: Partial<ConversationRowMenuProps> = {}) {
  const onTriage = jest.fn()
  const onModeChange = jest.fn()
  render(
    <ConversationRowMenu
      target={target()}
      mode="full"
      onModeChange={onModeChange}
      onTriage={onTriage}
      triggerLabel="Session actions"
      {...props}
    />
  )
  return { onTriage, onModeChange }
}

describe("ConversationRowMenu", () => {
  it("offers read state, pin, status, snooze, assignee, labels and archive", () => {
    const { onTriage } = renderMenu()
    fireEvent.click(screen.getByTestId("row-menu-toggle-read"))
    expect(onTriage).toHaveBeenLastCalledWith({ kind: "markRead" })
    fireEvent.click(screen.getByTestId("row-menu-toggle-pin"))
    expect(onTriage).toHaveBeenLastCalledWith({ kind: "setPinned", pinned: true })
    fireEvent.click(screen.getByTestId("triage-status-pending"))
    expect(onTriage).toHaveBeenLastCalledWith({ kind: "setStatus", status: "pending" })
    fireEvent.click(screen.getByTestId("triage-snooze-24h"))
    expect(onTriage).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "setStatus", status: "snoozed" })
    )
    fireEvent.click(screen.getByTestId("assignee-me"))
    expect(onTriage).toHaveBeenLastCalledWith({ kind: "setAssignee", assignee: { kind: "human" } })
    // l1 is on the conversation: toggling removes it; l2 adds.
    fireEvent.click(screen.getByTestId("triage-label-l1"))
    expect(onTriage).toHaveBeenLastCalledWith({ kind: "removeLabel", labelId: "l1" })
    fireEvent.click(screen.getByTestId("triage-label-l2"))
    expect(onTriage).toHaveBeenLastCalledWith({ kind: "addLabel", labelId: "l2" })
    fireEvent.click(screen.getByTestId("row-menu-toggle-archive"))
    expect(onTriage).toHaveBeenLastCalledWith({ kind: "setArchived", archived: true })
  })

  it("words the toggles from the conversation's state and offers Wake now when snoozed", () => {
    const { onTriage } = renderMenu({
      target: target({ unread: false, pinned: true, archived: true, status: "snoozed" }),
    })
    expect(screen.getByTestId("row-menu-toggle-read")).toHaveTextContent("Mark as unread")
    expect(screen.getByTestId("row-menu-toggle-pin")).toHaveTextContent("Unpin")
    expect(screen.getByTestId("row-menu-toggle-archive")).toHaveTextContent("Unarchive")
    fireEvent.click(screen.getByTestId("triage-snooze-wake"))
    expect(onTriage).toHaveBeenLastCalledWith({ kind: "setStatus", status: "open" })
  })

  it("shows only the snooze list in snooze mode", () => {
    renderMenu({ mode: "snooze" })
    expect(screen.getByTestId("triage-snooze-1h")).toBeInTheDocument()
    expect(screen.queryByTestId("row-menu-toggle-read")).not.toBeInTheDocument()
    expect(screen.queryByTestId("assignee-me")).not.toBeInTheDocument()
  })

  it("shows only the assignee list in assign mode", () => {
    renderMenu({ mode: "assign" })
    expect(screen.getByTestId("assignee-me")).toBeInTheDocument()
    expect(screen.queryByTestId("triage-snooze-1h")).not.toBeInTheDocument()
  })

  it("shows only the labels in label mode, with a way to the label manager", () => {
    const push = jest.fn()
    const spy = jest
      .spyOn(jest.requireMock("next/navigation") as { useRouter: typeof useRouter }, "useRouter")
      .mockReturnValue({ push } as never)
    renderMenu({ mode: "label" })
    expect(screen.getByTestId("triage-label-l2")).toBeInTheDocument()
    expect(screen.queryByTestId("row-menu-toggle-read")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("triage-label-manage"))
    expect(push).toHaveBeenCalledWith("/settings?section=connections&connectionsTab=assets")
    spy.mockRestore()
  })

  it("names its trigger", () => {
    renderMenu({ mode: null })
    expect(screen.getByRole("button", { name: "Session actions" })).toBeInTheDocument()
  })
})
