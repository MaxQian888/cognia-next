"use client"

/**
 * The client half of ADR-0207: collaboration notifications reach the local
 * notification center.
 *
 * # What it does
 *
 * The collaboration server keeps one row per recipient ("this was addressed to
 * you") with a per-recipient `seq` and a `readAt`. This module pulls those rows
 * after a cursor and hands each new one to the existing ADR-0042 `notify()`
 * pipe as source `"collab"`, so channel preferences, quiet hours, OS toasts,
 * mobile push and IM delivery all come from what already exists. It also
 * carries read state both ways: a row read on another device is marked read
 * here, and a row read here is posted back to the server.
 *
 * # The cursor
 *
 * Kept per local account, collaboration server and org: `{afterSeq}` for rows
 * and `{readAt, readSeq}` for reads, plus the ids of local reads the server
 * has not acknowledged yet. It lives in `localStorage`, next to the connection
 * it belongs to (`lib/collab/connection.ts` keeps the server URL the same way,
 * per account), so it needs no Dexie schema change. Every write goes through
 * {@link updateCollabNotificationsState}, a synchronous read-modify-write, so
 * a pull advancing the cursor and a local read queueing an id never overwrite
 * each other across an `await`.
 *
 * The cursor is the first guard against a replayed pull: rows at or below it
 * are never handed over. The row's `dedupeKey` is the second: a second tab
 * that races the cursor bumps the existing center record (`dedup.ts`) instead
 * of adding another. The cursor advances only past rows already handed over,
 * one page at a time; a failed request or a failed hand-over leaves it where
 * the last successful hand-over put it, so the next pull resumes there.
 *
 * # What is and is not toasted
 *
 * - The very first pull for an account+org (no cursor yet) imports the unread
 *   backlog quietly: `channels: ["center"]`, so it lands in the center and the
 *   badge without a toast storm, an OS banner or a push per row.
 * - A row that is already read on the server when this device first sees it
 *   is not imported at all. It was handled on another device; resurfacing it
 *   here as unread would be wrong, and importing it as read would only add
 *   history the person already dealt with. If a local record for it exists
 *   (a replay after a lost cursor), it is marked read.
 * - A server read never re-toasts: it only moves the local record to read.
 *
 * # Read propagation
 *
 * Server → local: `reads` (and rows that arrive with `readAt`) mark the local
 * record read through the notification store, WITHOUT posting back. The ids are
 * remembered as "known read on the server" first, so the store subscription
 * below sees the change and stays quiet.
 *
 * Local → server: a store subscription notices a `collab` record moving from
 * unread to read or done (mark read, mark all read, archive, archive all) and
 * queues its server id. The queue is persisted before the post, so a failed
 * post is retried at the start of the next pull.
 *
 * # Triggers
 *
 * {@link installCollabNotificationsSync} pulls on install (boot), window focus,
 * coming online, the page becoming visible, and on every ADR-0206 feed signal:
 * a `notification` frame for this person, or the socket (re)connecting.
 * Concurrent requests coalesce: one pull in flight, at most one queued rerun.
 */

import { loggers } from "@cognia/logging"

import type {
  NotificationInput,
  NotificationLevel,
  NotificationReadState,
  NotificationRecord,
} from "@/types/notifications"
import { cascadeReadState } from "@/lib/notifications/read-state"
import { buildSessionHref } from "@/lib/chat/message-permalink"
import { sharedChatCacheKey } from "@/lib/db/collab-chat-mirror"
import { issueHref } from "@/lib/issues/hrefs"
import { useNotificationStore } from "@/stores/notifications/notification-store"

import type { CollabClient, CollabNotification, CollabNotificationReadCursor } from "./client"
import { subscribeCollabNotificationSignals, type CollabNotificationSignal } from "./feed"
import { resolveCollabClient } from "./refresh"
import { targetedInviteHref } from "./targeted-invite-link"

const log = loggers.shell

/** The `sourceRef.kind` a center record for a collaboration row carries. */
export const COLLAB_NOTIFICATION_REF_KIND = "collab-notification"
/** The most rows (and reads) one request asks for; the server's ceiling. */
export const COLLAB_NOTIFICATION_PAGE_LIMIT = 200
/** The most ids one `read` call may name (the server's `MAX_READ_IDS`). */
export const COLLAB_NOTIFICATION_READ_BATCH = 500
/**
 * Pages one pull walks before it yields. Only a backlog this deep stops here,
 * and the next trigger carries on from the persisted cursor.
 */
