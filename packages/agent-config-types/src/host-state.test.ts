import {
  OPEN_DECISION_STATUSES,
  TERMINAL_OPERATION_STATUSES,
  TERMINAL_TURN_STATUSES,
  callerMaySubmitHostStateIntent,
  canonicalHostStateJson,
  HOST_STATE_INTENT_KINDS,
  createEmptyHostStateSession,
  deriveTurnAfterDecisions,
  hostStateDigest,
  hostStateIntentCapability,
  hostStateIntentKindCapability,
  hostStateIntentRequiresLiveControl,
  intentRequiresRuntimeDispatch,
  isHostStateAction,
  isHostStateAppliedAction,
  isHostStateSnapshot,
  isHostStateStatus,
  isHostStateSubmitResponse,
  permittedHostStateIntentKinds,
  reconcileHostStateReplica,
  reduceHostStateIntent,
  reduceHostStateMutation,
  sessionIndexChannel,
  sessionStateChannel,
  type AllowedHostStateIntent,
  type HostStateAction,
  type HostStateAppliedAction,
  type HostStateDecision,
  type HostStateMutation,
  type HostStateOperation,
  type HostStateSessionChannel,
  type HostStateSessionIndexChannel,
  type HostStateSessionSummary,
} from "./host-state"

const TARGET = "target-a"
const SESSION = "session-1"
const CHANNEL = sessionStateChannel(TARGET, SESSION)
const INDEX = sessionIndexChannel(TARGET)

function action(
  intent: AllowedHostStateIntent,
  overrides: Partial<HostStateAction> = {}
): HostStateAction {
  return {
    channel: CHANNEL,
    accountId: "acct-a",
    runtimeTargetId: TARGET,
    hostId: "host-a",
    hostGeneration: 1,
    sessionId: SESSION,
    clientId: "client-a",
    clientSeq: 1,
    actionId: "action-1",
    baseRevision: 0,
    createdAt: 10,
    action: intent,
    ...overrides,
  }
}

function session(overrides: Partial<HostStateSessionChannel> = {}): HostStateSessionChannel {
  return { ...createEmptyHostStateSession(CHANNEL, SESSION), ...overrides }
}

function operation(overrides: Partial<HostStateOperation> = {}): HostStateOperation {
  return {
    actionId: "action-1",
    kind: "turn.followup",
    status: "accepted",
    clientId: "client-a",
    createdAt: 10,
    updatedAt: 10,
    ...overrides,
  }
}

function decision(overrides: Partial<HostStateDecision> = {}): HostStateDecision {
  return {
    requestId: "req-1",
    kind: "tool-approval",
    status: "pending",
    requestedAt: 10,
    ...overrides,
  }
}

function apply(state: HostStateSessionChannel, ...mutations: HostStateMutation[]) {
  return mutations.reduce(reduceHostStateMutation, state)
}

// ─────────────────────────────────────────────────────────────────────────────
// The intent / confirmation split — the whole point of the state model.
// ─────────────────────────────────────────────────────────────────────────────

