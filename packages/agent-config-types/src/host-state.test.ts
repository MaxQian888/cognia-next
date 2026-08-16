import {
  HOST_STATE_PROTOCOL_VERSION,
  HOST_STATE_SESSION_CHANNEL_PREFIX,
  canonicalHostStateJson,
  createEmptyHostStateSession,
  hostStateDigest,
  hostStateMigrationStageAllowsWrites,
  isHostStateActionV1,
  isHostStateAppliedActionV1,
  isHostStateSnapshotV1,
  isHostStateStatusV1,
  isHostStateSubmitResponseV1,
  reconcileHostStateReplica,
  reduceHostStateIntent,
  reduceHostStateMutation,
  sessionIndexChannel,
  sessionStateChannel,
  type AllowedHostStateIntentV1,
  type HostStateActionV1,
  type HostStateAppliedActionV1,
  type HostStateAttachmentRefV1,
  type HostStateMutationV1,
  type HostStateQueuedMessageV1,
  type HostStateSessionChannelV1,
  type HostStateSessionIndexChannelV1,
  type HostStateSessionSummaryV1,
} from "./host-state"

const CHANNEL = "cognia://target/host-a/sessions/session-1"

const action = (overrides: Partial<HostStateActionV1> = {}): HostStateActionV1 => ({
  protocolVersion: HOST_STATE_PROTOCOL_VERSION,
  channel: CHANNEL,
  accountId: "account-1",
  runtimeTargetId: "host-a",
  hostId: "host-a",
  hostGeneration: 3,
  sessionId: "session-1",
  clientId: "client-a",
  clientSeq: 7,
  actionId: "action-7",
  baseRevision: 0,
  createdAt: 1_700_000_000_000,
  action: { kind: "draft.replace", text: "hello", attachments: [] },
  ...overrides,
})

const applied = (overrides: Partial<HostStateAppliedActionV1> = {}): HostStateAppliedActionV1 => ({
  protocolVersion: HOST_STATE_PROTOCOL_VERSION,
  channel: CHANNEL,
  hostId: "host-a",
  hostGeneration: 3,
  hostSeq: 1,
  outcome: "applied",
  ...overrides,
})

const attachment = (
  overrides: Partial<HostStateAttachmentRefV1> = {}
): HostStateAttachmentRefV1 => ({
  name: "notes.png",
  mediaType: "image/png",
  size: 2048,
  hash: "sha256-abc",
  ...overrides,
})

const queued = (overrides: Partial<HostStateQueuedMessageV1> = {}): HostStateQueuedMessageV1 => ({
  actionId: "action-1",
  messageId: "message-1",
  text: "hello",
  attachments: [],
  clientId: "client-a",
  ...overrides,
})

const summary = (
  overrides: Partial<HostStateSessionSummaryV1> = {}
): HostStateSessionSummaryV1 => ({
  sessionId: "session-1",
  status: "idle",
  revision: 1,
  transcriptRevision: 0,
  archived: false,
  ...overrides,
})

const indexState = (
  sessions: HostStateSessionSummaryV1[] = []
): HostStateSessionIndexChannelV1 => ({
  kind: "session-index",
  channel: sessionIndexChannel("host-a"),
  revision: 0,
  sessions,
})

/** A session state with every optional field populated — exercises the full guard chain. */
const fullSession = (): HostStateSessionChannelV1 => ({
  ...createEmptyHostStateSession(CHANNEL, "session-1"),
  revision: 9,
  transcriptRevision: 4,
  status: "awaiting_approval",
  title: "Full session",
  archived: true,
  draft: {
    text: "draft",
    attachments: [attachment(), attachment({ hash: undefined })],
    revision: 3,
  },
  queue: [queued(), queued({ actionId: "action-2", attachments: [attachment()] })],
  activeTurn: { turnId: "turn-1", startedAt: 1_700_000_000_000 },
  pendingApprovals: [{ requestId: "req-1", label: "write file" }, { requestId: "req-2" }],
  pendingElicitations: [{ requestId: "eli-1" }],
  tombstone: { deletedAt: 1_700_000_000_001, hostSeq: 12 },
})

