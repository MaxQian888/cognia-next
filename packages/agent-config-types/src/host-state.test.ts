import {
  HOST_STATE_PROTOCOL_VERSION,
  canonicalHostStateJson,
  createEmptyHostStateSession,
  hostStateDigest,
  isHostStateActionV1,
  isHostStateAppliedActionV1,
  isHostStateSnapshotV1,
  isHostStateStatusV1,
  isHostStateSubmitResponseV1,
  reconcileHostStateReplica,
  reduceHostStateMutation,
  type HostStateActionV1,
  type HostStateAppliedActionV1,
} from "./host-state"

const action = (overrides: Partial<HostStateActionV1> = {}): HostStateActionV1 => ({
  protocolVersion: HOST_STATE_PROTOCOL_VERSION,
  channel: "cognia://target/host-a/sessions/session-1",
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
})