export const COLLAB_NOTIFICATION_MAX_PAGES = 100
/**
 * Local reads waiting for the server, at most. Past this the oldest are
 * dropped: a read lost that way leaves the row unread on other devices, which
 * the person can clear there, while an unbounded queue would grow forever on a
 * profile whose server is gone.
 */
export const COLLAB_NOTIFICATION_MAX_PENDING_READS = 2_000

const STATE_KEY_PREFIX = "cognia.collab.notifications"
const NOTIFICATION_NAMESPACE = "notificationCenter.collab"

// ── Persisted state ───────────────────────────────────────────────────────

export interface CollabNotificationsCursor {
  /** Rows with `seq` at or below this were handed over. */
  afterSeq: number
  /** The read cursor: reads at or before `(readAt, readSeq)` were applied. */
  readAt: number
  readSeq: number
}

export interface CollabNotificationsState {
  /** Null until the first successful pull, which is what makes it "first". */
  cursor: CollabNotificationsCursor | null
  /** Server ids read locally and not yet acknowledged by the server. */
  pendingReadIds: string[]
}

/** Which cursor: one per local account, collaboration server and org. */
export interface CollabNotificationsScope {
  localAccountId: string
  /** The collaboration server's normalized base URL; org ids are per server. */
  endpoint: string
  orgId: string
}

/** Storage seam so tests need no `localStorage`. */
export interface CollabNotificationsStorageDeps {
  local?: Pick<Storage, "getItem" | "setItem" | "removeItem">
}

function storage(
  deps: CollabNotificationsStorageDeps
): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  if (deps.local) return deps.local
  if (typeof localStorage === "undefined") return null
  return localStorage
}

export function collabNotificationsStateKey(scope: CollabNotificationsScope): string {
  return `${STATE_KEY_PREFIX}.${scope.localAccountId}.${JSON.stringify([scope.endpoint, scope.orgId])}`
}

const EMPTY_STATE: CollabNotificationsState = { cursor: null, pendingReadIds: [] }

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/**
 * Read the persisted state. A record that no longer parses is removed and
 * reads as empty: the next pull is then a quiet first pull, which re-imports
 * the unread backlog without toasting it, rather than trusting half a cursor.
 */
export function loadCollabNotificationsState(
  scope: CollabNotificationsScope,
  deps: CollabNotificationsStorageDeps = {}
): CollabNotificationsState {
  const local = storage(deps)
  if (!local) return EMPTY_STATE
  const key = collabNotificationsStateKey(scope)
  const raw = local.getItem(key)
  if (!raw) return EMPTY_STATE
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object") throw new Error("not an object")
    const cursor = parsed.cursor as Record<string, unknown> | null | undefined
    let validCursor: CollabNotificationsCursor | null = null
    if (cursor !== null && cursor !== undefined) {
      if (
        !isFiniteNumber(cursor.afterSeq) ||
        !isFiniteNumber(cursor.readAt) ||
        !isFiniteNumber(cursor.readSeq)
      ) {
        throw new Error("malformed cursor")
      }
      validCursor = { afterSeq: cursor.afterSeq, readAt: cursor.readAt, readSeq: cursor.readSeq }
    }
    const pending = Array.isArray(parsed.pendingReadIds)
      ? parsed.pendingReadIds.filter((id): id is string => typeof id === "string" && id !== "")
      : []
    return { cursor: validCursor, pendingReadIds: pending }
  } catch {
    local.removeItem(key)
    return EMPTY_STATE
  }
}

/**
 * The only way the state is written: load, change, save, with no `await` in
 * between, so two writers (a pull, a local read) cannot lose each other's
 * change.
 */
export function updateCollabNotificationsState(
  scope: CollabNotificationsScope,
  change: (state: CollabNotificationsState) => CollabNotificationsState,
  deps: CollabNotificationsStorageDeps = {}
): CollabNotificationsState {
  const next = change(loadCollabNotificationsState(scope, deps))
  const pendingReadIds = [...new Set(next.pendingReadIds)].slice(
    -COLLAB_NOTIFICATION_MAX_PENDING_READS
  )
  const normalized: CollabNotificationsState = { cursor: next.cursor, pendingReadIds }
  storage(deps)?.setItem(collabNotificationsStateKey(scope), JSON.stringify(normalized))
  return normalized
}