describe("HostStateProtocolV1", () => {
  it("accepts the closed v1 action shape and rejects unknown wire fields", () => {
    expect(isHostStateActionV1(action())).toBe(true)
    expect(isHostStateActionV1({ ...action(), secret: "must-not-pass" })).toBe(false)
    expect(
      isHostStateActionV1({
        ...action(),
        action: { kind: "draft.replace", text: "hello", attachments: [], token: "nope" },
      })
    ).toBe(false)
  })

  it("fails closed for every Host-to-client wire envelope", () => {
    const state = createEmptyHostStateSession(action().channel, "session-1")
    const event: HostStateAppliedActionV1 = {
      protocolVersion: 1,
      channel: state.channel,
      hostId: "host-a",
      hostGeneration: 3,
      hostSeq: 1,
      outcome: "applied",
      mutation: { kind: "session.status-changed", status: "running", revision: 1 },
    }
    expect(isHostStateAppliedActionV1(event)).toBe(true)
    expect(isHostStateAppliedActionV1({ ...event, credential: "nope" })).toBe(false)
    expect(
      isHostStateSnapshotV1({
        protocolVersion: 1,
        channel: state.channel,
        hostId: "host-a",
        hostGeneration: 3,
        cutHostSeq: 0,
        revision: 0,
        digest: hostStateDigest(state),
        state,
      })
    ).toBe(true)
    expect(
      isHostStateSubmitResponseV1({
        protocolVersion: 1,
        results: [
          { actionId: "a", outcome: "applied", hostGeneration: 3, hostSeq: 1, extra: true },
        ],
      })
    ).toBe(false)
    expect(
      isHostStateStatusV1({
        protocolVersion: 1,
        hostId: "host-a",
        hostGeneration: 3,
        hostSeq: 1,
        migrationStage: "shadow",
        leaseExpiresAt: 10,
        pendingDispatch: 0,
        pendingBroadcast: 0,
      })
    ).toBe(true)
  })

  it("produces the same canonical digest regardless of object insertion order", () => {
    const state = reduceHostStateMutation(
      createEmptyHostStateSession(action().channel, "session-1"),
      {
        kind: "draft.replaced",
        text: "hello",
        attachments: [],
        draftRevision: 1,
        revision: 1,
      }
    )
    const reordered = {
      transcriptRevision: state.transcriptRevision,
      revision: state.revision,
      status: state.status,
      archived: state.archived,
      sessionId: state.sessionId,
      channel: state.channel,
      kind: state.kind,
      pendingElicitations: state.pendingElicitations,
      pendingApprovals: state.pendingApprovals,
      activeTurn: state.activeTurn,
      queue: state.queue,
      draft: state.draft,
    }

    expect(canonicalHostStateJson(reordered)).toBe(canonicalHostStateJson(state))
    expect(hostStateDigest(reordered)).toBe(hostStateDigest(state))
    expect(hostStateDigest(state)).toMatch(/^hsv1-[0-9a-f]{16}$/)
  })

  it("removes an echoed action from the outbox and rebases remaining optimistic intents", () => {
    const channel = action().channel
    const initial = createEmptyHostStateSession(channel, "session-1")
    const first = action()
    const second = action({
      clientSeq: 8,
      actionId: "action-8",
      baseRevision: 1,
      action: { kind: "draft.replace", text: "world", attachments: [] },
    })
    const applied: HostStateAppliedActionV1 = {
      protocolVersion: 1,
      channel,
      hostId: "host-a",
      hostGeneration: 3,
      hostSeq: 11,
      origin: { clientId: "client-a", clientSeq: 7, actionId: "action-7" },
      outcome: "applied",
      mutation: {
        kind: "draft.replaced",
        text: "hello",
        attachments: [],
        draftRevision: 1,
        revision: 1,
      },
    }

    const reconciled = reconcileHostStateReplica(
      { confirmed: initial, pending: [first, second], hostGeneration: 3, hostSeq: 10 },
      applied
    )

    expect(reconciled.pending.map((item) => item.actionId)).toEqual(["action-8"])
    expect(reconciled.confirmed.draft.text).toBe("hello")
    expect(reconciled.optimistic.draft.text).toBe("world")
    expect(reconciled.hostSeq).toBe(11)
  })

  it("rejects gaps and stale host generations instead of guessing an order", () => {
    const replica = {
      confirmed: createEmptyHostStateSession(action().channel, "session-1"),
      pending: [] as HostStateActionV1[],
      hostGeneration: 3,
      hostSeq: 4,
    }
    const event: HostStateAppliedActionV1 = {
      protocolVersion: 1,
      channel: action().channel,
      hostId: "host-a",
      hostGeneration: 3,
      hostSeq: 6,
      outcome: "applied",
      mutation: { kind: "session.status-changed", status: "running", revision: 1 },
    }

    expect(() => reconcileHostStateReplica(replica, event)).toThrow("host_state_sequence_gap")
    expect(() =>
      reconcileHostStateReplica(replica, { ...event, hostGeneration: 2, hostSeq: 5 })
    ).toThrow("stale_host_generation")
  })

  it("resyncs on a newer host generation and refuses a foreign channel", () => {
    const replica = {
      confirmed: createEmptyHostStateSession(CHANNEL, "session-1"),
      pending: [] as HostStateActionV1[],
      hostGeneration: 3,
      hostSeq: 4,
    }

    expect(() =>
      reconcileHostStateReplica(replica, applied({ hostGeneration: 4, hostSeq: 5 }))
    ).toThrow("host_state_resync_required")
    expect(() =>
      reconcileHostStateReplica(
        replica,
        applied({ hostSeq: 5, channel: sessionStateChannel("host-a", "session-2") })
      )
    ).toThrow("host_state_channel_mismatch")
  })

  it("carries confirmed state forward when an event has neither mutation nor origin", () => {
    const confirmed = createEmptyHostStateSession(CHANNEL, "session-1")
    const pending = [action()]

    const reconciled = reconcileHostStateReplica(
      { confirmed, pending, hostGeneration: 3, hostSeq: 4 },
      applied({ hostSeq: 5, outcome: "rejected", rejection: { code: "conflict", message: "no" } })
    )

    expect(reconciled.confirmed).toBe(confirmed)
    expect(reconciled.pending).toBe(pending)
    expect(reconciled.optimistic.draft.text).toBe("hello")
    expect(reconciled.hostSeq).toBe(5)
  })
})

