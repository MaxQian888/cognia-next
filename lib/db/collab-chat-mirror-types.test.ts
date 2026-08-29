// Type-only module — no runtime code lives here. The side-effect import keeps
// the (empty) module body in the graph; the literals below document the row
// shapes the shared-chat pull writes and the chat surfaces read.
import "./collab-chat-mirror-types"
import type {
  CollabChatApprovalMirrorRow,
  CollabChatAttachmentMirrorRow,
  CollabChatEventMirrorRow,
  CollabChatMembershipMirrorRow,
  CollabChatSessionMirrorRow,
  CollabChatSyncStateRow,
} from "./collab-chat-mirror-types"

const ADA = "usr_aaaaaaaaaaaaaaaaaaaaaaaa"
const ORG = "org_acme00000000000000000"
const SESSION = "ses_0123456789abcdef"

function sessionRow(
  overrides: Partial<CollabChatSessionMirrorRow> = {}
): CollabChatSessionMirrorRow {
  return {
    id: SESSION,
    orgId: ORG,
    workspaceId: "proj-1",
    title: "Ship it",
    status: "active",
    createdBy: { kind: "human", id: ADA },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    revision: 3,
    policyRevision: 2,
    fetchedAt: 1_700_000_200_000,
    ...overrides,
  }
}

describe("CollabChatSessionMirrorRow", () => {
  it("adds only `fetchedAt` — the server row already carries the org", () => {
    // `SharedSession` is org-scoped at the source, so the mirror does not
    // re-state `orgId`; it only records when the cache was filled.
    const row = sessionRow()
    expect(row.orgId).toBe(ORG)
    expect(row.fetchedAt).toBeGreaterThanOrEqual(row.updatedAt)
  })

  it("keeps the server's own revisions rather than deriving local ones", () => {
    // Both revisions drive staleness checks against the plane; a locally
    // invented number could not be compared with the server's.
    expect(sessionRow({ revision: 9, policyRevision: 4 })).toMatchObject({
      revision: 9,
      policyRevision: 4,
    })
  })
})

describe("session-scoped mirror rows", () => {
  it("re-state the org, so an org-scoped read needs one row and no join", () => {
    // The server's membership/event/invite/approval/attachment rows are keyed
    // by session only. Every Dexie table here indexes `orgId` (schema v207), so
    // the mirror row has to carry it explicitly.
    const membership: CollabChatMembershipMirrorRow = {
      sessionId: SESSION,
      userId: ADA,
      role: "maintainer",
      approver: true,
      guest: false,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
      orgId: ORG,
      fetchedAt: 1_700_000_200_000,
    }
    const event: CollabChatEventMirrorRow = {
      id: "evt_1",
      sessionId: SESSION,
      sequence: 12,
      kind: "message.created",
      actor: { kind: "human", id: ADA },
      payload: { text: "hi" },
      createdAt: 1_700_000_000_000,
      operationId: "op_1",
      orgId: ORG,
      fetchedAt: 1_700_000_200_000,
    }
    const approval: CollabChatApprovalMirrorRow = {
      id: "apr_1",
      sessionId: SESSION,
      runId: "run_1",
      action: "bash",
      risk: "high",
      requestedByUserId: ADA,
      status: "pending",
      expiresAt: 1_700_000_900_000,
      createdAt: 1_700_000_000_000,
      revision: 1,
      orgId: ORG,
      fetchedAt: 1_700_000_200_000,
    }

    expect([membership.orgId, event.orgId, approval.orgId]).toEqual([ORG, ORG, ORG])
  })

  it("mirrors attachment metadata only — the bytes never land in Dexie", () => {
    const attachment: CollabChatAttachmentMirrorRow = {
      id: "att_1",
      sessionId: SESSION,
      fileName: "report.pdf",
      mediaType: "application/pdf",
      byteLength: 4096,
      sha256: "a".repeat(64),
      status: "available",
      createdByUserId: ADA,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
      orgId: ORG,
      fetchedAt: 1_700_000_200_000,
    }
    expect(attachment.sha256).toHaveLength(64)
    expect(Object.keys(attachment)).not.toContain("data")
  })
})

describe("CollabChatSyncStateRow", () => {
  it("is one row per session, holding the cursor the next pull resumes from", () => {
    const state: CollabChatSyncStateRow = {
      sessionId: SESSION,
      orgId: ORG,
      lastSequence: 12,
      policyRevision: 2,
      connected: true,
      updatedAt: 1_700_000_200_000,
    }
    expect(state.sessionId).toBe(SESSION)
    expect(state.lastSequence).toBe(12)
  })

  it("says why it is disconnected rather than only that it is", () => {
    // `lastError` is optional: absent while connected, set when the stream
    // dropped, so the UI can distinguish "idle" from "failed".
    const failed: CollabChatSyncStateRow = {
      sessionId: SESSION,
      orgId: ORG,
      lastSequence: 12,
      policyRevision: 2,
      connected: false,
      lastError: "unauthorized",
      updatedAt: 1_700_000_300_000,
    }
    expect(failed.connected).toBe(false)
    expect(failed.lastError).toBe("unauthorized")
  })
})