// ── Echo suppression ──────────────────────────────────────────────────────

/** Server ids this process knows the server has as read. Bounded, oldest out. */
const knownReadOnServer = new Set<string>()
const KNOWN_READ_LIMIT = 5_000

function rememberReadOnServer(ids: Iterable<string>): void {
  for (const id of ids) {
    knownReadOnServer.delete(id)
    knownReadOnServer.add(id)
  }
  while (knownReadOnServer.size > KNOWN_READ_LIMIT) {
    const oldest = knownReadOnServer.values().next().value
    if (oldest === undefined) break
    knownReadOnServer.delete(oldest)
  }
}

/** Test seam: the echo set and pull slots are process-wide. */
export function __resetCollabNotificationsSyncForTesting(): void {
  knownReadOnServer.clear()
  pulls.clear()
}

// ── Presentation ──────────────────────────────────────────────────────────

export type CollabNotificationTranslate = (key: string, values?: Record<string, unknown>) => string

export interface DescribeCollabNotificationDeps {
  /** Scoped to `notificationCenter.collab`. */
  translate: CollabNotificationTranslate
  /** The issue's title from the collaboration mirror, when it holds the row. */
  issueTitle: (issueId: string) => Promise<string | undefined>
  /** A person's display name from the cached rosters, when known. */
  actorName: (userId: string) => Promise<string | undefined>
  /** What this device already knows about a shared session. */
  sharedSession: (input: {
    orgId: string
    sessionId: string
    endpoint: string
  }) => Promise<{ localSessionId?: string; title?: string }>
}

export interface CollabNotificationPresentation {
  title: string
  body: string
  /** Opens the subject; absent only for a subject entity this build does not know. */
  href?: string
}

/**
 * The id a shared session's local projection gets once it is synced
 * (`ensureLocalProjection` in `lib/collab/shared-chat-sync.ts`).
 */
export function sharedSessionLocalId(orgId: string, sessionId: string, endpoint: string): string {
  return `shared:${sharedChatCacheKey(orgId, sessionId, endpoint)}`
}

async function safely<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch {
    // A lookup is decoration: an unreadable mirror falls back to the generic
    // wording rather than losing the notification.
    return undefined
  }
}

/**
 * Title, body and link for one row. Titles come from this device's mirrors,
 * never from the row (which carries references only); anything unknown falls
 * back to generic localized wording.
 */
export async function describeCollabNotification(
  row: CollabNotification,
  context: { orgId: string; endpoint: string },
  deps: DescribeCollabNotificationDeps
): Promise<CollabNotificationPresentation> {
  const t = deps.translate
  const name = row.actorUserId ? await safely(() => deps.actorName(row.actorUserId!)) : undefined
  const actor = name || t("someone")

  let subjectTitle: string | undefined
  let href: string | undefined
  switch (row.subject.entity) {
    case "issue":
      subjectTitle = await safely(() => deps.issueTitle(row.subject.id))
      href = issueHref(row.subject.id, "collab")
      break
    case "chat_session": {
      const known = await safely(() =>
        deps.sharedSession({
          orgId: context.orgId,
          sessionId: row.subject.id,
          endpoint: context.endpoint,
        })
      )
      subjectTitle = known?.title
      // The conversation's route (`/?session=…`), the same link every other
      // "open this conversation" notification carries.
      href = `/${buildSessionHref(
        known?.localSessionId ??
          sharedSessionLocalId(context.orgId, row.subject.id, context.endpoint)
      )}`
      break
    }
    case "chat_invite":
      href = targetedInviteHref({ inviteId: row.subject.id, orgId: context.orgId })
      break
    default:
      href = undefined
  }

  switch (row.kind) {
    case "issue.assigned":
      return {
        title: t("issueAssignedTitle", { actor }),
        body: subjectTitle || t("issueFallback"),
        href,
      }
    case "issue.mentioned":
      return {
        title: t("issueMentionedTitle", { actor }),
        body: subjectTitle || t("issueFallback"),
        href,
      }
    case "chat.approval_requested":
      return {
        title: t("approvalRequestedTitle", { actor }),
        body: subjectTitle || t("approvalRequestedFallback"),
        href,
      }
    case "chat.invited":
      return { title: t("invitedTitle", { actor }), body: t("invitedBody"), href }
    default:
      // A kind added on the server after this build: still tell the person,
      // in words that promise nothing about what it is.
      return {
        title: t("genericTitle", { actor }),
        body: subjectTitle || t("issueFallback"),
        href,
      }
  }
}

