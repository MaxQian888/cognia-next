import type { NotificationInput, NotificationRecord } from "@/types/notifications"

import type {
  CollabNotification,
  CollabNotificationPage,
  ListCollabNotificationsQuery,
  MarkCollabNotificationsReadInput,
} from "./client"
import type { CollabNotificationSignal } from "./feed"
import {
  COLLAB_NOTIFICATION_REF_KIND,
  __resetCollabNotificationsSyncForTesting,
  collabNotificationInput,
  collabNotificationLogicalKey,
  collabNotificationsStateKey,
  collabRefOf,
  describeCollabNotification,
  installCollabNotificationReadPropagation,
  installCollabNotificationsSync,
  levelForCollabNotification,
  loadCollabNotificationsState,
  pullCollabNotifications,
  queueCollabNotificationReads,
  sharedSessionLocalId,
  updateCollabNotificationsState,
  type CollabNotificationsClient,
  type CollabNotificationsScope,
  type CollabNotificationsSyncDeps,
  type DescribeCollabNotificationDeps,
} from "./notifications-sync"

jest.mock("@cognia/logging", () => ({
  loggers: { shell: { info: jest.fn(), warn: jest.fn() } },
}))

// The store's persistence: the read-propagation tests drive the real store.
const mockPatchNotification = jest.fn(async () => undefined)
jest.mock("@/lib/db/notifications", () => ({
  listNotifications: jest.fn(async () => []),
  getNotification: jest.fn(async () => undefined),
  patchNotification: (...args: unknown[]) => mockPatchNotification(...(args as [])),
  deleteNotification: jest.fn(async () => undefined),
  clearNotifications: jest.fn(async () => undefined),
}))
jest.mock("@/lib/notifications/recurring-compaction", () => ({
  ensureRecurringNotificationsCompacted: jest.fn(async () => undefined),
}))

import { useNotificationStore } from "@/stores/notifications/notification-store"

const ORG = "org_acme"
const ENDPOINT = "https://collab.test"
const ME = "usr_me"
const BOB = "usr_bob"

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

function row(seq: number, over: Partial<CollabNotification> = {}): CollabNotification {
  return {
    id: `ntf_${seq}`,
    kind: "issue.assigned",
    workspaceId: "ws_1",
    subject: { entity: "issue", id: `iss_${seq}` },
    actorUserId: BOB,
    dedupeKey: `issue.assigned:iss_${seq}:rev1`,
    seq,
    createdAt: 1_000 + seq,
    readAt: null,
    ...over,
  }
}

/**
 * A server double with the real contract's paging: rows after `afterSeq`
 * oldest first, reads after `(readAt, readSeq)` ordered by `(readAt, seq)`.
 */
