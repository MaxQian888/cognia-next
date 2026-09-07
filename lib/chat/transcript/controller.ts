import type {
  SessionTimelinePage,
  SessionTurnMessagesPage,
  TranscriptTimelineItem,
} from "@cognia/agent-config-types"

import { TranscriptDetailCache } from "./detail-cache"
import type { TranscriptSource } from "./source"

export type { SessionTimelinePage, SessionTurnMessagesPage, TranscriptSource }

export interface TranscriptControllerSnapshot {
  mode: "unknown" | "timeline" | "legacy"
  items: TranscriptTimelineItem[]
  revision: number | null
  loading: boolean
  loadingOlder: boolean
  hasMore: boolean
  expandedTurnKeys: ReadonlySet<string>
  error: unknown | null
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object"
    ? String((error as { code?: unknown }).code ?? "")
    : undefined
}

function staleTranscript(): Error {
  return Object.assign(new Error("transcript revision changed while reading history"), {
    code: "TRANSCRIPT_STALE",
  })
}

/** Pages are already in host order; timestamps alone cannot order tied rows. */
function prependPage(older: TranscriptTimelineItem[], newer: TranscriptTimelineItem[]) {
  const seen = new Set(newer.map((item) => item.itemKey))
  return [
    ...older.filter((item) => {
      if (seen.has(item.itemKey)) return false
      seen.add(item.itemKey)
      return true
    }),
    ...newer,
  ]
}

export class TranscriptController {
  private readonly listeners = new Set<() => void>()
  private readonly detailCache: TranscriptDetailCache<SessionTurnMessagesPage>
  private nextCursor: string | undefined
  private unsubscribeRevision: (() => void) | undefined
  private started = false
  private generation = 0
  private readEpoch = 0
  private requestedRevision = 0
  private refreshPromise: Promise<void> | undefined
  private readonly detailRequests = new Map<string, Promise<void>>()
  private snapshot: TranscriptControllerSnapshot = {
    mode: "unknown",
    items: [],
    revision: null,
    loading: false,
    loadingOlder: false,
    hasMore: false,
    expandedTurnKeys: new Set(),
    error: null,
  }

  constructor(
    private readonly sessionId: string,
    private readonly source: TranscriptSource,
    cacheBudget?: { softBytes?: number; hardBytes?: number }
  ) {
    this.detailCache = new TranscriptDetailCache(cacheBudget)
  }

  /**
   * Wire the revision subscription. Kept out of the constructor because the
   * hook builds the controller during render: the remote source opens the
   * companion WebSocket here, and that flips the transport's connection state,
   * which wakes every other connectivity subscriber inside our render pass.
   * Idempotent, so a re-run of the owning effect is free.
   */
  start = (): void => {
    if (this.started) return
    this.started = true
    this.unsubscribeRevision = this.source.subscribeRevision?.(this.sessionId, (revision) => {
      if (!Number.isSafeInteger(revision) || revision < 0) return
      if (this.snapshot.revision !== null && revision <= this.snapshot.revision) return
      this.requestedRevision = Math.max(this.requestedRevision, revision)
      void this.loadInitial()
    })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): TranscriptControllerSnapshot => this.snapshot

  getDetail(turnKey: string): SessionTurnMessagesPage | undefined {
    return this.detailCache.get(this.cacheKey(turnKey))
  }

  loadInitial(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise
    const generation = this.generation
    const epoch = ++this.readEpoch
    const request = Promise.resolve().then(() => this.refresh(generation, epoch))
    this.refreshPromise = request
    void request.finally(() => {
      if (this.refreshPromise !== request) return
      this.refreshPromise = undefined
      if (
        this.snapshot.mode === "timeline" &&
        !this.snapshot.error &&
        this.requestedRevision > (this.snapshot.revision ?? 0)
      )
        void this.loadInitial()
    })
    return request
  }