/** `warning` for an approval request, since a run is blocked on it; `info` otherwise. */
export function levelForCollabNotification(
  row: Pick<CollabNotification, "kind">
): NotificationLevel {
  return row.kind === "chat.approval_requested" ? "warning" : "info"
}

/** The center record's `logicalKey` for one server row; indexed, so lookups are direct. */
export function collabNotificationLogicalKey(id: string): string {
  return `${COLLAB_NOTIFICATION_REF_KIND}:${id}`
}

/** The `notify()` input for one row, exactly as ADR-0207 §4 lays it out. */
export function collabNotificationInput(
  row: CollabNotification,
  presentation: CollabNotificationPresentation,
  context: { orgId: string; endpoint: string; quiet: boolean }
): NotificationInput {
  return {
    source: "collab",
    level: levelForCollabNotification(row),
    title: presentation.title,
    body: presentation.body,
    ...(presentation.href ? { href: presentation.href } : {}),
    dedupeKey: row.dedupeKey,
    logicalKey: collabNotificationLogicalKey(row.id),
    groupKey: `collab:${row.subject.entity}:${row.subject.id}`,
    sourceRef: { kind: COLLAB_NOTIFICATION_REF_KIND, id: row.id },
    directed: true,
    ...(row.workspaceId ? { projectId: row.workspaceId } : {}),
    // The first pull's backlog goes to the center and the badge only.
    ...(context.quiet ? { channels: ["center" as const] } : {}),
    meta: {
      collabOrgId: context.orgId,
      collabEndpoint: context.endpoint,
      collabKind: row.kind,
      collabSeq: row.seq,
    },
  }
}

// ── Pulling ───────────────────────────────────────────────────────────────

export type CollabNotificationsClient = Pick<
  CollabClient,
  "baseUrl" | "identity" | "listNotifications" | "markNotificationsRead"
>

export interface CollabNotificationsTarget {
  client: CollabNotificationsClient
  orgId: string
}

export interface CollabNotificationsSyncDeps extends CollabNotificationsStorageDeps {
  /** The client and org; defaults to the refresh's own resolution. */
  resolve?: (localAccountId: string) => Promise<CollabNotificationsTarget | null>
  /** The ADR-0042 pipe; defaults to `lib/notifications/runtime`'s `notify`. */
  notify?: (input: NotificationInput) => Promise<string>
  /** The center record for one server row, if this device has one. */
  findLocal?: (collabId: string) => Promise<NotificationRecord | undefined>
  /** Move a local record to read (persist + reactive store). */
  markLocalRead?: (record: NotificationRecord, now: number) => Promise<void>
  /** Titles and links. */
  describe?: (
    row: CollabNotification,
    context: { orgId: string; endpoint: string }
  ) => Promise<CollabNotificationPresentation>
  now?: () => number
}

export type CollabNotificationsPullResult =
  | { status: "skipped" }
  | {
      status: "pulled"
      orgId: string
      /** The server's id for this person, from the grant. */
      userId: string
      /** Rows handed to `notify()` by this pull. */
      delivered: number
      /** True when this was the first pull and the backlog went in quietly. */
      quiet: boolean
      /** Local records moved to read because the server said so. */
      readsApplied: number
      cursor: CollabNotificationsCursor
    }
  | { status: "failed"; error: string }

async function defaultResolve(localAccountId: string): Promise<CollabNotificationsTarget | null> {
  const resolved = await resolveCollabClient({ localAccountId })
  return resolved.status === "ready"
    ? { client: resolved.client, orgId: resolved.binding.orgId }
    : null
}

async function defaultNotify(input: NotificationInput): Promise<string> {
  // Lazy: the runtime pulls in sonner and the Tauri bridge.
  const { notify } = await import("@/lib/notifications/runtime")
  return notify(input)
}