describe("reduceHostStateMutation on a session channel", () => {
  it("walks a session through its full mutation lifecycle", () => {
    let state = createEmptyHostStateSession(CHANNEL, "session-1")
    const apply = (mutation: HostStateMutationV1) => {
      state = reduceHostStateMutation(state, mutation)
    }

    apply({ kind: "session.renamed", title: "Renamed", revision: 1 })
    expect(state.title).toBe("Renamed")

    apply({ kind: "session.archived", archived: true, revision: 2 })
    expect(state.archived).toBe(true)

    apply({ kind: "session.status-changed", status: "queued", revision: 3 })
    expect(state.status).toBe("queued")

    apply({
      kind: "message.queued",
      message: queued(),
      transcriptRevision: 1,
      draftRevision: 2,
      revision: 4,
    })
    expect(state.queue.map((item) => item.actionId)).toEqual(["action-1"])
    expect(state.transcriptRevision).toBe(1)
    expect(state.draft).toEqual({ text: "", attachments: [], revision: 2 })

    apply({ kind: "turn.started", turnId: "turn-1", startedAt: 1_700_000_000_000, revision: 5 })
    expect(state.status).toBe("running")
    expect(state.activeTurn).toEqual({ turnId: "turn-1", startedAt: 1_700_000_000_000 })

    apply({ kind: "approval.requested", request: { requestId: "req-1" }, revision: 6 })
    expect(state.status).toBe("awaiting_approval")
    apply({
      kind: "approval.requested",
      request: { requestId: "req-1", label: "write" },
      revision: 7,
    })
    expect(state.pendingApprovals).toEqual([{ requestId: "req-1", label: "write" }])

    apply({ kind: "approval.resolved", requestId: "req-1", revision: 8 })
    expect(state.pendingApprovals).toEqual([])

    apply({ kind: "elicitation.requested", request: { requestId: "eli-1" }, revision: 9 })
    expect(state.pendingElicitations).toEqual([{ requestId: "eli-1" }])
    apply({ kind: "elicitation.resolved", requestId: "eli-1", revision: 10 })
    expect(state.pendingElicitations).toEqual([])

    apply({ kind: "message.dequeued", actionId: "action-1", revision: 11 })
    expect(state.queue).toEqual([])

    apply({ kind: "turn.finished", status: "completed", revision: 12 })
    expect(state.status).toBe("completed")
    expect(state.activeTurn).toBeNull()

    apply({ kind: "transcript.revised", transcriptRevision: 6, revision: 13 })
    expect(state.transcriptRevision).toBe(6)

    apply({ kind: "session.imported", title: "Imported", transcriptRevision: 9, revision: 14 })
    expect(state).toMatchObject({ title: "Imported", transcriptRevision: 9 })

    apply({ kind: "session.tombstoned", deletedAt: 1_700_000_000_001, hostSeq: 42, revision: 15 })
    expect(state.tombstone).toEqual({ deletedAt: 1_700_000_000_001, hostSeq: 42 })
    expect(state.revision).toBe(15)
  })

  it("keeps a re-broadcast message.queued idempotent", () => {
    const mutation: HostStateMutationV1 = {
      kind: "message.queued",
      message: queued(),
      transcriptRevision: 1,
      draftRevision: 1,
      revision: 1,
    }
    const once = reduceHostStateMutation(
      createEmptyHostStateSession(CHANNEL, "session-1"),
      mutation
    )
    const twice = reduceHostStateMutation(once, { ...mutation, revision: 2 })

    expect(twice.queue).toHaveLength(1)
    expect(twice.queue).toBe(once.queue)
  })

  it("ignores index-only mutations on a session channel", () => {
    const state = createEmptyHostStateSession(CHANNEL, "session-1")

    expect(
      reduceHostStateMutation(state, { kind: "session.upserted", session: summary(), revision: 1 })
    ).toBe(state)
    expect(
      reduceHostStateMutation(state, {
        kind: "session.deleted",
        sessionId: "session-1",
        deletedAt: 5,
        revision: 1,
      })
    ).toBe(state)
  })
})