  private async refresh(generation: number, epoch: number): Promise<void> {
    if (generation !== this.generation) return
    this.update({ loading: true, error: null })
    try {
      const capabilities = await this.source.capabilities()
      if (generation !== this.generation) return
      if (!capabilities) {
        this.nextCursor = undefined
        this.update({
          mode: "legacy",
          loading: false,
          loadingOlder: false,
          hasMore: false,
          error: null,
        })
        return
      }
      // A revision-bound cursor cannot survive a refresh. Rebuild only the
      // already visible window, then swap it atomically so readers keep history.
      const oldest = this.snapshot.items[0]
      let staleRetries = 0
      for (;;) {
        const requestedAtStart = this.requestedRevision
        let page: SessionTimelinePage
        try {
          page = await this.source.timeline({ sessionId: this.sessionId, direction: "backward" })
          if (generation !== this.generation) return
          // A burst needs one follow-up read, not one read per notification.
          // Skip downloading older pages for a response we already know is old.
          if (page.revision < this.requestedRevision && this.requestedRevision > requestedAtStart)
            continue
          if (page.revision < Math.max(this.snapshot.revision ?? 0, this.requestedRevision))
            throw staleTranscript()
          const cursors = new Set<string>()
          while (
            oldest &&
            page.hasMore &&
            !(
              page.revision < this.requestedRevision && this.requestedRevision > requestedAtStart
            ) &&
            !page.items.some((item) => item.itemKey === oldest.itemKey) &&
            (!page.items[0] || page.items[0].startedAt >= oldest.startedAt)
          ) {
            if (!page.nextCursor || cursors.has(page.nextCursor))
              throw new Error("transcript timeline cursor did not advance")
            cursors.add(page.nextCursor)
            const older = await this.source.timeline({
              sessionId: this.sessionId,
              direction: "backward",
              cursor: page.nextCursor,
            })
            if (generation !== this.generation) return
            if (older.revision !== page.revision) throw staleTranscript()
            page = { ...older, items: prependPage(older.items, page.items) }
          }
        } catch (error) {
          if (generation !== this.generation) return
          if (errorCode(error) === "TRANSCRIPT_STALE" && staleRetries++ < 1) continue
          throw error
        }
        if (page.revision < this.requestedRevision && this.requestedRevision > requestedAtStart)
          continue
        // Old detail requests belong to the previous page generation too.
        if (epoch !== this.readEpoch) return
        this.readEpoch++
        this.detailCache.clearSession(this.sessionId)
        this.nextCursor = page.nextCursor
        const expandedTurnKeys = new Set(
          [...this.snapshot.expandedTurnKeys].filter((key) =>
            page.items.some((item) => item.kind === "completed-turn" && item.turnKey === key)
          )
        )
        this.update({
          mode: "timeline",
          items: page.items,
          revision: page.revision,
          loading: false,
          loadingOlder: false,
          hasMore: page.hasMore,
          expandedTurnKeys,
          error: null,
        })
        for (const item of page.items) {
          if (item.kind === "completed-turn" && expandedTurnKeys.has(item.turnKey)) {
            void this.loadTurn(item.turnKey, item.revision, item.detailRevision, false)
          }
        }
        return
      }
    } catch (error) {
      if (generation === this.generation)
        this.update({ loading: false, loadingOlder: false, error })
    }
  }

  async loadOlder(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise
    if (!this.nextCursor || this.snapshot.loadingOlder) return
    const epoch = this.readEpoch
    const revision = this.snapshot.revision
    this.update({ loadingOlder: true, error: null })
    try {
      const page = await this.source.timeline({
        sessionId: this.sessionId,
        direction: "backward",
        cursor: this.nextCursor,
      })
      if (epoch !== this.readEpoch) return
      if (page.revision !== revision) throw staleTranscript()
      this.nextCursor = page.nextCursor
      this.update({
        items: prependPage(page.items, this.snapshot.items),
        revision: page.revision,
        loadingOlder: false,
        hasMore: page.hasMore,
      })
    } catch (error) {
      if (epoch !== this.readEpoch) return
      if (errorCode(error) === "TRANSCRIPT_STALE") {
        await this.loadInitial()
        return
      }
      this.update({ loadingOlder: false, error })
    }
  }