async function defaultFindLocal(collabId: string): Promise<NotificationRecord | undefined> {
  const { getDb } = await import("@/lib/db/schema")
  return getDb()
    .notifications.where("logicalKey")
    .equals(collabNotificationLogicalKey(collabId))
    .first()
}

async function defaultMarkLocalRead(record: NotificationRecord, now: number): Promise<void> {
  const patch = cascadeReadState(record, "read", now)
  if (Object.keys(patch).length === 0) return
  const { patchNotification } = await import("@/lib/db/notifications")
  await patchNotification(record.id, patch)
  const store = useNotificationStore.getState()
  // Only a record already in the active feed is updated in place; one that is
  // not (snoozed, or the feed not hydrated yet) is read from Dexie when it is.
  if (store.items.some((item) => item.id === record.id)) {
    store.ingest({ ...record, ...patch })
  }
}

async function defaultDescribe(
  row: CollabNotification,
  context: { orgId: string; endpoint: string }
): Promise<CollabNotificationPresentation> {
  const [{ getRuntimeTranslator }, { getCollabIssue }, { getUser }, { getDb }] = await Promise.all([
    import("@/lib/i18n/runtime-translator"),
    import("@/lib/db/collab-issue-mirror"),
    import("@/lib/db/identity"),
    import("@/lib/db/schema"),
  ])
  const translate = await getRuntimeTranslator(NOTIFICATION_NAMESPACE)
  return describeCollabNotification(row, context, {
    translate,
    issueTitle: async (issueId) => (await getCollabIssue(issueId))?.title || undefined,
    actorName: async (userId) => {
      const user = await getUser(userId)
      // The roster writes the id as the name when it has none; that is not a name.
      return user && user.displayName && user.displayName !== userId ? user.displayName : undefined
    },
    sharedSession: async ({ orgId, sessionId, endpoint }) => {
      const db = getDb()
      const projection = await db.sessions
        .filter(
          (row) =>
            row.collaboration?.sessionId === sessionId &&
            row.collaboration.orgId === orgId &&
            (row.collaboration.endpoint ?? "") === endpoint
        )
        .first()
      const mirrored = await db.collabChatSessions.get(
        sharedChatCacheKey(orgId, sessionId, endpoint)
      )
      return {
        ...(projection ? { localSessionId: projection.id } : {}),
        ...(projection?.title || mirrored?.title
          ? { title: projection?.title || mirrored?.title }
          : {}),
      }
    },
  })
}

function sliceIds(ids: readonly string[], size: number): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

/**
 * Post the queued local reads for one scope. Ids leave the queue only once the
 * server acknowledged them; a failure keeps them for the next pull.
 */
export async function flushCollabNotificationReads(
  scope: CollabNotificationsScope,
  client: Pick<CollabNotificationsClient, "markNotificationsRead">,
  deps: CollabNotificationsStorageDeps = {}
): Promise<{ posted: number; failed: boolean }> {
  const pending = loadCollabNotificationsState(scope, deps).pendingReadIds
  let posted = 0
  for (const batch of sliceIds(pending, COLLAB_NOTIFICATION_READ_BATCH)) {
    try {
      await client.markNotificationsRead(scope.orgId, { ids: batch })
    } catch (error) {
      log.warn("collab notifications: posting reads failed; kept for the next pull", {
        error: String(error),
      })
      return { posted, failed: true }
    }
    rememberReadOnServer(batch)
    const acknowledged = new Set(batch)
    updateCollabNotificationsState(
      scope,
      (state) => ({
        ...state,
        pendingReadIds: state.pendingReadIds.filter((id) => !acknowledged.has(id)),
      }),
      deps
    )
    posted += batch.length
  }
  return { posted, failed: false }
}

const UNREAD: ReadonlySet<NotificationReadState> = new Set(["unseen", "seen"])

/** Apply one server read locally, without posting it back. Returns whether a record moved. */
async function applyServerRead(
  collabId: string,
  findLocal: NonNullable<CollabNotificationsSyncDeps["findLocal"]>,
  markLocalRead: NonNullable<CollabNotificationsSyncDeps["markLocalRead"]>,
  now: number
): Promise<boolean> {
  // Remembered first: the store change below must not read as a local read.
  rememberReadOnServer([collabId])
  const record = await findLocal(collabId)
  if (!record || !UNREAD.has(record.readState)) return false
  await markLocalRead(record, now)
  return true
}