describe("reduceHostStateMutation on the session index", () => {
  it("upserts by sessionId and keeps the list sorted", () => {
    const start = indexState([summary({ sessionId: "session-b" })])

    const inserted = reduceHostStateMutation(start, {
      kind: "session.upserted",
      session: summary({ sessionId: "session-a", title: "A" }),
      revision: 1,
    })
    expect(inserted.sessions.map((item) => item.sessionId)).toEqual(["session-a", "session-b"])
    expect(inserted.revision).toBe(1)

    const replaced = reduceHostStateMutation(inserted, {
      kind: "session.upserted",
      session: summary({ sessionId: "session-a", title: "A2" }),
      revision: 2,
    })
    expect(replaced.sessions).toHaveLength(2)
    expect(replaced.sessions[0]?.title).toBe("A2")
  })

  it("tombstones only the deleted summary", () => {
    const start = indexState([
      summary({ sessionId: "session-a" }),
      summary({ sessionId: "session-b" }),
    ])

    const deleted = reduceHostStateMutation(start, {
      kind: "session.deleted",
      sessionId: "session-a",
      deletedAt: 77,
      revision: 3,
    })

    expect(deleted.sessions[0]).toMatchObject({
      sessionId: "session-a",
      revision: 3,
      tombstone: { deletedAt: 77, hostSeq: 0 },
    })
    expect(deleted.sessions[1]?.tombstone).toBeUndefined()
    expect(deleted.revision).toBe(3)
  })

  it("ignores session-only mutations on the index channel", () => {
    const start = indexState([summary()])

    expect(
      reduceHostStateMutation(start, { kind: "session.renamed", title: "nope", revision: 4 })
    ).toBe(start)
  })
})

describe("reduceHostStateIntent", () => {
  const intend = (state: HostStateSessionChannelV1, intent: AllowedHostStateIntentV1) =>
    reduceHostStateIntent(state, action({ action: intent }))

  it("applies the locally predictable intents optimistically", () => {
    const base = createEmptyHostStateSession(CHANNEL, "session-1")

    expect(intend(base, { kind: "session.rename", title: "Local" })).toMatchObject({
      title: "Local",
      revision: 1,
    })
    expect(intend(base, { kind: "session.archive", archived: true })).toMatchObject({
      archived: true,
      revision: 1,
    })
    expect(
      intend(base, { kind: "draft.replace", text: "typed", attachments: [attachment()] }).draft
    ).toEqual({ text: "typed", attachments: [attachment()], revision: 1 })
    expect(intend(base, { kind: "turn.abort" })).toMatchObject({
      status: "aborted",
      activeTurn: null,
      revision: 1,
    })
  })

  it("queues an enqueued message once and only promotes an idle session", () => {
    const base = createEmptyHostStateSession(CHANNEL, "session-1")
    const intent: AllowedHostStateIntentV1 = {
      kind: "message.enqueue",
      messageId: "message-1",
      text: "hello",
      attachments: [],
    }

    const queuedOnce = intend(base, intent)
    expect(queuedOnce.status).toBe("queued")
    expect(queuedOnce.queue).toEqual([
      {
        actionId: "action-7",
        messageId: "message-1",
        text: "hello",
        attachments: [],
        clientId: "client-a",
      },
    ])

    const replayed = intend(queuedOnce, intent)
    expect(replayed.queue).toBe(queuedOnce.queue)

    const running = intend({ ...base, status: "running" }, intent)
    expect(running.status).toBe("running")
  })

  it("leaves host-decided intents and non-session channels untouched", () => {
    const base = createEmptyHostStateSession(CHANNEL, "session-1")
    const hostDecided: AllowedHostStateIntentV1[] = [
      { kind: "session.create", title: "New" },
      { kind: "turn.steer", text: "steer" },
      { kind: "turn.followup", text: "followup" },
      { kind: "approval.respond", requestId: "req-1", decision: "allow" },
      { kind: "elicitation.respond", requestId: "eli-1", response: { ok: true } },
      { kind: "transcript.edit", messageId: "message-1", text: "edited" },
      { kind: "transcript.truncate", afterMessageId: "message-1" },
      { kind: "session.import", envelope: { version: 1 } },
    ]

    for (const intent of hostDecided) {
      expect(intend(base, intent)).toBe(base)
    }

    const index = indexState([summary()])
    expect(reduceHostStateIntent(index, action())).toBe(index)
  })
})

