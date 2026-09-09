import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

const resolveContext = jest.fn()
let mockSyncObserver: (() => void) | undefined
const mockDelete = jest.fn()
const mockClose = jest.fn()
const mockConvert = jest.fn()
const mockSync = jest.fn()
const mockActive = jest.fn()
jest.mock("@/lib/collab/shared-chat-conversion", () => ({
  convertLocalSessionToShared: (...args: unknown[]) => mockConvert(...args),
}))
jest.mock("@/lib/collab/shared-chat-sync", () => ({
  syncSharedSession: (...args: unknown[]) => mockSync(...args),
  sharedChatCacheKey: () => "cache",
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    collabChatSyncStates: { get: async () => ({ connected: true }) },
    messages: {
      where: () => ({
        equals: () => ({
          toArray: async () => [
            {
              id: "old",
              role: "user",
              parts: [{ type: "file" }],
              collaboration: { eventSequence: 1 },
              createdAt: 1,
            },
            {
              id: "new",
              role: "user",
              parts: [],
              collaboration: { eventSequence: 2 },
              createdAt: 2,
            },
            {
              id: "redacted",
              role: "user",
              parts: [],
              collaboration: { redactedAt: 1 },
              createdAt: 3,
            },
          ],
        }),
      }),
    },
  }),
}))
const mockMessage = { id: "durable-message" }
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (_query: () => unknown, deps: unknown[]) => (
    _query(),
    deps.length === 2 ? mockMessage : { connected: true }
  ),
}))
jest.mock("dexie", () => ({
  __esModule: true,
  ...jest.requireActual("dexie"),
  default: jest.requireActual("dexie").default ?? jest.requireActual("dexie"),
  liveQuery: () => ({
    subscribe: (observer: { next: () => void }) => {
      mockSyncObserver = observer.next
      return { unsubscribe: jest.fn() }
    },
  }),
}))
jest.mock("@/lib/db/sessions", () => ({
  deleteSession: (...args: unknown[]) => mockDelete(...args),
}))
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ closeSession: mockClose, setActiveSession: mockActive }) },
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("@/lib/collab/runtime-client", () => ({
  resolveCurrentCollabContext: (...args: unknown[]) => resolveContext(...args),
}))

import { SharedSessionPanel } from "./shared-session-panel"

function session(collaboration?: ChatSession["collaboration"]): ChatSession {
  return {
    id: "local_1",
    projectId: "workspace_1",
    title: "Conversation",
    kind: "direct",
    createdAt: 1,
    updatedAt: 1,
    collaboration,
  }
}

describe("SharedSessionPanel", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
    jest.clearAllMocks()
    resolveContext.mockReset().mockResolvedValue(null)
  })

  it("marks legacy and local sessions private by default", () => {
    render(<SharedSessionPanel session={session()} />)
    // Icon-only in the header: the state word lives in `title`, not in the row.
    expect(screen.getByRole("button", { name: "openPrivateSession" })).toHaveAttribute(
      "title",
      "private"
    )
  })

  it("marks a server-bound session shared and exposes a configured-state explanation", async () => {
    render(
      <SharedSessionPanel
        session={session({
          orgId: "org_1",
          workspaceId: "workspace_1",
          sessionId: "shared_1",
          policyRevision: 1,
          syncCursor: 0,
        })}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "openSharedSession" }))
    await waitFor(() => expect(screen.getByText("notConfigured")).toBeInTheDocument())
  })
})