  expandTurn(turnKey: string, revision: number, detailRevision: number): Promise<void> {
    return this.loadTurn(turnKey, revision, detailRevision, true)
  }

  private loadTurn(
    turnKey: string,
    revision: number,
    detailRevision: number,
    allowReconcile: boolean
  ): Promise<void> {
    const expanded = new Set(this.snapshot.expandedTurnKeys)
    expanded.add(turnKey)
    this.update({ expandedTurnKeys: expanded, error: null })
    const key = this.cacheKey(turnKey)
    if (this.detailCache.get(key)) {
      this.detailCache.pin(key)
      return Promise.resolve()
    }
    const requestKey = `${this.readEpoch}:${turnKey}:${revision}:${detailRevision}`
    const existing = this.detailRequests.get(requestKey)
    if (existing) return existing
    const epoch = this.readEpoch
    const request = this.readDetail(turnKey, revision, detailRevision, epoch, allowReconcile)
    this.detailRequests.set(requestKey, request)
    void request.finally(() => {
      if (this.detailRequests.get(requestKey) === request) this.detailRequests.delete(requestKey)
    })
    return request
  }

  private async readDetail(
    turnKey: string,
    revision: number,
    detailRevision: number,
    epoch: number,
    allowReconcile: boolean
  ): Promise<void> {
    try {
      let detail: SessionTurnMessagesPage | undefined
      let cursor: string | undefined
      const cursors = new Set<string>()
      const seen = new Set<string>()
      for (;;) {
        const page = await this.source.turnMessages({
          sessionId: this.sessionId,
          turnKey,
          revision,
          detailRevision,
          ...(cursor ? { cursor } : {}),
        })
        if (epoch !== this.readEpoch) return
        if (page.revision !== revision || page.detailRevision !== detailRevision)
          throw staleTranscript()
        const messages = page.messages.filter((message) => {
          if (seen.has(message.id)) return false
          seen.add(message.id)
          return true
        })
        detail = {
          ...page,
          messages: [...(detail?.messages ?? []), ...messages],
          approximateBytes: (detail?.approximateBytes ?? 0) + page.approximateBytes,
        }
        if (!page.hasMore) break
        if (!page.nextCursor || cursors.has(page.nextCursor))
          throw new Error("transcript detail cursor did not advance")
        cursors.add(page.nextCursor)
        cursor = page.nextCursor
      }
      const key = this.cacheKey(turnKey)
      this.detailCache.set(key, detail, detail.approximateBytes, this.sessionId)
      if (this.snapshot.expandedTurnKeys.has(turnKey)) this.detailCache.pin(key)
      this.emit()
    } catch (error) {
      if (epoch !== this.readEpoch) return
      // A refreshed turn gets one automatic detail attempt. Re-reconciling a
      // persistently stale host here would produce an endless history RPC loop.
      if (
        allowReconcile &&
        (errorCode(error) === "TRANSCRIPT_STALE" || errorCode(error) === "TURN_NOT_FOUND")
      ) {
        await this.loadInitial()
        return
      }
      this.update({ error })
    }
  }

  collapseTurn(turnKey: string): void {
    const expanded = new Set(this.snapshot.expandedTurnKeys)
    expanded.delete(turnKey)
    this.detailCache.unpin(this.cacheKey(turnKey))
    this.update({ expandedTurnKeys: expanded })
  }

  clear(): void {
    this.generation++
    this.readEpoch++
    this.refreshPromise = undefined
    this.detailRequests.clear()
    this.requestedRevision = 0
    this.unsubscribeRevision?.()
    this.unsubscribeRevision = undefined
    this.started = false
    this.detailCache.clearSession(this.sessionId)
    this.listeners.clear()
  }

  private cacheKey(turnKey: string): string {
    return `${this.sessionId}:${turnKey}`
  }

  private update(patch: Partial<TranscriptControllerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