function fakeServer(options: { limit?: number; replay?: boolean } = {}) {
  const rows: CollabNotification[] = []
  const listCalls: ListCollabNotificationsQuery[] = []
  const markCalls: MarkCollabNotificationsReadInput[] = []
  let failList: Error | null = null
  let failMark: Error | null = null
  let gate: Promise<void> | null = null

  const client: CollabNotificationsClient = {
    baseUrl: ENDPOINT,
    identity: jest.fn(async (orgId: string) => ({ userId: ME, orgId })),
    listNotifications: jest.fn(async (_orgId: string, query: ListCollabNotificationsQuery) => {
      listCalls.push(query)
      if (gate) await gate
      if (failList) throw failList
      const limit = Math.min(options.limit ?? query.limit ?? 100, query.limit ?? 100)
      const after = rows.filter((r) => r.seq > query.afterSeq).sort((a, b) => a.seq - b.seq)
      const page = after.slice(0, limit)
      const reads = rows
        .filter((r) => r.readAt !== null)
        .map((r) => ({ id: r.id, seq: r.seq, readAt: r.readAt! }))
        .filter(
          (r) => r.readAt > query.readAt || (r.readAt === query.readAt && r.seq > query.readSeq)
        )
        .sort((a, b) => a.readAt - b.readAt || a.seq - b.seq)
      const readPage = reads.slice(0, limit)
      const lastRead = readPage.at(-1)
      const answer: CollabNotificationPage = {
        // `replay` hands back rows at or below the cursor too, like a server
        // (or a racing tab) that ignores it; the client must not re-deliver.
        notifications: options.replay
          ? [...rows.filter((r) => r.seq <= query.afterSeq), ...page]
          : page,
        nextAfterSeq: page.at(-1)?.seq ?? query.afterSeq,
        hasMore: after.length > limit,
        reads: readPage,
        readCursor: lastRead
          ? { at: lastRead.readAt, seq: lastRead.seq }
          : { at: query.readAt, seq: query.readSeq },
        readsHaveMore: reads.length > limit,
      }
      return answer
    }),
    markNotificationsRead: jest.fn(
      async (_orgId: string, input: MarkCollabNotificationsReadInput) => {
        markCalls.push(input)
        if (failMark) throw failMark
        return { marked: "ids" in input ? input.ids.length : 0 }
      }
    ),
  }
  return {
    rows,
    client,
    listCalls,
    markCalls,
    failList: (error: Error | null) => {
      failList = error
    },
    failMark: (error: Error | null) => {
      failMark = error
    },
    hold: () => {
      let open!: () => void
      gate = new Promise((done) => {
        open = () => {
          gate = null
          done()
        }
      })
      return open
    },
  }
}

const SCOPE = (account: string): CollabNotificationsScope => ({
  localAccountId: account,
  endpoint: ENDPOINT,
  orgId: ORG,
})

function harness(account: string, server = fakeServer()) {
  const local = memoryStorage()
  const delivered: NotificationInput[] = []
  const localRecords = new Map<string, NotificationRecord>()
  const marked: string[] = []
  const deps: CollabNotificationsSyncDeps = {
    local,
    resolve: async () => ({ client: server.client, orgId: ORG }),
    notify: jest.fn(async (input: NotificationInput) => {
      delivered.push(input)
      return `rec_${input.sourceRef!.id}`
    }),
    findLocal: async (collabId) => localRecords.get(collabId),
    markLocalRead: async (record) => {
      marked.push(record.id)
    },
    describe: async (r) => ({ title: `title ${r.id}`, body: `body ${r.id}`, href: `/x/${r.id}` }),
    now: () => 5_000,
  }
  return { server, local, delivered, localRecords, marked, deps, scope: SCOPE(account) }
}

function record(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "rec_1",
    source: "collab",
    level: "info",
    title: "t",
    createdAt: 1,
    updatedAt: 1,
    readState: "unseen",
    count: 1,
    directed: true,
    deliveredVia: ["center"],
    sourceRef: { kind: COLLAB_NOTIFICATION_REF_KIND, id: "ntf_1" },
    meta: { collabOrgId: ORG, collabEndpoint: ENDPOINT },
    ...over,
  }
}

beforeEach(() => {
  __resetCollabNotificationsSyncForTesting()
  mockPatchNotification.mockClear()
  useNotificationStore.setState({ items: [], directedUnread: 0, ambientUnseen: 0 })
})