describe("HostState intent wire guard", () => {
  const accepts = (intent: unknown) => isHostStateActionV1({ ...action(), action: intent })

  it("accepts every allowed intent shape", () => {
    const intents: AllowedHostStateIntentV1[] = [
      { kind: "session.create" },
      { kind: "session.create", title: "New" },
      { kind: "session.rename", title: "Renamed" },
      { kind: "session.archive", archived: false },
      {
        kind: "draft.replace",
        text: "",
        attachments: [attachment(), attachment({ hash: undefined })],
      },
      { kind: "message.enqueue", messageId: "message-1", text: "hi", attachments: [attachment()] },
      { kind: "turn.steer", text: "steer" },
      { kind: "turn.followup", text: "followup" },
      { kind: "turn.abort" },
      { kind: "approval.respond", requestId: "req-1", decision: "allow" },
      { kind: "approval.respond", requestId: "req-1", decision: "allow_always" },
      { kind: "approval.respond", requestId: "req-1", decision: "deny" },
      {
        kind: "elicitation.respond",
        requestId: "eli-1",
        response: { ok: true, items: [1, "a", null], nested: { deep: false } },
      },
      { kind: "transcript.edit", messageId: "message-1", text: "edited" },
      { kind: "transcript.truncate" },
      { kind: "transcript.truncate", afterMessageId: "message-1" },
      { kind: "session.import", envelope: [1, "two", null] },
    ]

    for (const intent of intents) {
      expect(accepts(intent)).toBe(true)
    }
  })

  it("rejects a malformed field on every intent kind", () => {
    const malformed: unknown[] = [
      null,
      "turn.abort",
      { kind: 7 },
      { kind: "" },
      { kind: "session.destroy" },
      { kind: "session.create", title: 7 },
      { kind: "session.rename" },
      { kind: "session.archive", archived: "yes" },
      { kind: "draft.replace", text: "x", attachments: {} },
      { kind: "draft.replace", text: "x", attachments: [{ name: "a", mediaType: "", size: 1 }] },
      { kind: "message.enqueue", messageId: "", text: "x", attachments: [] },
      { kind: "turn.steer", text: 1 },
      { kind: "turn.followup", text: null },
      { kind: "turn.abort", force: true },
      { kind: "approval.respond", requestId: "req-1", decision: "maybe" },
      { kind: "elicitation.respond", requestId: "eli-1", response: undefined },
      { kind: "elicitation.respond", requestId: "eli-1", response: Number.NaN },
      { kind: "elicitation.respond", requestId: "eli-1", response: [() => null] },
      { kind: "transcript.edit", messageId: "message-1", text: 5 },
      { kind: "transcript.truncate", afterMessageId: "" },
      { kind: "session.import", envelope: () => null },
    ]

    for (const intent of malformed) {
      expect(accepts(intent)).toBe(false)
    }
  })

  it("rejects a malformed envelope field around a valid intent", () => {
    const malformed: Record<string, unknown>[] = [
      { protocolVersion: 2 },
      { channel: "" },
      { accountId: "" },
      { runtimeTargetId: "" },
      { hostId: 7 },
      { hostGeneration: -1 },
      { sessionId: "" },
      { clientId: null },
      { clientSeq: 1.5 },
      { actionId: "" },
      { baseRevision: -1 },
      { createdAt: Number.NaN },
    ]

    expect(isHostStateActionV1(null)).toBe(false)
    for (const overrides of malformed) {
      expect(isHostStateActionV1({ ...action(), ...overrides })).toBe(false)
    }
    expect(
      isHostStateActionV1({ ...action(), sessionId: undefined, baseRevision: undefined })
    ).toBe(true)
  })
})