const shared = session({
  orgId: "org_1",
  workspaceId: "workspace_1",
  sessionId: "shared_1",
  policyRevision: 1,
  syncCursor: 0,
})
function configured(role = "owner") {
  const client = {
    baseUrl: "https://collab.test",
    getSharedSession: jest.fn().mockResolvedValue({ policyRevision: 1, revision: 1 }),
    listSessionMembers: jest
      .fn()
      .mockResolvedValue([{ userId: "me", role, guest: false, approver: false }]),
    listSessionApprovals: jest.fn().mockResolvedValue([]),
    getActiveSessionRunLease: jest.fn().mockResolvedValue(null),
    listSessionRunQueue: jest
      .fn()
      .mockResolvedValue([
        { id: "queued", status: "queued", requestedByUserId: "me", position: 1 },
      ]),
    myMemberships: jest.fn().mockResolvedValue({ orgRole: "member" }),
    listSessionInvites: jest
      .fn()
      .mockResolvedValue([
        { id: "invite", status: "pending", expiresAt: 1, targetUserId: "invitee" },
      ]),
    listSessionAuthorizationAudit: jest.fn().mockResolvedValue([]),
    revokeSessionInvite: jest.fn().mockResolvedValue({}),
    removeSessionMember: jest.fn().mockResolvedValue(undefined),
    createSessionInvite: jest.fn().mockResolvedValue({ token: "secret" }),
    acceptSessionInvite: jest.fn().mockResolvedValue({ invite: { sessionId: "shared_1" } }),
    resolveSessionApproval: jest.fn().mockResolvedValue({}),
    cancelSessionRunQueueItem: jest.fn().mockResolvedValue({}),
    createSessionBreakGlassGrant: jest.fn().mockResolvedValue({ id: "grant" }),
    listSessionBreakGlassEvents: jest.fn().mockResolvedValue([{ id: "raw" }]),
    deleteSharedSession: jest.fn().mockResolvedValue({}),
    updateSessionMember: jest.fn().mockResolvedValue({}),
  }
  resolveContext.mockResolvedValue({ orgId: "org_1", userId: "me", client })
  return client
}
it("requests AI for a durable message independently from Send", () => {
  const listener = jest.fn()
  window.addEventListener("cognia:shared-request-ai", listener)
  render(<SharedSessionPanel session={shared} />)
  fireEvent.click(screen.getByRole("button", { name: "requestAI" }))
  expect(listener.mock.calls[0][0].detail).toEqual({
    sessionId: "local_1",
    messageId: "durable-message",
    takeover: false,
  })
  window.removeEventListener("cognia:shared-request-ai", listener)
})
it("revokes pending invites and prevents the last owner from leaving", async () => {
  const client = configured()
  render(<SharedSessionPanel session={shared} />)
  fireEvent.click(screen.getByRole("button", { name: "openSharedSession" }))
  await screen.findByText("inviteExpired")
  expect(screen.getByRole("button", { name: "leaveConversation" })).toBeDisabled()
  expect(screen.getByText("transferBeforeLeaving")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "revokeInvite" }))
  await waitFor(() =>
    expect(client.revokeSessionInvite).toHaveBeenCalledWith("org_1", "shared_1", "invite")
  )
})
it("lets a regular member explicitly leave and closes its local projection", async () => {
  const client = configured("member")
  render(<SharedSessionPanel session={shared} />)
  fireEvent.click(screen.getByRole("button", { name: "openSharedSession" }))
  fireEvent.click(await screen.findByRole("button", { name: "leaveConversation" }))
  await waitFor(() =>
    expect(client.removeSessionMember).toHaveBeenCalledWith("org_1", "shared_1", "me")
  )
  await waitFor(() => expect(mockClose).toHaveBeenCalledWith("local_1"))
})

it("creates a restricted invitation and cancels queued requests", async () => {
  const client = configured()
  render(<SharedSessionPanel session={shared} />)
  fireEvent.click(screen.getByRole("button", { name: "openSharedSession" }))
  fireEvent.change(await screen.findByLabelText("userId"), { target: { value: "invitee" } })
  fireEvent.click(screen.getByRole("button", { name: "createInvite" }))
  await screen.findByRole("button", { name: "copyInvite" })
  expect(client.createSessionInvite).toHaveBeenCalledWith(
    "org_1",
    "shared_1",
    expect.objectContaining({ targetUserId: "invitee", role: "member", guest: false })
  )
  fireEvent.click(screen.getByRole("button", { name: "cancelQueued" }))
  await waitFor(() =>
    expect(client.cancelSessionRunQueueItem).toHaveBeenCalledWith("org_1", "shared_1", "queued")
  )
})
it("only converts a local conversation after the explicit share action", async () => {
  configured()
  render(<SharedSessionPanel session={session()} />)
  fireEvent.click(screen.getByRole("button", { name: "openPrivateSession" }))
  await screen.findByRole("button", { name: "convertAndShare" })
  expect(mockConvert).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "convertAndShare" }))
  await waitFor(() => expect(mockConvert).toHaveBeenCalled())
})
it("offers no share for a team room, and says why rather than hiding the button", async () => {
  // Converting a team room left it as both a team session and a shared one:
  // `useTeamChat` kept writing replies locally while the sync pulled server
  // events into the same list. A hidden button could not tell "not for this
  // conversation" from "broken", so it stays visible and disabled.
  configured()
  render(<SharedSessionPanel session={{ ...session(), kind: "team", teamId: "team_1" }} />)
  fireEvent.click(screen.getByRole("button", { name: "openPrivateSession" }))
  const share = await screen.findByRole("button", { name: "convertAndShare" })
  expect(share).toBeDisabled()
  expect(screen.getByText("teamRoomConversion")).toBeInTheDocument()
  fireEvent.click(share)
  expect(mockConvert).not.toHaveBeenCalled()
})
it("accepts an invitation from private conversation controls", async () => {
  const client = configured()
  mockSync.mockResolvedValue({ localSessionId: "joined" })
  render(<SharedSessionPanel session={session()} />)
  fireEvent.click(screen.getByRole("button", { name: "openPrivateSession" }))
  fireEvent.change(await screen.findByLabelText("inviteToken"), { target: { value: " token " } })
  fireEvent.click(screen.getByRole("button", { name: "acceptInvite" }))
  await waitFor(() => expect(client.acceptSessionInvite).toHaveBeenCalledWith("org_1", "token"))
  await waitFor(() => expect(mockActive).toHaveBeenCalledWith("joined"))
})
it("resolves high-risk approval and deletes only after confirmation", async () => {
  const client = configured()
  client.listSessionApprovals.mockResolvedValue([
    { id: "approval", status: "pending", action: "shell", risk: "high", revision: 1 },
  ])
  render(<SharedSessionPanel session={shared} />)
  fireEvent.click(screen.getByRole("button", { name: "openSharedSession" }))
  fireEvent.click(await screen.findByRole("button", { name: "approve" }))
  await waitFor(() =>
    expect(client.resolveSessionApproval).toHaveBeenCalledWith("org_1", "shared_1", "approval", {
      status: "approved",
      baseRevision: 1,
    })
  )
  fireEvent.click(screen.getByRole("button", { name: "deleteConversation" }))
  expect(client.deleteSharedSession).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole("button", { name: "confirmDelete" }))
  await waitFor(() => expect(client.deleteSharedSession).toHaveBeenCalled())
})
it("requires a reason before an organization admin can expose audited raw events", async () => {
  const client = configured()
  client.myMemberships.mockResolvedValue({ orgRole: "admin" })
  render(<SharedSessionPanel session={shared} />)
  fireEvent.click(screen.getByRole("button", { name: "openSharedSession" }))
  expect(await screen.findByRole("button", { name: "breakGlassAction" })).toBeDisabled()
  fireEvent.change(screen.getByLabelText("breakGlassReason"), {
    target: { value: "Investigating an incident" },
  })
  fireEvent.click(screen.getByRole("button", { name: "breakGlassAction" }))
  await waitFor(() => expect(client.createSessionBreakGlassGrant).toHaveBeenCalled())
  expect(await screen.findByLabelText("rawEvents")).toBeInTheDocument()
})