describe("persisted state", () => {
  it("is empty until written, and keeps account, server and org apart", () => {
    const storage = memoryStorage()
    const a = SCOPE("acct-a")
    expect(loadCollabNotificationsState(a, { local: storage })).toEqual({
      cursor: null,
      pendingReadIds: [],
    })
    updateCollabNotificationsState(
      a,
      (state) => ({ ...state, cursor: { afterSeq: 4, readAt: 9, readSeq: 2 } }),
      { local: storage }
    )
    expect(loadCollabNotificationsState(a, { local: storage }).cursor).toEqual({
      afterSeq: 4,
      readAt: 9,
      readSeq: 2,
    })
    expect(loadCollabNotificationsState(SCOPE("acct-b"), { local: storage }).cursor).toBeNull()
    expect(
      loadCollabNotificationsState({ ...a, orgId: "org_other" }, { local: storage }).cursor
    ).toBeNull()
    expect(
      loadCollabNotificationsState({ ...a, endpoint: "https://other.test" }, { local: storage })
        .cursor
    ).toBeNull()
  })

  it("drops a record that no longer parses, which makes the next pull a quiet first one", () => {
    const storage = memoryStorage()
    const key = collabNotificationsStateKey(SCOPE("acct-bad"))
    storage.setItem(key, JSON.stringify({ cursor: { afterSeq: "x" } }))
    expect(loadCollabNotificationsState(SCOPE("acct-bad"), { local: storage })).toEqual({
      cursor: null,
      pendingReadIds: [],
    })
    expect(storage.getItem(key)).toBeNull()
    storage.setItem(key, "not json")
    expect(loadCollabNotificationsState(SCOPE("acct-bad"), { local: storage }).cursor).toBeNull()
  })

  it("dedupes and bounds the pending reads", () => {
    const storage = memoryStorage()
    queueCollabNotificationReads(SCOPE("acct-q"), ["a", "b"], { local: storage })
    queueCollabNotificationReads(SCOPE("acct-q"), ["b", "c"], { local: storage })
    expect(
      loadCollabNotificationsState(SCOPE("acct-q"), { local: storage }).pendingReadIds
    ).toEqual(["a", "b", "c"])
  })
})

