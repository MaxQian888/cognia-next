/** @jest-environment jsdom */
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ChatSession } from "@cognia/agent-config-types"

import { SessionCommunicationSheet } from "./session-communication-sheet"

const createAttachedSession = jest.fn()
const revealSpawnedTask = jest.fn()
jest.mock("@/lib/chat/attached-session", () => ({
  createAttachedSession: (...args: unknown[]) => createAttachedSession(...args),
  listAttachedSessions: jest.fn(async () => []),
}))
jest.mock("@/lib/tasks/spawn-task-dispatch", () => ({
  revealSpawnedTask: (...args: unknown[]) => revealSpawnedTask(...args),
}))
jest.mock("@/lib/chat/session-peer-messaging", () => ({
  listReachableSessions: jest.fn(async () => []),
  sendSessionPeerMessage: jest.fn(),
  decideHeldSessionPeerMessage: jest.fn(),
  drainSessionPeerMessages: jest.fn(),
}))
jest.mock("@/lib/db/session-peer-messages", () => ({
  expireSessionPeerMessages: jest.fn(async () => 0),
  listSessionInbox: jest.fn(async () => []),
  listSessionOutbox: jest.fn(async () => []),
}))
jest.mock("@/lib/db/sessions", () => ({
  listSessions: jest.fn(async () => []),
  updateSession: jest.fn(async () => undefined),
}))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => [] }))
jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (state: { openSessionIds: string[] }) => unknown) =>
    selector({ openSessionIds: ["parent-1"] }),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

const messages = {
  chat: {
    sessionCommunication: {
      title: "Session communication",
      description: "Attached work and live peer handoffs.",
      attachedTab: "Attached sessions",
      peerTab: "Message session",
      attachedTitleLabel: "Task title",
      attachedPromptLabel: "Initial prompt",
      contextLabel: "Context fork",
      contextNone: "No parent context",
      contextLastN: "Last messages",
      contextFull: "Full context",
      turnsLabel: "Messages to carry",
      workspaceLabel: "Workspace",
      workspaceShared: "Share parent workspace",
      workspaceIndependent: "Independent workspace",
      createAttached: "Create attached session",
      attachedCreated: "Attached session created.",
      attachedCreateError: "Couldn't create attached session.",
      noAttached: "No attached sessions yet.",
      openAttached: "Open",
      resultLabel: "Result",
      policyLabel: "Incoming policy",
      policyAccept: "Accept",
      policyHold: "Hold for approval",
      policyRefuse: "Refuse",
      targetLabel: "Target session",
      targetPlaceholder: "Choose a live session",
      messageLabel: "Message",
      intentLabel: "Delivery intent",
      intentNote: "Note only",
      intentTrigger: "Start a turn",
      send: "Send message",
      sent: "Message status: {status}",
      sendError: "Couldn't send message.",
      noReachable: "No other live sessions in this workspace.",
      inboxTitle: "Inbox",
      outboxTitle: "Receipts",
      noInbox: "No incoming messages.",
      noOutbox: "No sent messages.",
      acceptHeld: "Accept",
      refuseHeld: "Refuse",
      from: "From {name}",
      attachedStatus: {
        closed: "Closed",
        completed: "Completed",
        interrupted: "Interrupted",
        running: "Running",
        staged: "Ready",
      },
      messageStatus: {
        delivered: "Delivered",
        expired: "Expired",
        held: "Awaiting approval",
        queued: "Queued",
        refused: "Refused",
        targetUnavailable: "Target unavailable",
      },
    },
  },
}

const session: ChatSession = {
  id: "parent-1",
  projectId: "project-1",
  title: "Parent",
  kind: "direct",
  createdAt: 1,
  updatedAt: 1,
}

describe("SessionCommunicationSheet", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    createAttachedSession.mockResolvedValue({ id: "child-1" })
  })

  it("creates and reveals an attached session through the public lifecycle seam", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <SessionCommunicationSheet session={session} open onOpenChange={jest.fn()} />
      </NextIntlClientProvider>
    )

    fireEvent.change(screen.getByLabelText("Task title"), {
      target: { value: "Review migration" },
    })
    fireEvent.change(screen.getByLabelText("Initial prompt"), {
      target: { value: "Check schema v155" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create attached session" }))

    await waitFor(() =>
      expect(createAttachedSession).toHaveBeenCalledWith({
        parentSessionId: "parent-1",
        title: "Review migration",
        prompt: "Check schema v155",
        context: { mode: "none" },
        workspace: "shared",
      })
    )
    expect(revealSpawnedTask).toHaveBeenCalledWith("parent-1", "child-1")
  })
})