describe("HostState mutation wire guard", () => {
  const accepts = (mutation: unknown) => isHostStateAppliedActionV1(applied({ mutation } as never))

  it("accepts every mutation kind on the wire", () => {
    const mutations: HostStateMutationV1[] = [
      {
        kind: "session.upserted",
        session: summary({ title: "T", tombstone: { deletedAt: 1, hostSeq: 2 } }),
        revision: 1,
      },
      { kind: "session.deleted", sessionId: "session-1", deletedAt: 5, revision: 2 },
      { kind: "session.renamed", title: "Renamed", revision: 3 },
      { kind: "session.archived", archived: true, revision: 4 },
      { kind: "session.status-changed", status: "running", revision: 5 },
      {
        kind: "draft.replaced",
        text: "draft",
        attachments: [attachment()],
        draftRevision: 1,
        revision: 6,
      },
      {
        kind: "message.queued",
        message: queued({ attachments: [attachment()] }),
        transcriptRevision: 1,
        draftRevision: 1,
        revision: 7,
      },
      { kind: "message.dequeued", actionId: "action-1", revision: 8 },
      { kind: "turn.started", turnId: "turn-1", startedAt: 10, revision: 9 },
      { kind: "turn.finished", status: "completed", revision: 10 },
      { kind: "approval.requested", request: { requestId: "req-1", label: "L" }, revision: 11 },
      { kind: "approval.resolved", requestId: "req-1", revision: 12 },
      { kind: "elicitation.requested", request: { requestId: "eli-1" }, revision: 13 },
      { kind: "elicitation.resolved", requestId: "eli-1", revision: 14 },
      { kind: "transcript.revised", transcriptRevision: 3, revision: 15 },
      { kind: "session.imported", title: "I", transcriptRevision: 4, revision: 16 },
      { kind: "session.tombstoned", deletedAt: 7, hostSeq: 8, revision: 17 },
    ]

    for (const mutation of mutations) {
      expect(accepts(mutation)).toBe(true)
    }
  })

  it("rejects a malformed payload on every mutation kind", () => {
    const malformed: unknown[] = [
      null,
      "session.renamed",
      { kind: "", revision: 1 },
      { kind: "session.renamed", title: "t" },
      { kind: "session.exploded", revision: 1 },
      { kind: "session.upserted", session: summary({ sessionId: "" }), revision: 1 },
      { kind: "session.upserted", session: { ...summary(), extra: 1 }, revision: 1 },
      { kind: "session.upserted", session: summary({ status: "sleeping" as never }), revision: 1 },
      { kind: "session.upserted", session: summary({ archived: 1 as never }), revision: 1 },
      { kind: "session.upserted", session: summary({ title: 1 as never }), revision: 1 },
      { kind: "session.upserted", session: summary({ transcriptRevision: -1 }), revision: 1 },
      {
        kind: "session.upserted",
        session: summary({ tombstone: { deletedAt: 1 } as never }),
        revision: 1,
      },
      { kind: "session.upserted", session: null, revision: 1 },
      { kind: "session.deleted", sessionId: "session-1", deletedAt: -1, revision: 1 },
      { kind: "session.renamed", title: 1, revision: 1 },
      { kind: "session.archived", archived: 1, revision: 1 },
      { kind: "session.status-changed", status: "sleeping", revision: 1 },
      { kind: "draft.replaced", text: "d", attachments: "no", draftRevision: 1, revision: 1 },
      { kind: "draft.replaced", text: "d", attachments: [], draftRevision: -1, revision: 1 },
      {
        kind: "message.queued",
        message: queued({ clientId: "" }),
        transcriptRevision: 1,
        draftRevision: 1,
        revision: 1,
      },
      {
        kind: "message.queued",
        message: { ...queued(), extra: 1 },
        transcriptRevision: 1,
        draftRevision: 1,
        revision: 1,
      },
      {
        kind: "message.queued",
        message: queued(),
        transcriptRevision: -1,
        draftRevision: 1,
        revision: 1,
      },
      { kind: "message.dequeued", actionId: "", revision: 1 },
      { kind: "turn.started", turnId: "turn-1", startedAt: 1.5, revision: 1 },
      { kind: "turn.started", turnId: "", startedAt: 1, revision: 1 },
      { kind: "turn.finished", status: "done", revision: 1 },
      { kind: "approval.requested", request: { requestId: "req-1", extra: 1 }, revision: 1 },
      { kind: "approval.requested", request: { requestId: "req-1", label: 1 }, revision: 1 },
      { kind: "elicitation.requested", request: null, revision: 1 },
      { kind: "approval.resolved", requestId: 5, revision: 1 },
      { kind: "elicitation.resolved", revision: 1 },
      { kind: "transcript.revised", transcriptRevision: "3", revision: 1 },
      { kind: "session.imported", title: 1, transcriptRevision: 4, revision: 1 },
      { kind: "session.imported", title: "I", transcriptRevision: -2, revision: 1 },
      { kind: "session.tombstoned", deletedAt: 1, hostSeq: "8", revision: 1 },
    ]

    for (const mutation of malformed) {
      expect(accepts(mutation)).toBe(false)
    }
  })

  it("validates the origin and rejection envelopes independently", () => {
    expect(
      isHostStateAppliedActionV1(
        applied({
          origin: { clientId: "client-a", clientSeq: 7, actionId: "action-7" },
          outcome: "conflicted",
          rejection: { code: "revision_conflict", message: "stale", currentRevision: 4 },
        })
      )
    ).toBe(true)

    const malformed: Record<string, unknown>[] = [
      { protocolVersion: 2 },
      { channel: "" },
      { hostId: "" },
      { hostGeneration: -1 },
      { hostSeq: 1.5 },
      { outcome: "maybe" },
      { origin: null },
      { origin: { clientId: "client-a", clientSeq: 7, actionId: "action-7", extra: 1 } },
      { origin: { clientId: "", clientSeq: 7, actionId: "action-7" } },
      { origin: { clientId: "client-a", clientSeq: -1, actionId: "action-7" } },
      { origin: { clientId: "client-a", clientSeq: 7, actionId: "" } },
      { rejection: { code: "", message: "x" } },
      { rejection: { code: "c", message: 1 } },
      { rejection: { code: "c", message: "x", currentRevision: -1 } },
      { rejection: { code: "c", message: "x", extra: 1 } },
    ]

    expect(isHostStateAppliedActionV1(null)).toBe(false)
    for (const overrides of malformed) {
      expect(isHostStateAppliedActionV1({ ...applied(), ...overrides })).toBe(false)
    }
  })
})