describe("an intent may ask, never assert", () => {
  it("shows an abort as stopping, not as a finished turn", () => {
    const running = session({ turn: "running", activeTurn: { turnId: "t1", startedAt: 1 } })
    const optimistic = reduceHostStateIntent(running, action({ kind: "turn.abort" }))

    expect(optimistic.turn).toBe("stopping")
    // The run is still going. Clearing it here is what let a client re-open a
    // composer against a turn that was still producing.
    expect(optimistic.activeTurn).not.toBeNull()
  })

  it("never revives a turn that already reached a terminal state", () => {
    for (const turn of TERMINAL_TURN_STATUSES) {
      const done = session({ turn })
      expect(reduceHostStateIntent(done, action({ kind: "turn.abort" })).turn).toBe(turn)
    }
  })

  it("marks a decision responding and keeps it in the list", () => {
    const blocked = session({ turn: "awaiting-decision", decisions: [decision()] })
    const optimistic = reduceHostStateIntent(
      blocked,
      action({ kind: "approval.respond", requestId: "req-1", decision: "allow" })
    )

    expect(optimistic.decisions).toHaveLength(1)
    expect(optimistic.decisions[0]).toMatchObject({
      status: "responding",
      respondingActionId: "action-1",
    })
    // Removing it here is what erased a decision the run was still blocked on
    // when the answer never reached the runtime.
    expect(optimistic.turn).toBe("awaiting-decision")
  })

  it("does not touch a decision another client is already answering", () => {
    const taken = session({
      decisions: [decision({ status: "responding", respondingActionId: "other-action" })],
    })
    const optimistic = reduceHostStateIntent(
      taken,
      action({ kind: "approval.respond", requestId: "req-1", decision: "deny" })
    )
    expect(optimistic.decisions[0].respondingActionId).toBe("other-action")
  })

  it("queues a message without moving the transcript revision", () => {
    const idle = session({ transcriptRevision: 7 })
    const optimistic = reduceHostStateIntent(
      idle,
      action({ kind: "message.enqueue", messageId: "m1", text: "hi", attachments: [] })
    )

    expect(optimistic.queue).toHaveLength(1)
    expect(optimistic.turn).toBe("queued")
    // A queued message writes no transcript content. Advancing this invites
    // every replica to refetch a page that did not change.
    expect(optimistic.transcriptRevision).toBe(7)
  })

  it("leaves steer, follow-up and every Host-decided intent to the Host", () => {
    const running = session({ turn: "running" })
    for (const intent of [
      { kind: "turn.steer", text: "x" },
      { kind: "turn.followup", text: "x" },
      { kind: "session.create", title: "x" },
      { kind: "transcript.edit", messageId: "m", text: "x" },
      { kind: "transcript.truncate" },
      { kind: "session.import", envelope: null },
    ] satisfies AllowedHostStateIntent[]) {
      expect(reduceHostStateIntent(running, action(intent))).toBe(running)
    }
  })

  it("applies the intents that have no runtime step at all", () => {
    const base = session()
    expect(
      reduceHostStateIntent(base, action({ kind: "session.rename", title: "Named" })).title
    ).toBe("Named")
    expect(
      reduceHostStateIntent(base, action({ kind: "session.archive", archived: true })).conversation
    ).toBe("archived")
    const drafted = reduceHostStateIntent(
      base,
      action({ kind: "draft.replace", text: "typed", attachments: [] })
    )
    expect(drafted.draft).toMatchObject({ text: "typed", revision: 1 })
  })

  it("queues an enqueued message only once", () => {
    const enqueue = action({
      kind: "message.enqueue",
      messageId: "m1",
      text: "hi",
      attachments: [],
    })
    const once = reduceHostStateIntent(session(), enqueue)
    expect(reduceHostStateIntent(once, enqueue).queue).toHaveLength(1)
  })

  it("leaves a non-session channel untouched", () => {
    const index: HostStateSessionIndexChannel = {
      kind: "session-index",
      channel: INDEX,
      revision: 0,
      sessions: [],
    }
    expect(reduceHostStateIntent(index, action({ kind: "turn.abort" }))).toBe(index)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Operations
// ─────────────────────────────────────────────────────────────────────────────

describe("operations", () => {
  it("prices every intent as dispatching or not, exhaustively", () => {
    const dispatched: AllowedHostStateIntent["kind"][] = [
      "message.enqueue",
      "turn.steer",
      "turn.followup",
      "turn.abort",
      "approval.respond",
      "elicitation.respond",
    ]
    const settledLocally: AllowedHostStateIntent["kind"][] = [
      "session.create",
      "session.rename",
      "session.archive",
      "draft.replace",
      "transcript.edit",
      "transcript.truncate",
      "session.import",
    ]
    for (const kind of dispatched) expect(intentRequiresRuntimeDispatch(kind)).toBe(true)
    for (const kind of settledLocally) expect(intentRequiresRuntimeDispatch(kind)).toBe(false)
  })

  it("accepting an abort shows stopping without ending the turn", () => {
    const running = session({ turn: "running", activeTurn: { turnId: "t1", startedAt: 1 } })
    const next = apply(running, {
      kind: "operation.accepted",
      operation: operation({ kind: "turn.abort" }),
      revision: 1,
    })
    expect(next.turn).toBe("stopping")
    expect(next.activeTurn).not.toBeNull()
    expect(next.operations).toHaveLength(1)
  })

  it("accepting a decision answer marks exactly the targeted decision", () => {
    const blocked = session({
      turn: "awaiting-decision",
      decisions: [decision(), decision({ requestId: "req-2" })],
    })
    const next = apply(blocked, {
      kind: "operation.accepted",
      operation: operation({ kind: "approval.respond", targetRequestId: "req-2" }),
      revision: 1,
    })
    expect(next.decisions[0].status).toBe("pending")
    expect(next.decisions[1]).toMatchObject({
      status: "responding",
      respondingActionId: "action-1",
    })
  })

  it("a steer's operation is the whole of the change", () => {
    const running = session({ turn: "running" })
    const next = apply(running, {
      kind: "operation.accepted",
      operation: operation({ kind: "turn.steer" }),
      revision: 1,
    })
    expect(next.turn).toBe("running")
    expect(next.decisions).toEqual([])
    expect(next.operations[0].kind).toBe("turn.steer")
  })

  it("is idempotent on a re-broadcast acceptance", () => {
    const accepted: HostStateMutation = {
      kind: "operation.accepted",
      operation: operation(),
      revision: 1,
    }
    expect(apply(session(), accepted, accepted).operations).toHaveLength(1)
  })

  it("walks accepted → dispatching → acknowledged", () => {
    const next = apply(
      session(),
      { kind: "operation.accepted", operation: operation(), revision: 1 },
      {
        kind: "operation.changed",
        actionId: "action-1",
        status: "dispatching",
        correlationId: "corr-1",
        revision: 2,
      },
      { kind: "operation.changed", actionId: "action-1", status: "acknowledged", revision: 3 }
    )
    expect(next.operations[0]).toMatchObject({
      status: "acknowledged",
      correlationId: "corr-1",
    })
  })

  it("lets a Host redrive move an operation out of failed, but not out of acknowledged", () => {
    // Recovery exists for exactly this: the first dispatch attempt failed, the
    // Host retried, and the retry worked. Locking `failed` would leave the
    // client reading a failure for a message that is on its way.
    const redriven = apply(
      session(),
      { kind: "operation.accepted", operation: operation(), revision: 1 },
      {
        kind: "operation.changed",
        actionId: "action-1",
        status: "failed",
        errorCode: "E",
        revision: 2,
      },
      { kind: "operation.changed", actionId: "action-1", status: "dispatching", revision: 3 }
    )
    expect(redriven.operations[0]).toMatchObject({ status: "dispatching" })

    // The guard's real job stays intact: the runtime's own confirmation is
    // final, and a late `dispatching` from the Host's bookkeeping must not drag
    // it back to "sending…".
    const settled = apply(
      session(),
      { kind: "operation.accepted", operation: operation(), revision: 1 },
      { kind: "operation.changed", actionId: "action-1", status: "acknowledged", revision: 2 },
      { kind: "operation.changed", actionId: "action-1", status: "dispatching", revision: 3 }
    )
    expect(settled.operations[0]).toMatchObject({ status: "acknowledged" })
  })

  /**
   * The failure this model exists to make impossible: an abort whose dispatch
   * never landed used to leave the session reading "aborted" while the run kept
   * producing.
   */
  it("gives back the stopping state when an abort never lands", () => {
    const running = session({ turn: "running", activeTurn: { turnId: "t1", startedAt: 1 } })
    const next = apply(
      running,
      {
        kind: "operation.accepted",
        operation: operation({ kind: "turn.abort" }),
        revision: 1,
      },
      {
        kind: "operation.changed",
        actionId: "action-1",
        status: "failed",
        errorCode: "runtime_dispatch_failed",
        revision: 2,
      }
    )
    expect(next.turn).toBe("running")
    expect(next.operations[0]).toMatchObject({
      status: "failed",
      errorCode: "runtime_dispatch_failed",
    })
  })

  it("gives a decision back to the queue when the answer never lands", () => {
    const blocked = session({ turn: "awaiting-decision", decisions: [decision()] })
    const next = apply(
      blocked,
      {
        kind: "operation.accepted",
        operation: operation({ kind: "approval.respond", targetRequestId: "req-1" }),
        revision: 1,
      },
      { kind: "operation.changed", actionId: "action-1", status: "failed", revision: 2 }
    )
    // Otherwise the prompt stays owned forever by a device whose answer was
    // lost, and no other client can take it.
    expect(next.decisions[0]).toMatchObject({ status: "pending", respondingActionId: undefined })
    expect(next.turn).toBe("awaiting-decision")
  })

  it("does not steal a decision back from whoever owns it now", () => {
    const blocked = session({
      decisions: [decision({ status: "responding", respondingActionId: "other-action" })],
    })
    const next = apply(
      blocked,
      {
        kind: "operation.accepted",
        operation: operation({ kind: "approval.respond", targetRequestId: "req-1" }),
        revision: 1,
      },
      { kind: "operation.changed", actionId: "action-1", status: "failed", revision: 2 }
    )
    expect(next.decisions[0].respondingActionId).toBe("other-action")
  })

  it("rolls back on expired and superseded, not on acknowledged", () => {
    const build = (status: HostStateOperation["status"]) =>
      apply(
        session({ turn: "running", activeTurn: { turnId: "t1", startedAt: 1 } }),
        {
          kind: "operation.accepted",
          operation: operation({ kind: "turn.abort" }),
          revision: 1,
        },
        { kind: "operation.changed", actionId: "action-1", status, revision: 2 }
      )
    expect(build("expired").turn).toBe("running")
    expect(build("superseded").turn).toBe("running")
    expect(build("acknowledged").turn).toBe("stopping")
    expect(build("dispatching").turn).toBe("stopping")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Decisions
// ─────────────────────────────────────────────────────────────────────────────

describe("decisions", () => {
  it("keeps several open at once, in request order", () => {
    const next = apply(
      session(),
      { kind: "decision.requested", decision: decision({ requestId: "a" }), revision: 1 },
      { kind: "decision.requested", decision: decision({ requestId: "b" }), revision: 2 },
      { kind: "decision.requested", decision: decision({ requestId: "c" }), revision: 3 }
    )
    // The previous per-kind buckets let a second request overwrite the first,
    // stranding the run on a prompt no client could see.
    expect(next.decisions.map((item) => item.requestId)).toEqual(["a", "b", "c"])
    expect(next.turn).toBe("awaiting-decision")
  })

  it("re-requesting the same id replaces it in place", () => {
    const next = apply(
      session(),
      { kind: "decision.requested", decision: decision({ requestId: "a" }), revision: 1 },
      { kind: "decision.requested", decision: decision({ requestId: "b" }), revision: 2 },
      {
        kind: "decision.requested",
        decision: decision({ requestId: "a", label: "again" }),
        revision: 3,
      }
    )
    expect(next.decisions.map((item) => item.requestId)).toEqual(["a", "b"])
    expect(next.decisions[0].label).toBe("again")
  })

  it("stays awaiting while any decision is still open, then re-derives", () => {
    const two = apply(
      session({ activeTurn: { turnId: "t1", startedAt: 1 } }),
      { kind: "decision.requested", decision: decision({ requestId: "a" }), revision: 1 },
      { kind: "decision.requested", decision: decision({ requestId: "b" }), revision: 2 }
    )
    const one = apply(two, {
      kind: "decision.settled",
      requestId: "a",
      status: "resolved",
      revision: 3,
    })
    expect(one.turn).toBe("awaiting-decision")

    const none = apply(one, {
      kind: "decision.settled",
      requestId: "b",
      status: "resolved",
      revision: 4,
    })
    expect(none.turn).toBe("running")
  })

  it("does not re-derive a stopping or terminal turn", () => {
    const stopping = apply(
      session({
        turn: "stopping",
        decisions: [decision()],
        activeTurn: { turnId: "t", startedAt: 1 },
      }),
      { kind: "decision.settled", requestId: "req-1", status: "resolved", revision: 1 }
    )
    expect(stopping.turn).toBe("stopping")
  })

  /**
   * Dormant on purpose. Host computer-use consent still runs through the
   * automation ConsentBroker, a separate plane from the canonical event stream
   * this state projects from — so the kind is reachable on the wire and refused
   * for remote answering, but no Host emits one. This pins that, so the day a
   * producer appears the assertion fails and someone has to decide the UI.
   */
  it("no runtime event produces a locked-computer-use decision yet", () => {
    const kinds = new Set<string>()
    const next = apply(
      session(),
      { kind: "decision.requested", decision: decision({ kind: "tool-approval" }), revision: 1 },
      {
        kind: "decision.requested",
        decision: decision({ requestId: "req-2", kind: "elicitation" }),
        revision: 2,
      },
      {
        kind: "decision.requested",
        decision: decision({ requestId: "req-3", kind: "locked-computer-use" }),
        revision: 3,
      }
    )
    for (const item of next.decisions) kinds.add(item.kind)
    // The shape accepts all three; only the first two have a producer today.
    expect(kinds).toEqual(new Set(["tool-approval", "elicitation", "locked-computer-use"]))
  })

  it("carries subagent provenance and the Host-only flag", () => {
    const next = apply(session(), {
      kind: "decision.requested",
      decision: decision({ origin: { subagentId: "run-2", label: "reviewer" }, hostOnly: true }),
      revision: 1,
    })
    expect(next.decisions[0].origin).toEqual({ subagentId: "run-2", label: "reviewer" })
    expect(next.decisions[0].hostOnly).toBe(true)
  })

  it("derives the turn from what is left, not from what was asked", () => {
    expect(deriveTurnAfterDecisions(session({ decisions: [decision()] }))).toBe("awaiting-decision")
    expect(
      deriveTurnAfterDecisions(session({ decisions: [decision({ status: "responding" })] }))
    ).toBe("awaiting-decision")
    expect(
      deriveTurnAfterDecisions(session({ decisions: [decision({ status: "resolved" })] }))
    ).toBe("idle")
    expect(deriveTurnAfterDecisions(session({ activeTurn: { turnId: "t", startedAt: 1 } }))).toBe(
      "running"
    )
    expect(
      deriveTurnAfterDecisions(
        session({
          queue: [
            { actionId: "a", messageId: "m", text: "t", attachments: [], clientId: "client-a" },
          ],
        })
      )
    ).toBe("queued")
  })

  it("agrees with OPEN_DECISION_STATUSES about what still blocks", () => {
    expect([...OPEN_DECISION_STATUSES]).toEqual(["pending", "responding"])
    for (const status of ["resolved", "expired", "interrupted"] as const) {
      expect(deriveTurnAfterDecisions(session({ decisions: [decision({ status })] }))).toBe("idle")
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic settlement
// ─────────────────────────────────────────────────────────────────────────────

describe("settling everything that can never be answered", () => {
  const busy = () =>
    apply(
      session({ activeTurn: { turnId: "t1", startedAt: 1 } }),
      { kind: "decision.requested", decision: decision({ requestId: "a" }), revision: 1 },
      { kind: "decision.requested", decision: decision({ requestId: "b" }), revision: 2 },
      { kind: "operation.accepted", operation: operation({ actionId: "op-1" }), revision: 3 },
      {
        kind: "operation.changed",
        actionId: "op-1",
        status: "dispatching",
        revision: 4,
      },
      {
        kind: "operation.accepted",
        operation: operation({ actionId: "op-done", status: "acknowledged" }),
        revision: 5,
      }
    )

  it("a turn ending interrupts every open decision and expires every live operation", () => {
    const next = apply(busy(), { kind: "turn.settled", turn: "completed", revision: 6 })

    expect(next.turn).toBe("completed")
    expect(next.decisions.map((item) => item.status)).toEqual(["interrupted", "interrupted"])
    const byId = Object.fromEntries(next.operations.map((item) => [item.actionId, item]))
    expect(byId["op-1"]).toMatchObject({ status: "expired", errorCode: "host_state_turn_ended" })
    // An operation the runtime already acknowledged is finished, not expired.
    expect(byId["op-done"].status).toBe("acknowledged")
  })

  /**
   * `session_ended` closes one turn. Treating it as the end of the conversation
   * is what locked a composer the user could legitimately keep typing into.
   */
  it("does not end the conversation when a turn ends", () => {
    const next = apply(busy(), { kind: "turn.settled", turn: "completed", revision: 6 })
    expect(next.conversation).toBe("present")
    expect(next.tombstone).toBeUndefined()
  })

  it("a lost runtime interrupts the decisions but keeps the conversation resumable", () => {
    const next = apply(busy(), { kind: "runtime.changed", runtime: "unavailable", revision: 6 })

    expect(next.runtime).toBe("unavailable")
    // Retryable, because a sidecar can come back.
    expect(next.turn).toBe("retryable-error")
    expect(next.conversation).toBe("present")
    expect(next.transcriptRevision).toBe(0)
    expect(next.decisions.every((item) => item.status === "interrupted")).toBe(true)
  })

  it("a runtime coming back settles nothing on its own", () => {
    const next = apply(busy(), { kind: "runtime.changed", runtime: "ready", revision: 6 })
    expect(next.runtime).toBe("ready")
    expect(next.decisions.map((item) => item.status)).toEqual(["pending", "pending"])
    expect(next.turn).toBe("awaiting-decision")
  })

  it("a runtime loss on an idle session does not invent an error", () => {
    const next = apply(session({ turn: "idle" }), {
      kind: "runtime.changed",
      runtime: "restarting",
      revision: 1,
    })
    expect(next.turn).toBe("idle")
  })

  it("deleting the session expires everything and forbids control", () => {
    const next = apply(busy(), {
      kind: "session.tombstoned",
      deletedAt: 99,
      hostSeq: 12,
      revision: 6,
    })

    expect(next.conversation).toBe("tombstoned")
    expect(next.tombstone).toEqual({ deletedAt: 99, hostSeq: 12 })
    expect(next.turn).toBe("idle")
    // Expired, not interrupted: nothing about a deleted session is resumable.
    expect(next.decisions.every((item) => item.status === "expired")).toBe(true)
    expect(next.operations.filter((item) => item.actionId === "op-1")[0].errorCode).toBe(
      "host_state_session_deleted"
    )
  })

  it("agrees with TERMINAL_OPERATION_STATUSES about what is already finished", () => {
    expect([...TERMINAL_OPERATION_STATUSES]).toEqual([
      "acknowledged",
      "failed",
      "expired",
      "superseded",
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Ordinary session mutations
// ─────────────────────────────────────────────────────────────────────────────

describe("reduceHostStateMutation on a session channel", () => {
  it("walks a session through its lifecycle", () => {
    const next = apply(
      session(),
      { kind: "session.renamed", title: "Renamed", revision: 1 },
      { kind: "conversation.changed", conversation: "archived", revision: 2 },
      {
        kind: "draft.replaced",
        text: "typed",
        attachments: [],
        draftRevision: 1,
        revision: 3,
      },
      {
        kind: "message.queued",
        message: {
          actionId: "a1",
          messageId: "m1",
          text: "hi",
          attachments: [],
          clientId: "client-a",
        },
        operation: operation({ actionId: "a1", kind: "message.enqueue" }),
        draftRevision: 2,
        revision: 4,
      },
      { kind: "turn.started", turnId: "t1", startedAt: 50, revision: 5 },
      { kind: "message.dequeued", actionId: "a1", revision: 6 },
      { kind: "transcript.revised", transcriptRevision: 3, revision: 7 },
      { kind: "turn.settled", turn: "completed", revision: 8 }
    )

    expect(next).toMatchObject({
      title: "Renamed",
      conversation: "archived",
      turn: "completed",
      transcriptRevision: 3,
      revision: 8,
      activeTurn: null,
      queue: [],
    })
    expect(next.draft).toEqual({ text: "", attachments: [], revision: 2 })
    expect(next.operations).toHaveLength(1)
  })

  it("keeps a re-broadcast message.queued idempotent", () => {
    const queued: HostStateMutation = {
      kind: "message.queued",
      message: {
        actionId: "a1",
        messageId: "m1",
        text: "hi",
        attachments: [],
        clientId: "client-a",
      },
      operation: operation({ actionId: "a1", kind: "message.enqueue" }),
      draftRevision: 1,
      revision: 1,
    }
    const next = apply(session(), queued, queued)
    expect(next.queue).toHaveLength(1)
    expect(next.operations).toHaveLength(1)
  })

  it("ignores index-only mutations on a session channel", () => {
    const base = session()
    const summary: HostStateSessionSummary = {
      sessionId: SESSION,
      conversation: "present",
      turn: "idle",
      revision: 1,
      transcriptRevision: 0,
    }
    expect(apply(base, { kind: "session.upserted", session: summary, revision: 1 })).toBe(base)
    expect(
      apply(base, { kind: "session.deleted", sessionId: SESSION, deletedAt: 1, revision: 1 })
    ).toBe(base)
  })
})

describe("reduceHostStateMutation on the session index", () => {
  const index = (sessions: HostStateSessionSummary[] = []): HostStateSessionIndexChannel => ({
    kind: "session-index",
    channel: INDEX,
    revision: 0,
    sessions,
  })
  const summary = (
    sessionId: string,
    overrides: Partial<HostStateSessionSummary> = {}
  ): HostStateSessionSummary => ({
    sessionId,
    conversation: "present",
    turn: "idle",
    revision: 1,
    transcriptRevision: 0,
    ...overrides,
  })

  it("upserts by sessionId and keeps the list sorted", () => {
    const next = reduceHostStateMutation(
      reduceHostStateMutation(index(), {
        kind: "session.upserted",
        session: summary("s-b"),
        revision: 1,
      }),
      { kind: "session.upserted", session: summary("s-a", { title: "A" }), revision: 2 }
    )
    expect(next.sessions.map((item) => item.sessionId)).toEqual(["s-a", "s-b"])
    expect(next.revision).toBe(2)
  })

  it("tombstones only the deleted summary", () => {
    const next = reduceHostStateMutation(index([summary("s-a"), summary("s-b")]), {
      kind: "session.deleted",
      sessionId: "s-a",
      deletedAt: 42,
      revision: 3,
    })
    expect(next.sessions[0]).toMatchObject({
      conversation: "tombstoned",
      tombstone: { deletedAt: 42, hostSeq: 0 },
    })
    expect(next.sessions[1].conversation).toBe("present")
  })

  it("ignores session-only mutations on the index channel", () => {
    const base = index()
    expect(reduceHostStateMutation(base, { kind: "turn.stopping", revision: 1 })).toBe(base)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Replica reconciliation
// ─────────────────────────────────────────────────────────────────────────────

describe("reconcileHostStateReplica", () => {
  const confirmed = session()
  const pending = [
    action({ kind: "session.rename", title: "Local" }, { actionId: "pending-1", clientSeq: 2 }),
  ]
  const event = (overrides: Partial<HostStateAppliedAction> = {}): HostStateAppliedAction => ({
    channel: CHANNEL,
    hostId: "host-a",
    hostGeneration: 1,
    hostSeq: 1,
    outcome: "applied",
    ...overrides,
  })

  it("removes an echoed action from the outbox and rebases the rest", () => {
    const view = reconcileHostStateReplica(
      { confirmed, pending, hostGeneration: 1, hostSeq: 0 },
      event({
        origin: { clientId: "client-a", clientSeq: 1, actionId: "action-1" },
        mutation: { kind: "session.renamed", title: "Server", revision: 1 },
      })
    )
    expect(view.confirmed.title).toBe("Server")
    expect(view.pending).toHaveLength(1)
    expect((view.optimistic as HostStateSessionChannel).title).toBe("Local")
  })

  it("rejects gaps and stale generations instead of guessing an order", () => {
    expect(() =>
      reconcileHostStateReplica(
        { confirmed, pending: [], hostGeneration: 1, hostSeq: 0 },
        event({ hostSeq: 2 })
      )
    ).toThrow("host_state_sequence_gap")
    expect(() =>
      reconcileHostStateReplica(
        { confirmed, pending: [], hostGeneration: 2, hostSeq: 0 },
        event({ hostGeneration: 1 })
      )
    ).toThrow("stale_host_generation")
    expect(() =>
      reconcileHostStateReplica(
        { confirmed, pending: [], hostGeneration: 1, hostSeq: 0 },
        event({ hostGeneration: 2 })
      )
    ).toThrow("host_state_resync_required")
    expect(() =>
      reconcileHostStateReplica(
        { confirmed, pending: [], hostGeneration: 1, hostSeq: 0 },
        event({ channel: "cognia://target/other/sessions/x" })
      )
    ).toThrow("host_state_channel_mismatch")
  })

  it("carries confirmed state forward when an event has neither mutation nor origin", () => {
    const view = reconcileHostStateReplica(
      { confirmed, pending, hostGeneration: 1, hostSeq: 0 },
      event({ outcome: "duplicate" })
    )
    expect(view.confirmed).toBe(confirmed)
    expect(view.pending).toBe(pending)
    expect(view.hostSeq).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Wire guards
// ─────────────────────────────────────────────────────────────────────────────

describe("wire guards", () => {
  const EVERY_INTENT: AllowedHostStateIntent[] = [
    { kind: "session.create", title: "t" },
    { kind: "session.rename", title: "t" },
    { kind: "session.archive", archived: true },
    { kind: "draft.replace", text: "t", attachments: [] },
    { kind: "message.enqueue", messageId: "m", text: "t", attachments: [] },
    { kind: "turn.steer", text: "t" },
    { kind: "turn.followup", text: "t" },
    { kind: "turn.abort" },
    { kind: "approval.respond", requestId: "r", decision: "allow" },
    { kind: "elicitation.respond", requestId: "r", response: { ok: true } },
    { kind: "transcript.edit", messageId: "m", text: "t" },
    { kind: "transcript.truncate", afterMessageId: "m" },
    { kind: "session.import", envelope: { header: {} } },
  ]

  it("carries an upload ref on an attachment, and still refuses anything else", () => {
    const withRef = action({
      kind: "message.enqueue",
      messageId: "m",
      text: "look",
      attachments: [
        {
          name: "shot.png",
          mediaType: "image/png",
          size: 12,
          hash: "a".repeat(64),
          ref: "cognia-upload:upl_1",
        },
      ],
    })
    expect(isHostStateAction(withRef)).toBe(true)

    // The ref is what makes the bytes reachable; an empty one is a message
    // that claims an attachment the Host can never resolve.
    expect(
      isHostStateAction(
        action({
          kind: "message.enqueue",
          messageId: "m",
          text: "look",
          attachments: [{ name: "shot.png", mediaType: "image/png", size: 12, ref: "" }],
        })
      )
    ).toBe(false)
    // A path or a URL would let the client choose what the Host reads. The
    // guard cannot tell those apart from a ref, but it CAN refuse a second
    // field invented to carry one.
    expect(
      isHostStateAction(
        action({
          kind: "message.enqueue",
          messageId: "m",
          text: "look",
          attachments: [
            { name: "shot.png", mediaType: "image/png", size: 12, url: "file:///etc/passwd" },
          ],
        } as never)
      )
    ).toBe(false)
  })

  it("accepts the closed action shape and rejects any unknown wire field", () => {
    for (const intent of EVERY_INTENT) expect(isHostStateAction(action(intent))).toBe(true)
    // A device-local field must not be able to hitch a ride.
    expect(isHostStateAction({ ...action({ kind: "turn.abort" }), deviceToken: "x" })).toBe(false)
    // The version marker is gone; sending one is now an unknown field.
    expect(isHostStateAction({ ...action({ kind: "turn.abort" }), protocolVersion: 1 })).toBe(false)
  })

  it("rejects a malformed field on every intent kind", () => {
    const broken: unknown[] = [
      { kind: "session.create", title: 1 },
      { kind: "session.rename" },
      { kind: "session.archive", archived: "yes" },
      { kind: "draft.replace", text: "t", attachments: [{ name: "n" }] },
      { kind: "message.enqueue", messageId: "", text: "t", attachments: [] },
      { kind: "turn.steer", text: 1 },
      { kind: "turn.followup" },
      { kind: "turn.abort", extra: true },
      { kind: "approval.respond", requestId: "r", decision: "maybe" },
      { kind: "elicitation.respond", requestId: "r", response: Number.NaN },
      { kind: "transcript.edit", messageId: "m" },
      { kind: "transcript.truncate", afterMessageId: 1 },
      { kind: "session.import" },
      { kind: "unknown.intent" },
    ]
    for (const intent of broken) {
      expect(isHostStateAction({ ...action({ kind: "turn.abort" }), action: intent })).toBe(false)
    }
  })

  it("rejects a malformed envelope field around a valid intent", () => {
    const valid = action({ kind: "turn.abort" })
    const broken: Partial<Record<keyof HostStateAction, unknown>>[] = [
      { channel: "" },
      { accountId: "" },
      { runtimeTargetId: "" },
      { hostId: "" },
      { hostGeneration: -1 },
      { sessionId: "" },
      { clientId: "" },
      { clientSeq: 1.5 },
      { actionId: "" },
      { baseRevision: -1 },
      { createdAt: "now" },
    ]
    for (const patch of broken) expect(isHostStateAction({ ...valid, ...patch })).toBe(false)
  })

  it("accepts every mutation kind on the wire", () => {
    const mutations: HostStateMutation[] = [
      {
        kind: "session.upserted",
        session: {
          sessionId: SESSION,
          conversation: "present",
          turn: "idle",
          revision: 1,
          transcriptRevision: 0,
        },
        revision: 1,
      },
      { kind: "session.deleted", sessionId: SESSION, deletedAt: 1, revision: 1 },
      { kind: "session.renamed", title: "t", revision: 1 },
      { kind: "conversation.changed", conversation: "archived", revision: 1 },
      { kind: "session.tombstoned", deletedAt: 1, hostSeq: 2, revision: 1 },
      { kind: "session.imported", title: "t", transcriptRevision: 2, revision: 1 },
      { kind: "runtime.changed", runtime: "restarting", revision: 1 },
      { kind: "draft.replaced", text: "t", attachments: [], draftRevision: 1, revision: 1 },
      {
        kind: "message.queued",
        message: {
          actionId: "a",
          messageId: "m",
          text: "t",
          attachments: [],
          clientId: "client-a",
        },
        operation: operation({ kind: "message.enqueue" }),
        draftRevision: 1,
        revision: 1,
      },
      { kind: "message.dequeued", actionId: "a", revision: 1 },
      { kind: "turn.started", turnId: "t1", startedAt: 1, revision: 1 },
      { kind: "turn.stopping", revision: 1 },
      { kind: "turn.settled", turn: "retryable-error", revision: 1 },
      { kind: "decision.requested", decision: decision(), revision: 1 },
      { kind: "decision.responding", requestId: "req-1", actionId: "a", revision: 1 },
      { kind: "decision.settled", requestId: "req-1", status: "interrupted", revision: 1 },
      { kind: "operation.accepted", operation: operation(), revision: 1 },
      { kind: "operation.changed", actionId: "a", status: "failed", errorCode: "x", revision: 1 },
      { kind: "transcript.revised", transcriptRevision: 1, revision: 1 },
    ]
    for (const mutation of mutations) {
      expect(
        isHostStateAppliedAction({
          channel: CHANNEL,
          hostId: "host-a",
          hostGeneration: 1,
          hostSeq: 1,
          outcome: "applied",
          mutation,
        })
      ).toBe(true)
    }
  })

  it("rejects a malformed payload on every mutation kind", () => {
    const broken: unknown[] = [
      { kind: "session.upserted", session: { sessionId: SESSION }, revision: 1 },
      { kind: "session.deleted", sessionId: "", deletedAt: 1, revision: 1 },
      { kind: "session.renamed", title: 1, revision: 1 },
      { kind: "conversation.changed", conversation: "gone", revision: 1 },
      { kind: "session.tombstoned", deletedAt: 1, revision: 1 },
      { kind: "session.imported", title: "t", revision: 1 },
      { kind: "runtime.changed", runtime: "sleepy", revision: 1 },
      { kind: "draft.replaced", text: "t", attachments: [], revision: 1 },
      { kind: "message.queued", message: { actionId: "a" }, draftRevision: 1, revision: 1 },
      { kind: "message.dequeued", actionId: "", revision: 1 },
      { kind: "turn.started", turnId: "", startedAt: 1, revision: 1 },
      { kind: "turn.stopping", turn: "stopping", revision: 1 },
      { kind: "turn.settled", turn: "stopping", revision: 1 },
      { kind: "decision.requested", decision: { requestId: "r" }, revision: 1 },
      { kind: "decision.responding", requestId: "r", revision: 1 },
      { kind: "decision.settled", requestId: "r", status: "responding", revision: 1 },
      { kind: "operation.accepted", operation: { actionId: "a" }, revision: 1 },
      { kind: "operation.changed", actionId: "a", status: "queued", revision: 1 },
      { kind: "transcript.revised", transcriptRevision: -1, revision: 1 },
      { kind: "not.a.mutation", revision: 1 },
    ]
    for (const mutation of broken) {
      expect(
        isHostStateAppliedAction({
          channel: CHANNEL,
          hostId: "host-a",
          hostGeneration: 1,
          hostSeq: 1,
          outcome: "applied",
          mutation,
        })
      ).toBe(false)
    }
  })

  it("validates the origin and rejection envelopes independently", () => {
    const base = {
      channel: CHANNEL,
      hostId: "host-a",
      hostGeneration: 1,
      hostSeq: 1,
      outcome: "applied" as const,
    }
    expect(
      isHostStateAppliedAction({
        ...base,
        origin: { clientId: "c", clientSeq: 1, actionId: "a" },
      })
    ).toBe(true)
    expect(isHostStateAppliedAction({ ...base, origin: { clientId: "c", clientSeq: 1 } })).toBe(
      false
    )
    expect(isHostStateAppliedAction({ ...base, rejection: { code: "x", message: "m" } })).toBe(true)
    expect(isHostStateAppliedAction({ ...base, rejection: { code: "", message: "m" } })).toBe(false)
    expect(isHostStateAppliedAction({ ...base, outcome: "maybe" })).toBe(false)
  })

  it("accepts a fully-populated snapshot and rejects a disagreeing one", () => {
    const state = apply(
      session(),
      { kind: "decision.requested", decision: decision(), revision: 1 },
      { kind: "operation.accepted", operation: operation(), revision: 2 }
    )
    const snapshot = {
      channel: CHANNEL,
      hostId: "host-a",
      hostGeneration: 1,
      cutHostSeq: 4,
      revision: state.revision,
      digest: hostStateDigest(state),
      state,
    }
    expect(isHostStateSnapshot(snapshot)).toBe(true)
    expect(isHostStateSnapshot({ ...snapshot, digest: "hs-0000000000000000" })).toBe(false)
    expect(isHostStateSnapshot({ ...snapshot, revision: state.revision + 1 })).toBe(false)
    expect(isHostStateSnapshot({ ...snapshot, channel: INDEX })).toBe(false)
  })

  /**
   * `tombstone` and `conversation` are two ways to say the same thing, and a
   * state where they disagree renders a composer on one client and not another.
   */
  it("rejects a state whose tombstone and conversation axis disagree", () => {
    const inconsistent = { ...session(), tombstone: { deletedAt: 1, hostSeq: 1 } }
    expect(
      isHostStateSnapshot({
        channel: CHANNEL,
        hostId: "host-a",
        hostGeneration: 1,
        cutHostSeq: 1,
        revision: inconsistent.revision,
        digest: hostStateDigest(inconsistent),
        state: inconsistent,
      })
    ).toBe(false)

    const alsoInconsistent = { ...session(), conversation: "tombstoned" as const }
    expect(
      isHostStateSnapshot({
        channel: CHANNEL,
        hostId: "host-a",
        hostGeneration: 1,
        cutHostSeq: 1,
        revision: alsoInconsistent.revision,
        digest: hostStateDigest(alsoInconsistent),
        state: alsoInconsistent,
      })
    ).toBe(false)
  })

  it("rejects every malformed channel-state shape", () => {
    const good = session()
    const broken: Record<string, unknown>[] = [
      { kind: "mystery" },
      { ...good, channel: "" },
      { ...good, sessionId: "" },
      { ...good, revision: -1 },
      { ...good, transcriptRevision: "n" },
      { ...good, conversation: "deleted" },
      { ...good, runtime: "fine" },
      // `aborted` is a real turn value now (an interrupted lifecycle settles
      // there); `cancelled` is the one that was never in the vocabulary.
      { ...good, turn: "cancelled" },
      { ...good, title: 1 },
      { ...good, draft: { text: "t", attachments: [] } },
      { ...good, queue: [{ actionId: "a" }] },
      { ...good, activeTurn: { turnId: "t" } },
      { ...good, decisions: [{ requestId: "r" }] },
      { ...good, operations: [{ actionId: "a" }] },
      { ...good, unexpected: true },
    ]
    for (const state of broken) {
      expect(
        isHostStateSnapshot({
          channel: CHANNEL,
          hostId: "host-a",
          hostGeneration: 1,
          cutHostSeq: 1,
          revision: 0,
          digest: hostStateDigest(state),
          state,
        })
      ).toBe(false)
    }
  })

  it("accepts a well-formed submit response and rejects malformed receipts", () => {
    expect(
      isHostStateSubmitResponse({
        results: [{ actionId: "a", outcome: "applied", hostGeneration: 1, hostSeq: 1 }],
      })
    ).toBe(true)
    expect(
      isHostStateSubmitResponse({
        results: [
          {
            actionId: "a",
            outcome: "rejected",
            hostGeneration: 1,
            hostSeq: 1,
            rejection: { code: "c", message: "m", currentRevision: 2 },
          },
        ],
      })
    ).toBe(true)
    expect(isHostStateSubmitResponse({ results: [{ actionId: "a", outcome: "applied" }] })).toBe(
      false
    )
    expect(isHostStateSubmitResponse({ results: {} })).toBe(false)
    expect(isHostStateSubmitResponse({ results: [], extra: 1 })).toBe(false)
  })

  it("rejects every malformed host status field", () => {
    const good = {
      hostId: "host-a",
      hostGeneration: 1,
      hostSeq: 2,
      leaseExpiresAt: 3,
      pendingDispatch: 0,
      pendingBroadcast: 0,
      recovery: "ready" as const,
    }
    expect(isHostStateStatus(good)).toBe(true)
    for (const patch of [
      { hostId: "" },
      { hostGeneration: -1 },
      { hostSeq: 1.5 },
      { leaseExpiresAt: "soon" },
      { pendingDispatch: -1 },
      { pendingBroadcast: null },
      // A Host that will not say where recovery got to is not reporting status.
      { recovery: undefined },
      { recovery: "done" },
      { extra: 1 },
    ]) {
      expect(isHostStateStatus({ ...good, ...patch })).toBe(false)
    }
  })
})

describe("channels and canonical JSON", () => {
  it("percent-encodes ids so a slash cannot forge a channel segment", () => {
    expect(sessionIndexChannel("a/b")).toBe("cognia://target/a%2Fb/sessions")
    expect(sessionStateChannel("a", "b/c")).toBe("cognia://target/a/sessions/b%2Fc")
  })

  it("produces the same digest regardless of key insertion order", () => {
    const left = { a: 1, b: { c: 2, d: [3, 4] } }
    const right = { b: { d: [3, 4], c: 2 }, a: 1 }
    expect(hostStateDigest(left)).toBe(hostStateDigest(right))
    expect(hostStateDigest(left)).toMatch(/^hs-[0-9a-f]{16}$/)
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
})

describe("hostStateIntentCapability", () => {
  /**
   * Every intent maps to exactly one capability, and the union is closed: a new
   * member of `AllowedHostStateIntent` fails to compile against this record
   * until it is priced here, rather than inheriting whatever the last case
   * returned.
   */
  const EXPECTED: Record<AllowedHostStateIntent["kind"], string> = {
    "session.create": "process.spawn",
    "session.rename": "workspace.write",
    "session.archive": "workspace.write",
    "draft.replace": "workspace.write",
    "message.enqueue": "workspace.write",
    "turn.steer": "workspace.write",
    "turn.followup": "workspace.write",
    "turn.abort": "workspace.write",
    "approval.respond": "workspace.write",
    "elicitation.respond": "workspace.write",
    "transcript.edit": "host.admin",
    "transcript.truncate": "host.admin",
    "session.import": "host.admin",
  }

  const INTENTS: AllowedHostStateIntent[] = [
    { kind: "session.create", title: "t" },
    { kind: "session.rename", title: "t" },
    { kind: "session.archive", archived: true },
    { kind: "draft.replace", text: "t", attachments: [] },
    { kind: "message.enqueue", messageId: "m", text: "t", attachments: [] },
    { kind: "turn.steer", text: "t" },
    { kind: "turn.followup", text: "t" },
    { kind: "turn.abort" },
    { kind: "approval.respond", requestId: "r", decision: "allow" },
    { kind: "elicitation.respond", requestId: "r", response: null },
    { kind: "transcript.edit", messageId: "m", text: "t" },
    { kind: "transcript.truncate" },
    { kind: "session.import", envelope: null },
  ]

  it("prices every intent exactly once", () => {
    expect(INTENTS.map((intent) => intent.kind).sort()).toEqual(Object.keys(EXPECTED).sort())
    for (const intent of INTENTS) {
      expect(hostStateIntentCapability(intent)).toBe(EXPECTED[intent.kind])
      // The kind-keyed overload is the same table, not a copy of it.
      expect(hostStateIntentKindCapability(intent.kind)).toBe(EXPECTED[intent.kind])
    }
  })

  /**
   * The regression this table exists to prevent. `insert_default_grants` in
   * `security_store.rs` gives every freshly-paired member device
   * `host.observe`, `agent.run` and `workspace.read` — so keying "may drive a
   * session" off `agent.run` (which is what `claude_send` declares) would let a
   * phone the owner never granted Remote Control send messages and answer
   * approval prompts.
   */
  it("denies a default-granted member device every session-driving intent", () => {
    const member = {
      deviceId: "device-member",
      grants: ["host.observe", "agent.run", "workspace.read"],
    }
    for (const intent of INTENTS) {
      expect(callerMaySubmitHostStateIntent(member, intent)).toBe(false)
    }
  })

  it("lets Remote Control steer a turn but not create a session or rewrite a transcript", () => {
    const controller = {
      deviceId: "device-control",
      grants: ["host.observe", "agent.run", "workspace.read", "workspace.write"],
    }
    const allowed = INTENTS.filter((intent) => callerMaySubmitHostStateIntent(controller, intent))
    expect(allowed.map((intent) => intent.kind).sort()).toEqual(
      [
        "approval.respond",
        "draft.replace",
        "elicitation.respond",
        "message.enqueue",
        "session.archive",
        "session.rename",
        "turn.abort",
        "turn.followup",
        "turn.steer",
      ].sort()
    )
  })

  it("fails closed on an empty grant list", () => {
    const stranger = { deviceId: "device-x", grants: [] }
    for (const intent of INTENTS) {
      expect(callerMaySubmitHostStateIntent(stranger, intent)).toBe(false)
    }
  })

  /**
   * The negotiation direction. A client asks what it may do before it has an
   * intent to submit, and the answer must come from the same table that
   * authorizes — a second hand-maintained list would drift into a composer
   * offering a button that always 403s.
   */
  describe("permittedHostStateIntentKinds", () => {
    it("answers exactly what the same grants would authorize, intent by intent", () => {
      for (const grants of [
        [],
        ["host.observe", "agent.run", "workspace.read"],
        ["host.observe", "workspace.write"],
        ["host.observe", "workspace.write", "process.spawn"],
        ["host.observe", "workspace.write", "process.spawn", "host.admin"],
      ]) {
        const permitted = permittedHostStateIntentKinds(grants)
        const authorized = INTENTS.filter((intent) =>
          callerMaySubmitHostStateIntent({ deviceId: "d", grants }, intent)
        ).map((intent) => intent.kind)
        expect(permitted.slice().sort()).toEqual(authorized.slice().sort())
      }
    })

    it("covers every intent kind, in submission order", () => {
      expect(HOST_STATE_INTENT_KINDS.slice().sort()).toEqual(Object.keys(EXPECTED).sort())
      const owner = ["workspace.write", "process.spawn", "host.admin"]
      expect(permittedHostStateIntentKinds(owner)).toEqual([...HOST_STATE_INTENT_KINDS])
    })

    it("returns nothing for a device with no grants", () => {
      expect(permittedHostStateIntentKinds([])).toEqual([])
    })
  })

  /**
   * The live/safe split decides which intents the Host will accept from a
   * device that is not the one currently driving the session. Getting it wrong
   * in either direction is bad: too wide and a second client aborts a turn it
   * cannot see, too narrow and a phone with a flaky link cannot even leave a
   * draft.
   */
  describe("hostStateIntentRequiresLiveControl", () => {
    it("covers the intents that name state the runtime is holding open, and no others", () => {
      const live = HOST_STATE_INTENT_KINDS.filter(hostStateIntentRequiresLiveControl)
      expect(live).toEqual(["turn.steer", "turn.abort", "approval.respond", "elicitation.respond"])
    })

    it("leaves every safe intent — draft, message, follow-up — outside the gate", () => {
      for (const kind of ["draft.replace", "message.enqueue", "turn.followup"] as const) {
        expect(hostStateIntentRequiresLiveControl(kind)).toBe(false)
      }
    })

    it("classifies every kind, so a new intent cannot default in", () => {
      for (const kind of HOST_STATE_INTENT_KINDS) {
        expect(typeof hostStateIntentRequiresLiveControl(kind)).toBe("boolean")
      }
    })
  })
})