async function runPull(
  localAccountId: string,
  deps: CollabNotificationsSyncDeps
): Promise<CollabNotificationsPullResult> {
  const resolve = deps.resolve ?? defaultResolve
  const notify = deps.notify ?? defaultNotify
  const findLocal = deps.findLocal ?? defaultFindLocal
  const markLocalRead = deps.markLocalRead ?? defaultMarkLocalRead
  const describe = deps.describe ?? defaultDescribe
  const now = deps.now ?? (() => Date.now())

  let target: CollabNotificationsTarget | null
  try {
    target = await resolve(localAccountId)
  } catch (error) {
    log.warn("collab notifications: could not resolve the plane", { error: String(error) })
    return { status: "failed", error: String(error) }
  }
  if (!target) return { status: "skipped" }
  const { client, orgId } = target
  const scope: CollabNotificationsScope = { localAccountId, endpoint: client.baseUrl, orgId }
  const context = { orgId, endpoint: client.baseUrl }

  try {
    const { userId } = await client.identity(orgId)

    // Local reads that did not reach the server last time go first, so a row
    // read here is never resurfaced as unread by its own pull.
    await flushCollabNotificationReads(scope, client, deps)

    const initial = loadCollabNotificationsState(scope, deps)
    const quiet = initial.cursor === null
    let cursor: CollabNotificationsCursor = initial.cursor ?? { afterSeq: 0, readAt: 0, readSeq: 0 }
    let delivered = 0
    let readsApplied = 0

    for (let page = 0; page < COLLAB_NOTIFICATION_MAX_PAGES; page += 1) {
      const pageStart = cursor
      const answer = await client.listNotifications(orgId, {
        afterSeq: cursor.afterSeq,
        readAt: cursor.readAt,
        readSeq: cursor.readSeq,
        limit: COLLAB_NOTIFICATION_PAGE_LIMIT,
      })

      // Hand rows over oldest first, advancing the persisted row cursor past
      // each one as it lands, so a hand-over that fails half way never replays
      // the rows before it.
      for (const row of answer.notifications) {
        if (row.seq <= cursor.afterSeq) continue
        if (row.readAt !== null) {
          if (await applyServerRead(row.id, findLocal, markLocalRead, now())) readsApplied += 1
        } else {
          const presentation = await describe(row, context)
          await notify(collabNotificationInput(row, presentation, { ...context, quiet }))
          delivered += 1
        }
        const handed = { ...cursor, afterSeq: row.seq }
        cursor = handed
        updateCollabNotificationsState(scope, (state) => ({ ...state, cursor: handed }), deps)
      }

      for (const read of answer.reads) {
        if (await applyServerRead(read.id, findLocal, markLocalRead, now())) readsApplied += 1
      }

      const readCursor: CollabNotificationReadCursor = answer.readCursor
      const next: CollabNotificationsCursor = {
        // Past rows the server withheld (the reader lost the workspace) too.
        afterSeq: Math.max(cursor.afterSeq, answer.nextAfterSeq),
        readAt: readCursor.at,
        readSeq: readCursor.seq,
      }
      cursor = next
      updateCollabNotificationsState(scope, (state) => ({ ...state, cursor: next }), deps)

      // A server that says "more" without moving a cursor would loop forever.
      const rowsAdvanced = next.afterSeq > pageStart.afterSeq
      const readsAdvanced = next.readAt !== pageStart.readAt || next.readSeq !== pageStart.readSeq
      const more = (answer.hasMore && rowsAdvanced) || (answer.readsHaveMore && readsAdvanced)
      if (!more) break
      if (page === COLLAB_NOTIFICATION_MAX_PAGES - 1) {
        log.info("collab notifications: backlog deeper than one pull; the next trigger continues")
      }
    }

    return { status: "pulled", orgId, userId, delivered, quiet, readsApplied, cursor }
  } catch (error) {
    log.warn("collab notifications: pull failed; the cursor stays where it was", {
      error: String(error),
    })
    return { status: "failed", error: String(error) }
  }
}

interface PullSlot {
  current: Promise<CollabNotificationsPullResult>
  next: Promise<CollabNotificationsPullResult> | null
}

/**
 * One pull in flight per profile, at most one queued behind it. A profile is
 * bound to one org at a time, so this is per account and org; a rerun resolves
 * the binding again, so a changed org is picked up by the queued pull.
 */
