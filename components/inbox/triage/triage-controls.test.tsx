/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/lib/db/session-state", () => ({
  markSessionRead: jest.fn().mockResolvedValue(undefined),
  markSessionUnread: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

// The shared group is covered by its own suite; here it only has to be the
// one source of the status rows.
jest.mock("../conversation-control-groups", () => {
  const actual = jest.requireActual("../conversation-control-groups")
  return {
    ...actual,
    ConversationStatusControls: (props: { layout: string; sessionId: string }) => (
      <div data-testid="status-group" data-layout={props.layout} data-session={props.sessionId} />
    ),
  }
})
jest.mock("../conversation-mode-control", () => ({
  ConversationModeControl: ({ onOpenAdvanced }: { onOpenAdvanced?: () => void }) => (
    <button type="button" onClick={onOpenAdvanced}>
      mode-control
    </button>
  ),
}))

import { toast } from "sonner"
import { markSessionRead, markSessionUnread } from "@/lib/db/session-state"
import type { TriageConversation } from "@/hooks/inbox/use-triage-conversation"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import { TriageControls } from "./triage-controls"

const mockRead = markSessionRead as jest.Mock
const mockUnread = markSessionUnread as jest.Mock

function conversation(over: Partial<TriageConversation> = {}): TriageConversation {
  return {
    session: { id: "s1", title: "Acme" } as TriageConversation["session"],
    conversationKey: "lark:a1:oc",
    adapterId: "a1",
    platform: "lark",
    override: undefined,
    adapter: undefined,
    policy: undefined,
    unreadCount: 0,
    ...over,
  }
}

beforeEach(() => {
  mockRead.mockReset().mockResolvedValue(undefined)
  mockUnread.mockReset().mockResolvedValue(undefined)
  ;(toast.error as jest.Mock).mockReset()
})

describe("TriageControls", () => {
  it("draws the shared status group as list rows", () => {
    render(<TriageControls conversation={conversation()} onOpenSettings={() => {}} />)
    expect(screen.getByTestId("status-group")).toHaveAttribute("data-layout", "list")
    expect(screen.getByTestId("status-group")).toHaveAttribute("data-session", "s1")
    expect(screen.getByTestId("triage-controls").tagName).toBe("DL")
  })

  it("routes the custom mode to the settings dialog", async () => {
    const onOpenSettings = jest.fn()
    render(<TriageControls conversation={conversation()} onOpenSettings={onOpenSettings} />)
    await userEvent.click(screen.getByRole("button", { name: "mode-control" }))
    expect(onOpenSettings).toHaveBeenCalled()
  })

  it("marks an unread conversation read only when asked", async () => {
    render(
      <TriageControls conversation={conversation({ unreadCount: 3 })} onOpenSettings={() => {}} />
    )
    expect(screen.getByTestId("triage-unread-state")).toHaveTextContent("3 unread messages")
    // Rendering the preview is not reading it.
    expect(mockRead).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "Mark read" }))
    expect(mockRead).toHaveBeenCalledWith("s1")
    expect(mockUnread).not.toHaveBeenCalled()
  })

  it("marks a read conversation unread", async () => {
    render(<TriageControls conversation={conversation()} onOpenSettings={() => {}} />)
    expect(screen.getByTestId("triage-unread-state")).toHaveTextContent("All read")
    await userEvent.click(screen.getByRole("button", { name: "Mark unread" }))
    expect(mockUnread).toHaveBeenCalledWith("s1")
  })

  it("toasts a failed read-state write", async () => {
    mockRead.mockRejectedValueOnce(new Error("offline"))
    render(
      <TriageControls conversation={conversation({ unreadCount: 1 })} onOpenSettings={() => {}} />
    )
    await userEvent.click(screen.getByRole("button", { name: "Mark read" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't mark the conversation as read")
    )
    expect(screen.getByRole("button", { name: "Mark read" })).toBeEnabled()
  })

  it("shows when a snooze ends", () => {
    render(
      <TriageControls
        conversation={conversation({
          override: {
            conversationKey: "lark:a1:oc",
            status: "snoozed",
            snoozeUntil: Date.UTC(2026, 9, 10, 9, 0),
          } as ConversationOverrideRow,
        })}
        onOpenSettings={() => {}}
      />
    )
    expect(screen.getByTestId("control-snoozed-until")).toHaveTextContent("Snoozed until")
    expect(screen.getByTestId("control-snoozed-until").querySelector("time")).toHaveAttribute(
      "dateTime",
      "2026-10-10T09:00:00.000Z"
    )
  })

  it("has no snooze row when not snoozed", () => {
    render(<TriageControls conversation={conversation()} onOpenSettings={() => {}} />)
    expect(screen.queryByTestId("control-snoozed-until")).not.toBeInTheDocument()
  })
})