describe("HostState snapshot and response wire guards", () => {
  const snapshot = (state: HostStateSessionChannelV1 | HostStateSessionIndexChannelV1) => ({
    protocolVersion: HOST_STATE_PROTOCOL_VERSION,
    channel: state.channel,
    hostId: "host-a",
    hostGeneration: 3,
    cutHostSeq: 12,
    revision: state.revision,
    digest: hostStateDigest(state),
    state,
  })

  it("accepts a fully-populated session snapshot and the session index", () => {
    expect(isHostStateSnapshotV1(snapshot(fullSession()))).toBe(true)
    expect(
      isHostStateSnapshotV1(
        snapshot(indexState([summary(), summary({ sessionId: "session-2", title: "Two" })]))
      )
    ).toBe(true)
  })

  it("rejects a snapshot whose digest, channel, or revision disagrees with its state", () => {
    const state = fullSession()

    expect(isHostStateSnapshotV1({ ...snapshot(state), digest: "hsv1-0000000000000000" })).toBe(
      false
    )
    expect(isHostStateSnapshotV1({ ...snapshot(state), channel: "cognia://target/other" })).toBe(
      false
    )
    expect(isHostStateSnapshotV1({ ...snapshot(state), revision: state.revision + 1 })).toBe(false)
    expect(isHostStateSnapshotV1(null)).toBe(false)
    expect(isHostStateSnapshotV1({ ...snapshot(state), cutHostSeq: -1 })).toBe(false)
    expect(isHostStateSnapshotV1({ ...snapshot(state), hostId: "" })).toBe(false)
    expect(isHostStateSnapshotV1({ ...snapshot(state), hostGeneration: -1 })).toBe(false)
    expect(isHostStateSnapshotV1({ ...snapshot(state), protocolVersion: 2 })).toBe(false)
  })

  it("rejects every malformed channel-state shape", () => {
    const malformed: unknown[] = [
      null,
      { kind: "" },
      { kind: "unknown", channel: CHANNEL, revision: 0 },
      { kind: "session-index", channel: "", revision: 0, sessions: [] },
      { kind: "session-index", channel: CHANNEL, revision: -1, sessions: [] },
      { kind: "session-index", channel: CHANNEL, revision: 0, sessions: {} },
      { kind: "session-index", channel: CHANNEL, revision: 0, sessions: [], extra: 1 },
      { ...fullSession(), sessionId: "" },
      { ...fullSession(), status: "sleeping" },
      { ...fullSession(), title: 1 },
      { ...fullSession(), archived: "yes" },
      { ...fullSession(), transcriptRevision: -1 },
      { ...fullSession(), draft: null },
      { ...fullSession(), draft: { text: "x", attachments: [], revision: 0, extra: 1 } },
      { ...fullSession(), draft: { text: 1, attachments: [], revision: 0 } },
      { ...fullSession(), draft: { text: "x", attachments: [{}], revision: 0 } },
      { ...fullSession(), draft: { text: "x", attachments: [], revision: -1 } },
      { ...fullSession(), queue: "no" },
      { ...fullSession(), queue: [queued({ messageId: "" })] },
      { ...fullSession(), queue: [{ ...queued(), text: 1 }] },
      { ...fullSession(), queue: [{ ...queued(), actionId: "" }] },
      { ...fullSession(), activeTurn: { turnId: "t", startedAt: -1 } },
      { ...fullSession(), activeTurn: { turnId: "", startedAt: 1 } },
      { ...fullSession(), activeTurn: { turnId: "t", startedAt: 1, extra: 1 } },
      { ...fullSession(), pendingApprovals: [{ requestId: "" }] },
      { ...fullSession(), pendingApprovals: {} },
      { ...fullSession(), pendingElicitations: [null] },
      { ...fullSession(), tombstone: { deletedAt: 1, hostSeq: -1 } },
      {
        ...fullSession(),
        draft: { text: "x", attachments: [attachment({ size: -1 })], revision: 0 },
      },
      {
        ...fullSession(),
        draft: { text: "x", attachments: [attachment({ hash: "" })], revision: 0 },
      },
      {
        ...fullSession(),
        draft: { text: "x", attachments: [{ ...attachment(), extra: 1 }], revision: 0 },
      },
    ]

    // The envelope mirrors each candidate's own channel/revision/digest so the
    // snapshot's cross-checks agree and the malformed state is what is on trial.
    for (const state of malformed) {
      const carrier = (state ?? {}) as { channel?: unknown; revision?: unknown }
      expect(
        isHostStateSnapshotV1({
          protocolVersion: HOST_STATE_PROTOCOL_VERSION,
          channel: typeof carrier.channel === "string" ? carrier.channel : CHANNEL,
          hostId: "host-a",
          hostGeneration: 3,
          cutHostSeq: 0,
          revision: typeof carrier.revision === "number" ? carrier.revision : 9,
          digest: hostStateDigest(state),
          state,
        })
      ).toBe(false)
    }
  })

  it("accepts a well-formed submit response and rejects malformed receipts", () => {
    expect(
      isHostStateSubmitResponseV1({
        protocolVersion: HOST_STATE_PROTOCOL_VERSION,
        results: [
          { actionId: "action-7", outcome: "applied", hostGeneration: 3, hostSeq: 11 },
          {
            actionId: "action-8",
            outcome: "conflicted",
            hostGeneration: 3,
            hostSeq: 12,
            rejection: { code: "revision_conflict", message: "stale", currentRevision: 4 },
          },
        ],
      })
    ).toBe(true)

    const malformed: unknown[] = [
      null,
      { protocolVersion: 2, results: [] },
      { protocolVersion: HOST_STATE_PROTOCOL_VERSION, results: {} },
      { protocolVersion: HOST_STATE_PROTOCOL_VERSION, results: [null] },
      {
        protocolVersion: HOST_STATE_PROTOCOL_VERSION,
        results: [{ actionId: "", outcome: "applied", hostGeneration: 3, hostSeq: 1 }],
      },
      {
        protocolVersion: HOST_STATE_PROTOCOL_VERSION,
        results: [{ actionId: "a", outcome: "maybe", hostGeneration: 3, hostSeq: 1 }],
      },
      {
        protocolVersion: HOST_STATE_PROTOCOL_VERSION,
        results: [{ actionId: "a", outcome: "applied", hostGeneration: -1, hostSeq: 1 }],
      },
      {
        protocolVersion: HOST_STATE_PROTOCOL_VERSION,
        results: [{ actionId: "a", outcome: "applied", hostGeneration: 3, hostSeq: 1.5 }],
      },
      {
        protocolVersion: HOST_STATE_PROTOCOL_VERSION,
        results: [
          { actionId: "a", outcome: "applied", hostGeneration: 3, hostSeq: 1, rejection: null },
        ],
      },
    ]

    for (const response of malformed) {
      expect(isHostStateSubmitResponseV1(response)).toBe(false)
    }
  })

  it("rejects every malformed host status field", () => {
    const status = {
      protocolVersion: HOST_STATE_PROTOCOL_VERSION,
      hostId: "host-a",
      hostGeneration: 3,
      hostSeq: 1,
      migrationStage: "hoststate-authoritative",
      leaseExpiresAt: 10,
      pendingDispatch: 0,
      pendingBroadcast: 0,
    }
    const malformed: Record<string, unknown>[] = [
      { protocolVersion: 2 },
      { hostId: "" },
      { hostGeneration: -1 },
      { hostSeq: -1 },
      { migrationStage: "unknown" },
      { leaseExpiresAt: -1 },
      { pendingDispatch: 1.5 },
      { pendingBroadcast: "0" },
      { extra: 1 },
    ]

    expect(isHostStateStatusV1(status)).toBe(true)
    expect(isHostStateStatusV1(null)).toBe(false)
    for (const overrides of malformed) {
      expect(isHostStateStatusV1({ ...status, ...overrides })).toBe(false)
    }
  })
})