const pulls = new Map<string, PullSlot>()

function release(key: string, settled: Promise<CollabNotificationsPullResult>): () => void {
  return () => {
    const slot = pulls.get(key)
    if (slot && slot.current === settled && slot.next === null) pulls.delete(key)
  }
}

/**
 * Pull this profile's notifications now, or join the pull queued behind the
 * one already running. Never rejects: a failure reports `status: "failed"`.
 */
export function pullCollabNotifications(
  localAccountId: string,
  deps: CollabNotificationsSyncDeps = {}
): Promise<CollabNotificationsPullResult> {
  const slot = pulls.get(localAccountId)
  if (slot) {
    if (slot.next) return slot.next
    // Anything that asked while a pull ran may announce rows that pull had
    // already listed past, so exactly one more runs after it.
    const next: Promise<CollabNotificationsPullResult> = slot.current
      .then(
        () => undefined,
        () => undefined
      )
      .then(() => {
        slot.current = next
        slot.next = null
        return runPull(localAccountId, deps)
      })
    slot.next = next
    void next.then(release(localAccountId, next), release(localAccountId, next))
    return next
  }
  const current = runPull(localAccountId, deps)
  pulls.set(localAccountId, { current, next: null })
  void current.then(release(localAccountId, current), release(localAccountId, current))
  return current
}

// ── Local → server reads ─────────────────────────────────────────────────

/** The server id and scope a center record stands for, if it is a collab one. */
export function collabRefOf(
  record: NotificationRecord
): { id: string; orgId: string; endpoint: string } | null {
  if (record.source !== "collab" || record.sourceRef?.kind !== COLLAB_NOTIFICATION_REF_KIND) {
    return null
  }
  const orgId = record.meta?.collabOrgId
  const endpoint = record.meta?.collabEndpoint
  if (typeof orgId !== "string" || typeof endpoint !== "string") return null
  return { id: record.sourceRef.id, orgId, endpoint }
}

export interface CollabNotificationReadPropagationDeps extends CollabNotificationsStorageDeps {
  /** Read a record that left the active feed, to tell "archived" from "snoozed". */
  getRecord?: (id: string) => Promise<NotificationRecord | undefined>
  /** Post the queued reads for one scope now; defaults to resolve + flush. */
  flush?: (scope: CollabNotificationsScope) => Promise<void>
  resolve?: CollabNotificationsSyncDeps["resolve"]
  /** The store to watch; defaults to the app's notification store. */
  store?: Pick<typeof useNotificationStore, "subscribe">
}

/**
 * Queue a local read of these server ids and try to post it. Persisted before
 * the post, so a failure is retried at the start of the next pull.
 */
export function queueCollabNotificationReads(
  scope: CollabNotificationsScope,
  ids: readonly string[],
  deps: CollabNotificationsStorageDeps = {}
): void {
  if (ids.length === 0) return
  updateCollabNotificationsState(
    scope,
    (state) => ({ ...state, pendingReadIds: [...state.pendingReadIds, ...ids] }),
    deps
  )
}

/**
 * Watch the notification store and post every `collab` record the person reads
 * here (mark read, mark all read, archive, archive all). Records the server
 * already has as read (its own reads, applied by the pull) are skipped, so a
 * read never echoes back.
 */
