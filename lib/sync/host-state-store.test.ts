/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { sessionStateChannel, type HostStateAction } from "@cognia/agent-config-types/host-state"
import { activateAccountDatabase, __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  acquireHostStateLease,
  commitHostStateAction,
  getHostStateSnapshot,
  renewHostStateLease,
} from "./host-state-store"

const scope = { accountId: "acct-host-state", targetId: "desktop-a", hostId: "host-opaque-a" }
const channel = sessionStateChannel(scope.targetId, "session-1")

function draftAction(overrides: Partial<HostStateAction> = {}): HostStateAction {
  return {
    channel,
    accountId: scope.accountId,
    runtimeTargetId: scope.targetId,
    hostId: scope.hostId,
    hostGeneration: 1,
    sessionId: "session-1",
    clientId: "client-a",
    clientSeq: 1,
    actionId: "action-1",
    baseRevision: 0,
    createdAt: 100,
    action: { kind: "draft.replace", text: "hello", attachments: [] },
    ...overrides,
  }
}

async function acquireWritableLease(): Promise<Awaited<ReturnType<typeof acquireHostStateLease>>> {
  const lease = await acquireHostStateLease({ hostId: scope.hostId, ownerId: "brain-a", now: 0 })
  return lease
}

describe("HostState durable store", () => {
  beforeEach(async () => {
    activateAccountDatabase(scope.accountId, scope.targetId)
    await getDb().delete()
    __resetDbForTesting()
    activateAccountDatabase(scope.accountId, scope.targetId)
    await getDb().sessions.put({
      id: "session-1",
      title: "Session",
      transcriptRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    })
  }, 30_000)

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("commits state and the semantic receipt in one ordered transaction", async () => {
    await expect(acquireWritableLease()).resolves.toMatchObject({ hostGeneration: 1, hostSeq: 0 })

    const first = await commitHostStateAction({
      action: draftAction(),
      mutation: {
        kind: "draft.replaced",
        text: "hello",
        attachments: [],
        draftRevision: 1,
        revision: 1,
      },
      now: 101,
    })
    const duplicate = await commitHostStateAction({
      action: draftAction(),
      mutation: {
        kind: "draft.replaced",
        text: "ignored duplicate",
        attachments: [],
        draftRevision: 2,
        revision: 2,
      },
      now: 102,
    })

    expect(first.event).toMatchObject({ outcome: "applied", hostSeq: 1 })
    expect(duplicate).toEqual({ ...first, duplicate: true })
    await expect(getHostStateSnapshot(channel)).resolves.toMatchObject({
      cutHostSeq: 1,
      hostGeneration: 1,
      state: { revision: 1, draft: { text: "hello", revision: 1 } },
    })
    await expect(getDb().hostStateActions.count()).resolves.toBe(1)
  })

  it("persists a visible conflict without changing confirmed state", async () => {
    await acquireWritableLease()
    await commitHostStateAction({
      action: draftAction(),
      mutation: {
        kind: "draft.replaced",
        text: "hello",
        attachments: [],
        draftRevision: 1,
        revision: 1,
      },
      now: 1,
    })

    const conflict = await commitHostStateAction({
      action: draftAction({ actionId: "action-2", clientSeq: 2, baseRevision: 0 }),
      mutation: {
        kind: "draft.replaced",
        text: "stale",
        attachments: [],
        draftRevision: 2,
        revision: 2,
      },
      now: 2,
    })

    expect(conflict.event).toMatchObject({
      outcome: "conflicted",
      hostSeq: 2,
      rejection: { code: "host_state_revision_conflict", currentRevision: 1 },
    })
    await expect(getHostStateSnapshot(channel)).resolves.toMatchObject({
      cutHostSeq: 2,
      state: { revision: 1, draft: { text: "hello" } },
    })
  })

  it("fences a second brain until lease expiry and rejects stale generations", async () => {
    await acquireWritableLease()
    await expect(
      acquireHostStateLease({ hostId: scope.hostId, ownerId: "brain-b", now: 20_000 })
    ).rejects.toThrow("host_state_lease_held")
    await renewHostStateLease({ ownerId: "brain-a", hostGeneration: 1, now: 20_000 })

    const next = await acquireHostStateLease({
      hostId: scope.hostId,
      ownerId: "brain-b",
      now: 51_000,
    })
    expect(next).toMatchObject({ hostGeneration: 2, hostSeq: 0 })
    await expect(
      commitHostStateAction({
        action: draftAction(),
        mutation: {
          kind: "draft.replaced",
          text: "stale host",
          attachments: [],
          draftRevision: 1,
          revision: 1,
        },
        now: 51_001,
      })
    ).rejects.toThrow("stale_host_generation")
  })

  it("persists queued messages and transcript edits in the ledger transaction", async () => {
    await getDb().sessions.update("session-1", { title: "New conversation", titleAuto: true })
    await acquireWritableLease()
    const messageAction = draftAction({
      actionId: "message-action",
      baseRevision: undefined,
      action: {
        kind: "message.enqueue",
        messageId: "message-1",
        text: "original",
        attachments: [],
      },
    })
    await commitHostStateAction({
      action: messageAction,
      mutation: {
        kind: "message.queued",
        message: {
          actionId: "message-action",
          messageId: "message-1",
          text: "original",
          attachments: [],
          clientId: "client-a",
        },
        operation: {
          actionId: "message-action",
          kind: "message.enqueue",
          status: "accepted",
          clientId: "client-a",
          createdAt: 10,
          updatedAt: 10,
        },
        draftRevision: 1,
        revision: 1,
      },
      now: 10,
    })
    expect(await getDb().messages.get("message-1")).toMatchObject({
      sessionId: "session-1",
      role: "user",
      parts: [{ type: "text", text: "original" }],
    })
    await expect(getDb().sessions.get("session-1")).resolves.toMatchObject({
      title: "original",
      titleAuto: true,
      // Queueing writes the message row but does NOT advance the transcript
      // revision — the key clients reconcile on. A send whose dispatch later
      // fails must not have invited every replica to refetch.
      transcriptRevision: 0,
      lastMessagePreview: "original",
    })

    await commitHostStateAction({
      action: draftAction({
        actionId: "edit-action",
        clientSeq: 2,
        baseRevision: 1,
        action: { kind: "transcript.edit", messageId: "message-1", text: "edited" },
      }),
      mutation: { kind: "transcript.revised", transcriptRevision: 2, revision: 2 },
      now: 11,
    })
    await expect(getDb().messages.get("message-1")).resolves.toMatchObject({
      parts: [{ type: "text", text: "edited" }],
    })
  })

  /**
   * The mutation is broadcast verbatim to every replica, so a malformed one
   * poisons all of them at once. Before this check a missing field surfaced
   * only as a canonical-JSON failure from deep inside the write transaction.
   */
  it("refuses a malformed mutation before it can reach the ledger", async () => {
    await acquireWritableLease()
    await expect(
      commitHostStateAction({
        action: draftAction({ actionId: "bad-mutation" }),
        // A `message.queued` with no operation: type-correct at a glance, and
        // unserializable once the reducer appends `undefined` to the list.
        mutation: {
          kind: "message.queued",
          message: {
            actionId: "bad-mutation",
            messageId: "m",
            text: "t",
            attachments: [],
            clientId: "client-a",
          },
          draftRevision: 1,
          revision: 1,
        } as never,
        now: 10,
      })
    ).rejects.toThrow("host_state_invalid_mutation")
    await expect(getDb().hostStateActions.count()).resolves.toBe(0)
    await expect(getDb().hostStateChannels.count()).resolves.toBe(0)
  })

  it("rolls back the ledger when a transcript target is missing", async () => {
    await acquireWritableLease()
    await expect(
      commitHostStateAction({
        action: draftAction({
          actionId: "missing-edit",
          action: { kind: "transcript.edit", messageId: "missing", text: "edited" },
        }),
        mutation: { kind: "transcript.revised", transcriptRevision: 1, revision: 1 },
        now: 10,
      })
    ).rejects.toThrow("host_state_message_not_found")
    await expect(getDb().hostStateActions.count()).resolves.toBe(0)
  })

  it("commits a client action on the strength of the lease alone", async () => {
    // This used to assert the opposite. A six-stage `migrationStage` ladder sat
    // in front of every write and nothing in production ever advanced it past
    // `legacy-authoritative`, so HostState could never accept an action at all.
    // The lease plus the host generation is the real ownership test.
    await acquireHostStateLease({ hostId: scope.hostId, ownerId: "brain-a", now: 0 })

    await commitHostStateAction({
      action: draftAction(),
      mutation: {
        kind: "draft.replaced",
        text: "commits",
        attachments: [],
        draftRevision: 1,
        revision: 1,
      },
      now: 1,
    })
    await expect(getDb().hostStateActions.count()).resolves.toBe(1)
  })
})