describe("presentation", () => {
  const translate = (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${JSON.stringify(values)})` : key

  function describeDeps(over: Partial<DescribeCollabNotificationDeps> = {}) {
    return {
      translate,
      issueTitle: async (id: string) => (id === "iss_1" ? "Fix the login race" : undefined),
      actorName: async (id: string) => (id === BOB ? "Bob" : undefined),
      sharedSession: async () => ({}),
      ...over,
    }
  }
  const context = { orgId: ORG, endpoint: ENDPOINT }

  it("names the actor and the issue from the mirrors, linking to the shared issue", async () => {
    await expect(describeCollabNotification(row(1), context, describeDeps())).resolves.toEqual({
      title: 'issueAssignedTitle({"actor":"Bob"})',
      body: "Fix the login race",
      href: "/issues?id=iss_1&source=collab",
    })
  })

  it("falls back to generic wording when the mirrors do not know, or fail", async () => {
    const described = await describeCollabNotification(
      row(2, { kind: "issue.mentioned", actorUserId: "usr_stranger" }),
      context,
      describeDeps({
        issueTitle: async () => {
          throw new Error("mirror closed")
        },
      })
    )
    expect(described).toEqual({
      title: 'issueMentionedTitle({"actor":"someone"})',
      body: "issueFallback",
      href: "/issues?id=iss_2&source=collab",
    })
  })

  it("opens the local projection of a shared session for an approval request", async () => {
    const approval = row(3, {
      kind: "chat.approval_requested",
      subject: { entity: "chat_session", id: "ses_9" },
    })
    await expect(
      describeCollabNotification(
        approval,
        context,
        describeDeps({
          sharedSession: async () => ({ localSessionId: "shared:abc", title: "Release war room" }),
        })
      )
    ).resolves.toEqual({
      title: 'approvalRequestedTitle({"actor":"Bob"})',
      body: "Release war room",
      href: "/?session=shared%3Aabc",
    })
    // Not projected yet: the id the projection will get once it is synced.
    const unprojected = await describeCollabNotification(approval, context, describeDeps())
    expect(unprojected.body).toBe("approvalRequestedFallback")
    expect(unprojected.href).toBe(
      `/?session=${encodeURIComponent(sharedSessionLocalId(ORG, "ses_9", ENDPOINT))}`
    )
  })

  it("sends an invitation to the accept link on the conversation route", async () => {
    await expect(
      describeCollabNotification(
        row(4, { kind: "chat.invited", subject: { entity: "chat_invite", id: "inv_7" } }),
        context,
        describeDeps()
      )
    ).resolves.toEqual({
      title: 'invitedTitle({"actor":"Bob"})',
      body: "invitedBody",
      href: `/?acceptInvite=inv_7&org=${ORG}`,
    })
  })

  it("still says something for a kind this build does not know", async () => {
    const future = row(5, {
      kind: "org.invited" as CollabNotification["kind"],
      subject: { entity: "org" as never, id: "org_x" },
    })
    const described = await describeCollabNotification(future, context, describeDeps())
    expect(described.title).toBe('genericTitle({"actor":"Bob"})')
    expect(described.href).toBeUndefined()
  })

  it("warns for an approval request and informs for everything else", () => {
    expect(levelForCollabNotification({ kind: "chat.approval_requested" })).toBe("warning")
    expect(levelForCollabNotification({ kind: "issue.assigned" })).toBe("info")
    expect(levelForCollabNotification({ kind: "chat.invited" })).toBe("info")
  })

  it("builds the notify input ADR-0207 §4 lays out", () => {
    const input = collabNotificationInput(
      row(6, { kind: "chat.approval_requested" }),
      { title: "T", body: "B", href: "/h" },
      { orgId: ORG, endpoint: ENDPOINT, quiet: false }
    )
    expect(input).toEqual({
      source: "collab",
      level: "warning",
      title: "T",
      body: "B",
      href: "/h",
      dedupeKey: "issue.assigned:iss_6:rev1",
      logicalKey: collabNotificationLogicalKey("ntf_6"),
      groupKey: "collab:issue:iss_6",
      sourceRef: { kind: "collab-notification", id: "ntf_6" },
      directed: true,
      projectId: "ws_1",
      meta: {
        collabOrgId: ORG,
        collabEndpoint: ENDPOINT,
        collabKind: "chat.approval_requested",
        collabSeq: 6,
      },
    })
    expect(
      collabNotificationInput(
        row(7),
        { title: "T", body: "B" },
        { orgId: ORG, endpoint: ENDPOINT, quiet: true }
      ).channels
    ).toEqual(["center"])
  })
})

describe("pullCollabNotifications", () => {
  it("imports the first pull's unread backlog quietly and skips rows already read", async () => {
    const h = harness("acct-first")
    h.server.rows.push(row(1), row(2, { readAt: 1_500 }), row(3))

    const result = await pullCollabNotifications("acct-first", h.deps)

    expect(result).toMatchObject({ status: "pulled", quiet: true, delivered: 2, userId: ME })
    expect(h.delivered.map((input) => input.sourceRef?.id)).toEqual(["ntf_1", "ntf_3"])
    for (const input of h.delivered) expect(input.channels).toEqual(["center"])
    expect(loadCollabNotificationsState(h.scope, { local: h.local }).cursor).toEqual({
      afterSeq: 3,
      readAt: 1_500,
      readSeq: 2,
    })
  })

  it("delivers later rows through the person's channels, never handing a row over twice", async () => {
    const h = harness("acct-replay", fakeServer({ replay: true }))
    h.server.rows.push(row(1))
    await pullCollabNotifications("acct-replay", h.deps)
    h.server.rows.push(row(2))

    const result = await pullCollabNotifications("acct-replay", h.deps)

    expect(result).toMatchObject({ status: "pulled", quiet: false, delivered: 1 })
    // The replayed row 1 is at the cursor and is not handed over again.
    expect(h.delivered.map((input) => input.sourceRef?.id)).toEqual(["ntf_1", "ntf_2"])
    expect(h.delivered[1]!.channels).toBeUndefined()
    expect(h.delivered[1]!.dedupeKey).toBe("issue.assigned:iss_2:rev1")
  })

  it("pages rows and reads until the server has no more", async () => {
    const h = harness("acct-pages", fakeServer({ limit: 2 }))
    for (let seq = 1; seq <= 5; seq += 1) h.server.rows.push(row(seq))
    await pullCollabNotifications("acct-pages", h.deps)
    expect(h.delivered).toHaveLength(5)

    // Five reads arrive: paged two at a time, all applied.
    for (const r of h.server.rows) r.readAt = 2_000 + r.seq
    for (let seq = 1; seq <= 5; seq += 1) {
      h.localRecords.set(`ntf_${seq}`, record({ id: `rec_${seq}` }))
    }
    const result = await pullCollabNotifications("acct-pages", h.deps)
    expect(result).toMatchObject({ readsApplied: 5 })
    expect(h.marked).toEqual(["rec_1", "rec_2", "rec_3", "rec_4", "rec_5"])
    expect(loadCollabNotificationsState(h.scope, { local: h.local }).cursor).toEqual({
      afterSeq: 5,
      readAt: 2_005,
      readSeq: 5,
    })
  })

  it("leaves the cursor untouched when the pull fails", async () => {
    const h = harness("acct-fail")
    h.server.rows.push(row(1))
    await pullCollabNotifications("acct-fail", h.deps)
    const before = loadCollabNotificationsState(h.scope, { local: h.local })
    h.server.rows.push(row(2))
    h.server.failList(new Error("503"))

    await expect(pullCollabNotifications("acct-fail", h.deps)).resolves.toMatchObject({
      status: "failed",
    })
    expect(loadCollabNotificationsState(h.scope, { local: h.local })).toEqual(before)

    h.server.failList(null)
    await pullCollabNotifications("acct-fail", h.deps)
    expect(h.delivered.map((input) => input.sourceRef?.id)).toEqual(["ntf_1", "ntf_2"])
  })

  it("advances only past rows handed over when the hand-over fails half way", async () => {
    const h = harness("acct-half")
    h.server.rows.push(row(1), row(2), row(3))
    let calls = 0
    h.deps.notify = jest.fn(async (input: NotificationInput) => {
      calls += 1
      if (calls === 2) throw new Error("dexie closed")
      h.delivered.push(input)
      return "rec"
    })

    await expect(pullCollabNotifications("acct-half", h.deps)).resolves.toMatchObject({
      status: "failed",
    })
    expect(loadCollabNotificationsState(h.scope, { local: h.local }).cursor?.afterSeq).toBe(1)

    await pullCollabNotifications("acct-half", h.deps)
    // Row 1 is not replayed; rows 2 and 3 arrive once each.
    expect(h.delivered.map((input) => input.sourceRef?.id)).toEqual(["ntf_1", "ntf_2", "ntf_3"])
  })

  it("skips quietly when collaboration is not configured", async () => {
    const h = harness("acct-none")
    h.deps.resolve = async () => null
    await expect(pullCollabNotifications("acct-none", h.deps)).resolves.toEqual({
      status: "skipped",
    })
    expect(h.local.map.size).toBe(0)
  })

  it("coalesces: one pull in flight and one queued rerun", async () => {
    const h = harness("acct-coalesce")
    h.server.rows.push(row(1))
    const open = h.server.hold()
    const first = pullCollabNotifications("acct-coalesce", h.deps)
    const second = pullCollabNotifications("acct-coalesce", h.deps)
    const third = pullCollabNotifications("acct-coalesce", h.deps)
    expect(second).toBe(third)
    // Let the first pull reach the held request, then add a row it has listed past.
    await new Promise((done) => setTimeout(done, 0))
    open()
    await first
    h.server.rows.push(row(2))
    await Promise.all([second, third])

    expect(h.server.client.listNotifications).toHaveBeenCalledTimes(2)
    expect(h.delivered.map((input) => input.sourceRef?.id)).toEqual(["ntf_1", "ntf_2"])
  })

  it("posts queued local reads before pulling, and keeps them when the post fails", async () => {
    const h = harness("acct-pending")
    queueCollabNotificationReads(h.scope, ["ntf_8", "ntf_9"], { local: h.local })
    h.server.failMark(new Error("offline"))
    await pullCollabNotifications("acct-pending", h.deps)
    expect(loadCollabNotificationsState(h.scope, { local: h.local }).pendingReadIds).toEqual([
      "ntf_8",
      "ntf_9",
    ])

    h.server.failMark(null)
    await pullCollabNotifications("acct-pending", h.deps)
    expect(h.server.markCalls.at(-1)).toEqual({ ids: ["ntf_8", "ntf_9"] })
    expect(loadCollabNotificationsState(h.scope, { local: h.local }).pendingReadIds).toEqual([])
  })
})

describe("read propagation", () => {
  async function flushPromises() {
    for (let i = 0; i < 5; i += 1) await new Promise((done) => setTimeout(done, 0))
  }

  function propagation(account: string) {
    const local = memoryStorage()
    const flushed: CollabNotificationsScope[] = []
    const records = new Map<string, NotificationRecord>()
    const stop = installCollabNotificationReadPropagation(account, {
      local,
      flush: async (scope) => {
        flushed.push(scope)
      },
      getRecord: async (id) => records.get(id),
    })
    const pending = () => loadCollabNotificationsState(SCOPE(account), { local }).pendingReadIds
    return { local, flushed, records, stop, pending }
  }

  it("posts a collab record read in the center, and every one marked by mark-all-read", async () => {
    const p = propagation("acct-local-read")
    useNotificationStore.setState({
      items: [
        record({ id: "rec_1" }),
        record({ id: "rec_2", sourceRef: { kind: COLLAB_NOTIFICATION_REF_KIND, id: "ntf_2" } }),
        record({ id: "rec_x", source: "system", sourceRef: undefined, meta: undefined }),
      ],
    })

    await useNotificationStore.getState().markRead("rec_1")
    expect(p.pending()).toEqual(["ntf_1"])
    expect(p.flushed).toHaveLength(1)

    await useNotificationStore.getState().markAllRead()
    expect(p.pending()).toEqual(["ntf_1", "ntf_2"])
    p.stop()
  })

  it("posts an archived record and leaves a snoozed one alone", async () => {
    const p = propagation("acct-archive")
    useNotificationStore.setState({
      items: [
        record({ id: "rec_1" }),
        record({ id: "rec_2", sourceRef: { kind: COLLAB_NOTIFICATION_REF_KIND, id: "ntf_2" } }),
      ],
    })
    p.records.set("rec_1", record({ id: "rec_1", readState: "done" }))
    p.records.set(
      "rec_2",
      record({ id: "rec_2", sourceRef: { kind: COLLAB_NOTIFICATION_REF_KIND, id: "ntf_2" } })
    )

    await useNotificationStore.getState().markDone("rec_1")
    await useNotificationStore.getState().snooze("rec_2", 60_000)
    await flushPromises()

    expect(p.pending()).toEqual(["ntf_1"])
    p.stop()
  })

  it("does not echo a read that came from the server", async () => {
    const p = propagation("acct-echo")
    const h = harness("acct-echo")
    const local = record({ id: "rec_1" })
    useNotificationStore.setState({ items: [local] })
    h.localRecords.set("ntf_1", local)
    // Apply the server read through the store, the way the default does.
    h.deps.markLocalRead = async (rec) => {
      useNotificationStore.getState().ingest({ ...rec, readState: "read" })
    }
    h.server.rows.push(row(1, { readAt: 1_200 }))
    // Not a first pull: a cursor exists.
    updateCollabNotificationsState(
      h.scope,
      (state) => ({ ...state, cursor: { afterSeq: 1, readAt: 0, readSeq: 0 } }),
      { local: h.local }
    )

    await pullCollabNotifications("acct-echo", h.deps)
    await flushPromises()

    expect(useNotificationStore.getState().items[0]!.readState).toBe("read")
    expect(p.pending()).toEqual([])
    expect(p.flushed).toEqual([])
    expect(h.server.markCalls).toEqual([])
    p.stop()
  })

  it("stops watching once detached", async () => {
    const p = propagation("acct-stop")
    p.stop()
    useNotificationStore.setState({ items: [record({ id: "rec_1" })] })
    await useNotificationStore.getState().markRead("rec_1")
    expect(p.pending()).toEqual([])
  })

  it("reads the server id and scope only off collab records", () => {
    expect(collabRefOf(record())).toEqual({ id: "ntf_1", orgId: ORG, endpoint: ENDPOINT })
    expect(collabRefOf(record({ source: "issue" }))).toBeNull()
    expect(collabRefOf(record({ meta: {} }))).toBeNull()
  })
})

describe("installCollabNotificationsSync", () => {
  function target() {
    const listeners = new Map<string, () => void>()
    return {
      listeners,
      addEventListener: jest.fn((name: string, fn: () => void) => listeners.set(name, fn)),
      removeEventListener: jest.fn((name: string) => listeners.delete(name)),
    }
  }

  async function settle() {
    for (let i = 0; i < 5; i += 1) await new Promise((done) => setTimeout(done, 0))
  }

  it("pulls on boot, focus, online, becoming visible and a feed signal for this person", async () => {
    const h = harness("acct-install")
    const win = target()
    const doc = { ...target(), visibilityState: "visible" as DocumentVisibilityState }
    let signal!: (s: CollabNotificationSignal) => void
    const detachReads = jest.fn()
    const stop = installCollabNotificationsSync("acct-install", {
      ...h.deps,
      window: win as never,
      document: doc as never,
      subscribeSignals: (listener) => {
        signal = listener
        return () => undefined
      },
      installReadPropagation: () => detachReads,
    })
    const pulls = () => (h.server.client.identity as jest.Mock).mock.calls.length

    await settle()
    expect(pulls()).toBe(1)
    win.listeners.get("focus")!()
    await settle()
    win.listeners.get("online")!()
    await settle()
    doc.listeners.get("visibilitychange")!()
    await settle()
    expect(pulls()).toBe(4)

    signal({ reason: "frame", recipientUserId: ME, seq: 3 })
    await settle()
    signal({ reason: "connected" })
    await settle()
    expect(pulls()).toBe(6)

    // A frame addressed to somebody else asks for nothing.
    signal({ reason: "frame", recipientUserId: "usr_someone_else", seq: 3 })
    await settle()
    expect(pulls()).toBe(6)

    stop()
    expect(detachReads).toHaveBeenCalled()
    expect(win.listeners.size).toBe(0)
    expect(doc.listeners.size).toBe(0)
  })

  it("pulls on a frame arriving before this person's id is known", async () => {
    const h = harness("acct-early")
    h.deps.resolve = async () => null
    let signal!: (s: CollabNotificationSignal) => void
    const resolve = jest.fn(async () => null)
    const stop = installCollabNotificationsSync("acct-early", {
      ...h.deps,
      resolve,
      window: target() as never,
      document: { ...target(), visibilityState: "visible" } as never,
      subscribeSignals: (listener) => {
        signal = listener
        return () => undefined
      },
      installReadPropagation: () => () => undefined,
    })
    await settle()
    signal({ reason: "frame", recipientUserId: "usr_any", seq: 1 })
    await settle()
    expect(resolve).toHaveBeenCalledTimes(2)
    stop()
  })

  it("hands a feed frame from the registry to a pull", async () => {
    const { publishCollabNotificationSignal } = await import("./feed")
    const h = harness("acct-registry-pull")
    const stop = installCollabNotificationsSync("acct-registry-pull", {
      ...h.deps,
      window: target() as never,
      document: { ...target(), visibilityState: "visible" } as never,
      installReadPropagation: () => () => undefined,
    })
    await settle()
    h.server.rows.push(row(1))
    publishCollabNotificationSignal("acct-registry-pull", {
      reason: "frame",
      recipientUserId: ME,
      seq: 1,
    })
    await settle()
    expect(h.delivered.map((input) => input.sourceRef?.id)).toEqual(["ntf_1"])
    stop()
  })
})