it("removes another member and updates their explicit approver flag", async () => {
  const client = configured()
  client.listSessionMembers.mockResolvedValue([
    { userId: "me", role: "owner" },
    { userId: "other", role: "member", guest: false, approver: false },
  ])
  render(<SharedSessionPanel session={shared} />)
  fireEvent.click(screen.getByRole("button", { name: "openSharedSession" }))
  fireEvent.click(await screen.findByRole("checkbox", { name: /toggleApprover.*other/ }))
  await waitFor(() =>
    expect(client.updateSessionMember).toHaveBeenCalledWith("org_1", "shared_1", "other", {
      role: "member",
      approver: true,
      guest: false,
    })
  )
  fireEvent.click(screen.getByRole("button", { name: "remove" }))
  await waitFor(() =>
    expect(client.removeSessionMember).toHaveBeenCalledWith("org_1", "shared_1", "other")
  )
})
it("copies a new guest invitation and shows authorization audit metadata", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
  })
  const client = configured()
  client.listSessionAuthorizationAudit.mockResolvedValue([
    { id: "audit", allowed: true, action: "session.read", actorUserId: "me", reason: "owner" },
    {
      id: "denied",
      allowed: false,
      action: "session.delete",
      actorUserId: "other",
      reason: "member",
    },
  ])
  render(<SharedSessionPanel session={shared} />)
  fireEvent.click(screen.getByRole("button", { name: "openSharedSession" }))
  fireEvent.click(await screen.findByRole("checkbox", { name: "guest" }))
  fireEvent.click(screen.getByRole("button", { name: "createInvite" }))
  fireEvent.click(await screen.findByRole("button", { name: "copyInvite" }))
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith("secret")
  expect(screen.getByText("allowed")).toBeInTheDocument()
  expect(screen.getByText("denied")).toBeInTheDocument()
})

it("keeps AI actions disabled while offline and never requests on reconnect", () => {
  const listener = jest.fn()
  window.addEventListener("cognia:shared-request-ai", listener)
  render(<SharedSessionPanel session={shared} />)
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false })
  fireEvent(window, new Event("offline"))
  expect(screen.getByRole("button", { name: "requestAI" })).toBeDisabled()
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
  fireEvent(window, new Event("online"))
  expect(screen.getByRole("button", { name: "requestAI" })).toBeEnabled()
  expect(listener).not.toHaveBeenCalled()
  window.removeEventListener("cognia:shared-request-ai", listener)
})
it("requires an explicit takeover action for the queued run", async () => {
  configured()
  const listener = jest.fn()
  window.addEventListener("cognia:shared-request-ai", listener)
  render(<SharedSessionPanel session={shared} />)
  fireEvent.click(screen.getByRole("button", { name: "openSharedSession" }))
  fireEvent.click(await screen.findByRole("button", { name: "takeoverExecution" }))
  expect(listener.mock.calls[0][0].detail.takeover).toBe(true)
  window.removeEventListener("cognia:shared-request-ai", listener)
})

it("preserves editable controls while a background metadata refresh is pending", async () => {
  const client = configured()
  render(<SharedSessionPanel session={shared} />)
  fireEvent.click(screen.getByRole("button", { name: "openSharedSession" }))
  const input = await screen.findByLabelText("userId")
  fireEvent.change(input, { target: { value: "unfinished invite" } })
  let finish!: (value: unknown) => void
  client.getSharedSession.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await act(async () => {
    mockSyncObserver?.()
  })
  expect(input).toBeInTheDocument()
  expect(input).toHaveValue("unfinished invite")
  await act(async () => finish({ policyRevision: 1, revision: 1 }))
})
