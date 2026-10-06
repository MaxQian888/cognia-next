/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { AccountContentCipher, activateAccountContentCipher } from "@/lib/accounts/content-cipher"

import { computeSequenceDigest } from "@cognia/agent-config-types/canonical-session"
import {
  hostStateDigest,
  sessionIndexChannel,
  sessionStateChannel,
  type AllowedHostStateIntent,
  type HostStateAction,
} from "@cognia/agent-config-types/host-state"
import { activateAccountDatabase, __resetDbForTesting, getDb } from "@/lib/db/schema"
import { composeTurnText } from "@/lib/chat/prompt-preamble"
import {
  acquireHostStateLease,
  commitHostStateAction,
  commitHostStateRuntimeProjection,
  getHostStateAction,
  getHostStateSnapshot,
  renewHostStateLease,
  validateHostStateBusinessAction,
} from "./host-state-store"
import { SessionHandoffLockedError } from "@/lib/chat/session-write-guard"

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
    activateAccountContentCipher(
      await AccountContentCipher.createForTesting(scope.accountId, getDb().name)
    )
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

  it("preserves structured handoff content and pins media references on the host", async () => {
    await acquireWritableLease()
    const turns = [
      {
        turnId: "turn",
        role: "assistant" as const,
        text: "Result",
        reasoning: "Reason",
        parts: [
          {
            type: "file" as const,
            uri: "cognia-media:hash",
            name: "image.png",
            mediaType: "image/png",
          },
        ],
        toolCalls: [
          { callId: "call", toolName: "read", status: "completed" as const, resultText: "found" },
        ],
      },
    ]
    await getDb().threadHandoffTickets.put({
      ticketVersion: 1,
      ticketId: "imported-ticket",
      role: "target",
      state: "preparing",
      source: {
        hostRef: "source-host",
        kind: "desktop",
        sessionId: "source-session",
        title: "Thread",
        messageCount: 1,
      },
      target: { hostRef: "target", kind: "cloud", sessionId: "imported" },
      transport: "remote-host",
      project: {},
      requirements: {
        capabilities: [],
        hostOperations: [],
        providerRefs: [],
        models: [],
        credentialProfileRefs: [],
      },
      continuation: {
        sourceRuntime: "cognia",
        fidelity: "contextual",
        sequenceDigest: computeSequenceDigest(turns),
      },
      attachments: [],
      pendingApprovals: [],
      history: [{ state: "preparing", at: 1 }],
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 1000,
    })
    await commitHostStateAction({
      action: draftAction({
        actionId: "thread-handoff:imported-ticket:import",
        channel: sessionStateChannel(scope.targetId, "imported"),
        sessionId: "imported",
        action: {
          kind: "session.import",
          envelope: {
            header: {
              canonicalVersion: 1,
              canonicalSessionId: "canonical",
              sourceRuntime: "cognia",
              importFidelity: "structured",
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
              turnCount: 1,
              sequenceDigest: computeSequenceDigest(turns),
            },
            turns,
          },
        },
      }),
      now: 1,
    })
    const message = await getDb().messages.get("imported:turn")
    expect(message?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reasoning", text: "Reason" }),
        expect.objectContaining({ type: "file", url: "cognia-media:hash" }),
        expect.objectContaining({ toolCallId: "call", output: "found" }),
      ])
    )
    expect(await getDb().messageMediaRefs.get(["imported:turn", "hash"])).toMatchObject({
      sessionId: "imported",
    })
    expect((await getDb().sessions.get("imported"))?.handoffLock).toMatchObject({
      state: "frozen",
      ticketId: "imported-ticket",
    })
    expect((await getDb().sessions.get("imported"))?.sdkSessionId).toBeUndefined()
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

  it("refreshes restarted projections from session rows while retaining live channel state", async () => {
    await acquireWritableLease()
    await commitHostStateAction({
      action: draftAction(),
      mutation: {
        kind: "draft.replaced",
        text: "saved draft",
        attachments: [],
        draftRevision: 1,
        revision: 1,
      },
      now: 1,
    })
    await commitHostStateRuntimeProjection({
      hostId: scope.hostId,
      hostGeneration: 1,
      ownerId: "brain-a",
      channel,
      envelopeId: "running",
      envelopeDigest: "running",
      mutation: () => ({ kind: "turn.started", turnId: "turn-1", startedAt: 2, revision: 2 }),
      now: 2,
    })
    const before = await getHostStateSnapshot(channel)
    const indexChannel = sessionIndexChannel(scope.targetId)
    await getHostStateSnapshot(indexChannel)
    await getDb().sessions.update("session-1", {
      title: "Account sync title",
      archivedAt: 3,
      transcriptRevision: 7,
      updatedAt: 3,
    })
    await getDb().sessions.put({
      id: "synced-session",
      title: "New synced session",
      transcriptRevision: 4,
      createdAt: 3,
      updatedAt: 3,
    })

    // A lease renewal must not silently rewrite the current ordered stream.
    await acquireHostStateLease({ hostId: scope.hostId, ownerId: "brain-a", now: 10 })
    expect((await getHostStateSnapshot(channel)).state).toEqual(before.state)
    await acquireHostStateLease({ hostId: scope.hostId, ownerId: "brain-b", now: 31_000 })

    const refreshed = await getHostStateSnapshot(channel)
    expect(refreshed).toMatchObject({
      hostGeneration: 2,
      cutHostSeq: 0,
      revision: before.revision,
      state: {
        ...before.state,
        title: "Account sync title",
        conversation: "archived",
        transcriptRevision: 7,
      },
    })
    expect(refreshed.digest).toBe(hostStateDigest(refreshed.state))
    expect((await getHostStateSnapshot(indexChannel)).state).toMatchObject({
      sessions: expect.arrayContaining([
        {
          sessionId: "session-1",
          title: "Account sync title",
          conversation: "archived",
          turn: "running",
          revision: 2,
          transcriptRevision: 7,
        },
        {
          sessionId: "synced-session",
          title: "New synced session",
          conversation: "present",
          turn: "idle",
          revision: 0,
          transcriptRevision: 4,
        },
      ]),
    })
  })

  it("tombstones sessions removed while the host was stopped instead of restoring them from its index", async () => {
    await acquireWritableLease()
    await getHostStateSnapshot(channel)
    const indexChannel = sessionIndexChannel(scope.targetId)
    await getHostStateSnapshot(indexChannel)
    await getDb().sessions.delete("session-1")
    await acquireHostStateLease({ hostId: scope.hostId, ownerId: "brain-b", now: 31_000 })
    const deleted = await getHostStateSnapshot(channel)
    expect(deleted.state).toMatchObject({
      conversation: "tombstoned",
      tombstone: { deletedAt: 31_000, hostSeq: 0 },
    })
    expect((await getHostStateSnapshot(indexChannel)).state).toMatchObject({
      sessions: [
        expect.objectContaining({
          sessionId: "session-1",
          conversation: "tombstoned",
          tombstone: { deletedAt: 31_000, hostSeq: 0 },
        }),
      ],
    })
    expect(deleted.digest).toBe(hostStateDigest(deleted.state))
    expect(await getDb().sessions.get("session-1")).toBeUndefined()

    // A stale replicated row must not undo an already durable deletion.
    await getDb().sessions.put({
      id: "session-1",
      title: "Stale sync copy",
      transcriptRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    await acquireHostStateLease({ hostId: scope.hostId, ownerId: "brain-c", now: 62_000 })
    expect((await getHostStateSnapshot(channel)).state).toEqual(deleted.state)
    expect((await getHostStateSnapshot(indexChannel)).state).toMatchObject({
      sessions: [expect.objectContaining({ conversation: "tombstoned" })],
    })
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

  // The kept tail's last row becomes the list preview. A user turn that carried
  // references persists the composer's context envelope in its text; the
  // preview is what the user typed, not the envelope.
  it("previews what the user typed after truncating back to a turn with references", async () => {
    await acquireWritableLease()
    const { text } = composeTurnText("compare these", [{ kind: "references", text: "SNAPSHOT" }], {
      nonce: "abcdef1234",
    })
    await getDb().messages.bulkPut([
      {
        id: "m-user",
        sessionId: "session-1",
        role: "user",
        parts: [{ type: "text", text }],
        createdAt: 5,
      },
      {
        id: "m-assistant",
        sessionId: "session-1",
        role: "assistant",
        parts: [{ type: "text", text: "answer" }],
        createdAt: 6,
      },
    ] as never)
    await commitHostStateAction({
      action: draftAction({
        actionId: "truncate-action",
        action: { kind: "transcript.truncate", afterMessageId: "m-user" },
      }),
      mutation: { kind: "transcript.revised", transcriptRevision: 1, revision: 1 },
      now: 10,
    })
    await expect(getDb().messages.get("m-assistant")).resolves.toBeUndefined()
    const session = await getDb().sessions.get("session-1")
    expect(session?.lastMessagePreview).toBe("compare these")
    expect(session?.lastMessagePreview).not.toContain("SNAPSHOT")
  })

  it("applies pin, filing and rank to the sessions row with no channel mutation", async () => {
    await acquireWritableLease()
    await getDb().sessions.update("session-1", { folderId: "f-old" })

    const pin = await commitHostStateAction({
      action: draftAction({
        baseRevision: undefined,
        action: { kind: "session.pin", pinned: true },
      }),
      now: 500,
    })
    await commitHostStateAction({
      action: draftAction({
        actionId: "action-2",
        clientSeq: 2,
        baseRevision: undefined,
        action: { kind: "session.order", manualOrder: 4, sectionKey: "pinned" },
      }),
      now: 600,
    })

    // Applied, but nothing the channel carries changed — replicas learn the
    // row through `sessions` table sync, which keys on `updatedAt`.
    expect(pin.event).toMatchObject({ outcome: "applied", hostSeq: 1 })
    expect(pin.event.mutation).toBeUndefined()
    await expect(getHostStateSnapshot(channel)).resolves.toMatchObject({ state: { revision: 0 } })
    await expect(getHostStateAction(1, "action-1")).resolves.toMatchObject({
      summaryState: "not-required",
      dispatchState: "not-required",
    })
    expect(await getDb().sessions.get("session-1")).toMatchObject({
      pinned: true,
      manualOrder: 4,
      manualOrderSection: "pinned",
      folderId: "f-old",
      updatedAt: 600,
      // Display recency is pinned to what it was, not to the write.
      lastMessageAt: 1,
    })

    await commitHostStateAction({
      action: draftAction({
        actionId: "action-3",
        clientSeq: 3,
        baseRevision: undefined,
        action: { kind: "session.folder", folderId: null },
      }),
      now: 700,
    })
    const unfiled = await getDb().sessions.get("session-1")
    expect(unfiled).not.toHaveProperty("folderId")
    expect(unfiled?.updatedAt).toBe(700)

    await commitHostStateAction({
      action: draftAction({
        actionId: "action-4",
        clientSeq: 4,
        baseRevision: undefined,
        action: { kind: "session.folder", folderId: "f-new" },
      }),
      now: 800,
    })
    expect((await getDb().sessions.get("session-1"))?.folderId).toBe("f-new")
  })

  it("refuses organize and delete intents on a handoff-locked session", async () => {
    await getDb().sessions.update("session-1", {
      handoffLock: { ticketId: "ticket-1", state: "frozen", at: 1 },
    })
    for (const intent of [
      { kind: "session.rename", title: "Renamed" },
      { kind: "session.archive", archived: true },
      { kind: "session.pin", pinned: true },
      { kind: "session.folder", folderId: "f1" },
      { kind: "session.order", manualOrder: 0, sectionKey: "recent" },
      { kind: "session.delete" },
    ] as const) {
      await expect(
        validateHostStateBusinessAction(draftAction({ baseRevision: undefined, action: intent }))
      ).resolves.toEqual({
        code: "session_handoff_locked",
        message: "The session is read-only during a handoff.",
      })
    }
    await expect(
      validateHostStateBusinessAction(
        draftAction({ sessionId: "missing", action: { kind: "session.delete" } })
      )
    ).resolves.toMatchObject({ code: "session_not_found" })
  })

  it("rolls a rename or archive back when a lock lands between validation and commit", async () => {
    await acquireWritableLease()
    await getDb().sessions.update("session-1", {
      handoffLock: { ticketId: "ticket-1", state: "frozen", at: 1 },
    })
    await expect(
      commitHostStateAction({
        action: draftAction({ action: { kind: "session.rename", title: "Renamed" } }),
        mutation: { kind: "session.renamed", title: "Renamed", revision: 1 },
        now: 10,
      })
    ).rejects.toBeInstanceOf(SessionHandoffLockedError)
    await expect(
      commitHostStateAction({
        action: draftAction({
          actionId: "action-2",
          clientSeq: 2,
          action: { kind: "session.archive", archived: true },
        }),
        mutation: { kind: "conversation.changed", conversation: "archived", revision: 1 },
        now: 11,
      })
    ).rejects.toBeInstanceOf(SessionHandoffLockedError)
    await expect(getDb().hostStateActions.count()).resolves.toBe(0)
    expect(await getDb().sessions.get("session-1")).toMatchObject({ title: "Session" })
    expect((await getDb().sessions.get("session-1"))?.archivedAt).toBeUndefined()
    await expect(getHostStateSnapshot(channel)).resolves.toMatchObject({
      state: { revision: 0, conversation: "present" },
    })
  })

  it("rolls the ledger back when a lock lands between validation and commit", async () => {
    await acquireWritableLease()
    await getDb().sessions.update("session-1", {
      handoffLock: { ticketId: "ticket-1", state: "frozen", at: 1 },
    })
    await expect(
      commitHostStateAction({
        action: draftAction({
          baseRevision: undefined,
          action: { kind: "session.pin", pinned: true },
        }),
        now: 10,
      })
    ).rejects.toBeInstanceOf(SessionHandoffLockedError)
    await expect(getDb().hostStateActions.count()).resolves.toBe(0)
    expect((await getDb().sessions.get("session-1"))?.pinned).toBeUndefined()
  })

  it("records a delete's tombstone at the ledger position it was committed at", async () => {
    await acquireWritableLease()
    // An earlier action moves the ledger, so a snapshot-derived position would
    // be stale by the time the delete commits.
    await commitHostStateAction({
      action: draftAction(),
      mutation: {
        kind: "draft.replaced",
        text: "x",
        attachments: [],
        draftRevision: 1,
        revision: 1,
      },
      now: 5,
    })
    // The cascade has already run by the time the ledger commits.
    await getDb().sessions.delete("session-1")

    const deleted = await commitHostStateAction({
      action: draftAction({
        actionId: "delete-1",
        clientSeq: 2,
        baseRevision: undefined,
        action: { kind: "session.delete" },
      }),
      mutation: { kind: "session.tombstoned", deletedAt: 9, hostSeq: 0, revision: 2 },
      now: 9,
    })

    expect(deleted.event).toMatchObject({
      outcome: "applied",
      hostSeq: 2,
      mutation: { kind: "session.tombstoned", deletedAt: 9, hostSeq: 2, revision: 2 },
    })
    await expect(getHostStateSnapshot(channel)).resolves.toMatchObject({
      state: { conversation: "tombstoned", tombstone: { deletedAt: 9, hostSeq: 2 } },
    })
    await expect(getHostStateAction(1, "delete-1")).resolves.toMatchObject({
      summaryState: "pending",
    })
  })

  describe("folder intents", () => {
    const indexChannel = sessionIndexChannel(scope.targetId)
    const folderAction = (
      intent: AllowedHostStateIntent,
      overrides: Partial<HostStateAction> = {}
    ): HostStateAction =>
      draftAction({
        channel: indexChannel,
        sessionId: undefined,
        baseRevision: undefined,
        action: intent,
        ...overrides,
      })

    it("creates, renames, reorders and deletes on the index channel with no mutation", async () => {
      await acquireWritableLease()
      const created = await commitHostStateAction({
        action: folderAction({
          kind: "folder.create",
          folderId: "f1",
          projectId: "p1",
          name: " Work ",
        }),
        now: 10,
      })
      await commitHostStateAction({
        action: folderAction(
          { kind: "folder.create", folderId: "f2", projectId: "p1", name: "Home" },
          { actionId: "a2", clientSeq: 2 }
        ),
        now: 11,
      })
      await commitHostStateAction({
        action: folderAction(
          { kind: "folder.rename", folderId: "f1", name: "Office" },
          { actionId: "a3", clientSeq: 3 }
        ),
        now: 12,
      })
      await commitHostStateAction({
        action: folderAction(
          { kind: "folder.reorder", projectId: "p1", orderedIds: ["f2", "f1"] },
          { actionId: "a4", clientSeq: 4 }
        ),
        now: 13,
      })

      expect(created.event).toMatchObject({ channel: indexChannel, outcome: "applied" })
      expect(created.event.mutation).toBeUndefined()
      // The index summary is not re-projected for a folder: nothing it carries moved.
      await expect(getHostStateAction(1, "action-1")).resolves.toMatchObject({
        summaryState: "not-required",
      })
      expect(await getDb().sessionFolders.get("f1")).toMatchObject({
        name: "Office",
        projectId: "p1",
        order: 1,
        updatedAt: 13,
      })
      expect(await getDb().sessionFolders.get("f2")).toMatchObject({ order: 0 })

      await getDb().sessions.update("session-1", { folderId: "f1" })
      await commitHostStateAction({
        action: folderAction(
          { kind: "folder.delete", folderId: "f1" },
          { actionId: "a5", clientSeq: 5 }
        ),
        now: 20,
      })
      expect(await getDb().sessionFolders.get("f1")).toBeUndefined()
      const member = await getDb().sessions.get("session-1")
      expect(member).not.toHaveProperty("folderId")
      // Unfiled as a sync-visible write, without moving the row.
      expect(member).toMatchObject({ updatedAt: 20, lastMessageAt: 1 })
      expect(
        await getDb()
          .syncTombstones.filter((row) => row.table === "sessionFolders")
          .toArray()
      ).toEqual([expect.objectContaining({ id: "f1", deletedAt: 20 })])
    })

    it("validates what each folder intent needs, and refuses one that names a session", async () => {
      await getDb().sessionFolders.put({
        id: "f1",
        projectId: "p1",
        name: "Work",
        order: 0,
        createdAt: 1,
        updatedAt: 1,
      })
      await expect(
        validateHostStateBusinessAction(
          folderAction({ kind: "folder.create", folderId: "f1", projectId: "p1", name: "Again" })
        )
      ).resolves.toMatchObject({ code: "host_state_folder_exists" })
      await expect(
        validateHostStateBusinessAction(
          folderAction({ kind: "folder.rename", folderId: "gone", name: "x" })
        )
      ).resolves.toMatchObject({ code: "host_state_folder_not_found" })
      await expect(
        validateHostStateBusinessAction(folderAction({ kind: "folder.delete", folderId: "gone" }))
      ).resolves.toMatchObject({ code: "host_state_folder_not_found" })
      await expect(
        validateHostStateBusinessAction(
          folderAction({ kind: "folder.reorder", projectId: "p1", orderedIds: ["unknown"] })
        )
      ).resolves.toBeUndefined()
      await expect(
        validateHostStateBusinessAction(
          folderAction(
            { kind: "folder.rename", folderId: "f1", name: "x" },
            { sessionId: "session-1" }
          )
        )
      ).resolves.toMatchObject({ code: "host_state_session_id_forbidden" })

      // A member frozen for a handoff refuses the unfile, so the delete is refused.
      await getDb().sessions.update("session-1", {
        folderId: "f1",
        handoffLock: { ticketId: "ticket-1", state: "frozen", at: 1 },
      })
      await expect(
        validateHostStateBusinessAction(folderAction({ kind: "folder.delete", folderId: "f1" }))
      ).resolves.toMatchObject({ code: "session_handoff_locked" })
    })

    it("rolls the ledger back when a member is locked between validation and commit", async () => {
      await acquireWritableLease()
      await getDb().sessionFolders.put({
        id: "f1",
        projectId: "p1",
        name: "Work",
        order: 0,
        createdAt: 1,
        updatedAt: 1,
      })
      await getDb().sessions.update("session-1", {
        folderId: "f1",
        handoffLock: { ticketId: "ticket-1", state: "frozen", at: 1 },
      })
      await expect(
        commitHostStateAction({
          action: folderAction({ kind: "folder.delete", folderId: "f1" }),
          now: 5,
        })
      ).rejects.toBeInstanceOf(SessionHandoffLockedError)
      await expect(getDb().hostStateActions.count()).resolves.toBe(0)
      expect(await getDb().sessionFolders.get("f1")).toBeDefined()
    })
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

describe("HostState draft replacement and template bindings", () => {
  beforeEach(async () => {
    activateAccountDatabase(scope.accountId, scope.targetId)
    await getDb().delete()
    __resetDbForTesting()
    activateAccountDatabase(scope.accountId, scope.targetId)
    activateAccountContentCipher(
      await AccountContentCipher.createForTesting(scope.accountId, getDb().name)
    )
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

  it("keeps this device's parameter values when a remote draft edit lands", async () => {
    // `draft.replace` carries text and attachments only, and the handler writes
    // with `put`, which replaces the whole row. Without an explicit carry-over
    // an incoming edit silently empties a half-filled template — the values are
    // not in the text and nothing else holds them.
    const templateBinding = {
      templateId: "user.chat.review",
      version: "1.0.0",
      params: { module: { kind: "text" as const, value: "login" } },
      insertedAt: 1,
    }
    await getDb().chatDrafts.put({
      sessionId: "session-1",
      text: "review {{module}}",
      updatedAt: 1,
      templateBinding,
    })

    await acquireWritableLease()
    const result = await commitHostStateAction({
      action: draftAction({
        action: { kind: "draft.replace", text: "review {{module}} today", attachments: [] },
      }),
      mutation: {
        kind: "draft.replaced",
        text: "review {{module}} today",
        attachments: [],
        draftRevision: 1,
        revision: 1,
      },
      now: 1,
    })

    expect(result.event.outcome).toBe("applied")
    expect(result.snapshot.state).toMatchObject({
      title: "Session",
      draft: { text: "review {{module}} today", revision: 1 },
    })

    await expect(getDb().chatDrafts.get("session-1")).resolves.toMatchObject({
      text: "review {{module}} today",
      templateBinding,
    })
  })
})
