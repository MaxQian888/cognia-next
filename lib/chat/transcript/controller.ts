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
  return error && typeof error === "object" ? String((error as { code?: unknown }).code ?? "") : undefined
}

export class TranscriptController {
  private readonly listeners = new Set<() => void>()
  private readonly detailCache: TranscriptDetailCache<SessionTurnMessagesPage>
  private nextCursor: string | undefined
  private readonly unsubscribeRevision: (() => void) | undefined
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
    this.unsubscribeRevision = source.subscribeRevision?.(sessionId, (revision) => {
      if (this.snapshot.revision !== null && revision <= this.snapshot.revision) return
      void this.reconcile()
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

  async loadInitial(): Promise<void> {
    this.update({ loading: true, error: null })
    try {
      const capabilities = await this.source.capabilities()
      if (!capabilities) {
        this.nextCursor = undefined
        this.update({ mode: "legacy", loading: false, hasMore: false, error: null })
        return
      }
      const page = await this.source.timeline({
        sessionId: this.sessionId,
        direction: "backward",
      })
      this.nextCursor = page.nextCursor
      this.snapshot = {
        ...this.snapshot,
        mode: "timeline",
        items: page.items,
        revision: page.revision,
        loading: false,
        loadingOlder: false,
        hasMore: page.hasMore,
        error: null,
      }
      this.emit()
    } catch (error) {
      this.update({ loading: false, error })
    }
  }

  async loadOlder(): Promise<void> {
    if (!this.nextCursor || this.snapshot.loadingOlder) return
    this.update({ loadingOlder: true, error: null })
    try {
      const page = await this.source.timeline({
        sessionId: this.sessionId,
        direction: "backward",
        cursor: this.nextCursor,
      })
      this.nextCursor = page.nextCursor
      const existing = new Set(this.snapshot.items.map((item) => item.itemKey))
      this.update({
        items: [...page.items.filter((item) => !existing.has(item.itemKey)), ...this.snapshot.items],
        revision: page.revision,
        loadingOlder: false,
        hasMore: page.hasMore,
      })
    } catch (error) {
      if (errorCode(error) === "TRANSCRIPT_STALE") {
        await this.reconcile()
        return
      }
      this.update({ loadingOlder: false, error })
    }
  }

  async expandTurn(turnKey: string, revision: number, detailRevision: number): Promise<void> {
    const expanded = new Set(this.snapshot.expandedTurnKeys)
    expanded.add(turnKey)
    this.update({ expandedTurnKeys: expanded, error: null })
    const key = this.cacheKey(turnKey)
    if (this.detailCache.get(key)) {
      this.detailCache.pin(key)
      return
    }
    try {
      const detail = await this.source.turnMessages({
        sessionId: this.sessionId,
        turnKey,
        revision,
        detailRevision,
      })
      this.detailCache.set(key, detail, detail.approximateBytes, this.sessionId)
      this.detailCache.pin(key)
      this.emit()
    } catch (error) {
      if (
        errorCode(error) === "TRANSCRIPT_STALE" ||
        errorCode(error) === "TURN_NOT_FOUND"
      ) {
        await this.reconcile()
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
    this.unsubscribeRevision?.()
    this.detailCache.clearSession(this.sessionId)
    this.listeners.clear()
  }

  private async reconcile(): Promise<void> {
    this.detailCache.clearSession(this.sessionId)
    this.nextCursor = undefined
    await this.loadInitial()
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