describe("HostState channels, canonical JSON, and migration stages", () => {
  it("percent-encodes ids so a slash cannot forge a channel segment", () => {
    expect(sessionIndexChannel("target/evil")).toBe(
      `${HOST_STATE_SESSION_CHANNEL_PREFIX}target%2Fevil/sessions`
    )
    expect(sessionStateChannel("host-a", "session/1")).toBe(
      `${HOST_STATE_SESSION_CHANNEL_PREFIX}host-a/sessions/session%2F1`
    )
  })

  it("normalizes negative zero, drops undefined, and refuses non-JSON values", () => {
    expect(canonicalHostStateJson({ b: 1, a: [-0, "x", true, null] })).toBe(
      '{"a":[0,"x",true,null],"b":1}'
    )
    expect(canonicalHostStateJson({ kept: 1, dropped: undefined })).toBe('{"kept":1}')
    expect(() => canonicalHostStateJson(Number.POSITIVE_INFINITY)).toThrow(
      "HostState canonical JSON requires finite numbers"
    )
    expect(() => canonicalHostStateJson({ fn: () => null })).toThrow(
      "HostState canonical JSON accepts JSON values only"
    )
  })

  it("only allows writes once the host owns the state", () => {
    expect(hostStateMigrationStageAllowsWrites("hoststate-authoritative")).toBe(true)
    expect(hostStateMigrationStageAllowsWrites("legacy-projection-only")).toBe(true)
    expect(hostStateMigrationStageAllowsWrites("retired")).toBe(true)
    expect(hostStateMigrationStageAllowsWrites("legacy-authoritative")).toBe(false)
    expect(hostStateMigrationStageAllowsWrites("shadow")).toBe(false)
    expect(hostStateMigrationStageAllowsWrites("hoststate-read")).toBe(false)
  })
})