export function installCollabNotificationReadPropagation(
  localAccountId: string,
  deps: CollabNotificationReadPropagationDeps = {}
): () => void {
  const store = deps.store ?? useNotificationStore
  const getRecord =
    deps.getRecord ??
    (async (id: string) => {
      const { getNotification } = await import("@/lib/db/notifications")
      return getNotification(id)
    })
  const resolve = deps.resolve ?? defaultResolve
  const flush =
    deps.flush ??
    (async (scope: CollabNotificationsScope) => {
      const target = await resolve(localAccountId)
      // A read for another org or server waits until that one is current
      // again; the queue is per scope, so nothing is lost meanwhile.
      if (!target || target.orgId !== scope.orgId || target.client.baseUrl !== scope.endpoint) {
        return
      }
      await flushCollabNotificationReads(scope, target.client, deps)
    })

  let stopped = false

  const enqueue = (records: readonly NotificationRecord[]) => {
    const byScope = new Map<string, { scope: CollabNotificationsScope; ids: string[] }>()
    for (const record of records) {
      const ref = collabRefOf(record)
      if (!ref || knownReadOnServer.has(ref.id)) continue
      const scope = { localAccountId, endpoint: ref.endpoint, orgId: ref.orgId }
      const key = collabNotificationsStateKey(scope)
      const entry = byScope.get(key) ?? { scope, ids: [] }
      entry.ids.push(ref.id)
      byScope.set(key, entry)
    }
    for (const { scope, ids } of byScope.values()) {
      queueCollabNotificationReads(scope, ids, deps)
      void flush(scope).catch((error) => {
        log.warn("collab notifications: posting a local read failed", { error: String(error) })
      })
    }
  }

  const unsubscribe = store.subscribe((state, previous) => {
    if (stopped || state.items === previous.items) return
    const now = new Map(state.items.map((item) => [item.id, item]))
    const readHere: NotificationRecord[] = []
    const left: NotificationRecord[] = []
    for (const before of previous.items) {
      if (before.source !== "collab" || !UNREAD.has(before.readState)) continue
      const after = now.get(before.id)
      if (after) {
        if (!UNREAD.has(after.readState)) readHere.push(after)
      } else {
        // Left the active feed: archived (done) counts as read; snoozed,
        // pruned or deleted does not. Dexie says which.
        left.push(before)
      }
    }
    if (readHere.length > 0) enqueue(readHere)
    if (left.length > 0) {
      void Promise.all(left.map((record) => getRecord(record.id).catch(() => undefined))).then(
        (records) => {
          if (stopped) return
          enqueue(
            records.filter(
              (record): record is NotificationRecord =>
                record !== undefined && !UNREAD.has(record.readState)
            )
          )
        }
      )
    }
  })

  return () => {
    stopped = true
    unsubscribe()
  }
}

// ── Install ──────────────────────────────────────────────────────────────

export interface InstallCollabNotificationsSyncDeps extends CollabNotificationsSyncDeps {
  window?: Pick<Window, "addEventListener" | "removeEventListener">
  document?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">
  /** Defaults to the feed's signal registry for this profile. */
  subscribeSignals?: (listener: (signal: CollabNotificationSignal) => void) => () => void
  /** Defaults to {@link installCollabNotificationReadPropagation}. */
  installReadPropagation?: () => () => void
}

/**
 * Keep this profile's collaboration notifications flowing into the center
 * until the returned function is called. Safe when collaboration is not
 * configured: every pull resolves to `skipped`.
 */
export function installCollabNotificationsSync(
  localAccountId: string,
  deps: InstallCollabNotificationsSyncDeps = {}
): () => void {
  const windowRef = deps.window ?? (typeof window === "undefined" ? undefined : window)
  const documentRef = deps.document ?? (typeof document === "undefined" ? undefined : document)
  let stopped = false
  // The server's id for this person, learned from the first successful pull.
  // A frame addressed to someone else (a shared socket after a sign-in change)
  // asks for nothing.
  let userId: string | null = null

  const pull = () => {
    if (stopped) return
    void pullCollabNotifications(localAccountId, deps).then((result) => {
      if (result.status === "pulled") userId = result.userId
    })
  }

  const onSignal = (signal: CollabNotificationSignal) => {
    if (signal.reason === "frame" && userId !== null && signal.recipientUserId !== userId) return
    pull()
  }
  const onVisible = () => {
    if (documentRef?.visibilityState === "visible") pull()
  }

  windowRef?.addEventListener("focus", pull)
  windowRef?.addEventListener("online", pull)
  documentRef?.addEventListener("visibilitychange", onVisible)
  const unsubscribeSignals = (
    deps.subscribeSignals ??
    ((listener) => subscribeCollabNotificationSignals(localAccountId, listener))
  )(onSignal)
  const detachReads = (
    deps.installReadPropagation ??
    (() =>
      installCollabNotificationReadPropagation(localAccountId, {
        ...(deps.local ? { local: deps.local } : {}),
        ...(deps.resolve ? { resolve: deps.resolve } : {}),
      }))
  )()

  pull()

  return () => {
    stopped = true
    windowRef?.removeEventListener("focus", pull)
    windowRef?.removeEventListener("online", pull)
    documentRef?.removeEventListener("visibilitychange", onVisible)
    unsubscribeSignals()
    detachReads()
  }
}
