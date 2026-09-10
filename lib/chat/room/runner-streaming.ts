/**
 * In-flight transcript state for a room, keyed by member sub-session.
 *
 * # Why the key changed
 *
 * `use-team-chat.ts` kept one mirror per team session: the latest full
 * message list, rewritten by whichever member was streaming. That was safe
 * only because members ran strictly one after another. Two members streaming
 * at once would each read the other's half-written list as their base, and
 * the one to finish second would persist a list missing the first's reply.
 *
 * This registry keeps a committed `base` per room plus one slice per active
 * sub-session. A member's events are applied to `base + own slice`, never to
 * another member's partial output, and the room transcript the store and
 * Dexie see is `base + every active slice` in start order. When a member
 * finishes, its slice folds into `base`. With one member at a time this is
 * byte-identical to the old mirror. With several it is the parallel-safe
 * shape batch 3 (ADR-0177) needs.
 *
 * Pure: no store, no Dexie, no React.
 */

import type { UIMessage } from "ai"

interface RoomStream {
  /** Committed transcript, or `null` until the first event reads it. */
  base: UIMessage[] | null
  /** New messages each active sub-session has produced, in start order. */
  slices: Map<string, UIMessage[]>
}

export interface SubSessionView {
  /** `base + own slice`, the list a member's next event applies to. */
  view: UIMessage[]
  /** Length of `base` inside `view`, so the slice can be split back out. */
  baseLength: number
}

export class RoomStreamRegistry {
  private readonly rooms = new Map<string, RoomStream>()

  /** True while at least one member of `roomId` is mid-turn. */
  has(roomId: string): boolean {
    return this.rooms.has(roomId)
  }

  activeSubSessions(roomId: string): string[] {
    return [...(this.rooms.get(roomId)?.slices.keys() ?? [])]
  }

  /** The committed base, or `null` when nothing has been read yet. */
  baseOf(roomId: string): UIMessage[] | null {
    return this.rooms.get(roomId)?.base ?? null
  }

  /** Seed the base from the store slice or Dexie before the first event. */
  setBase(roomId: string, base: UIMessage[]): void {
    const room = this.room(roomId)
    room.base = base
  }

  /**
   * The list a sub-session's next event applies to. Registers the
   * sub-session on first use so its slice keeps its start order.
   */
  viewOf(roomId: string, sub: string): SubSessionView {
    const room = this.room(roomId)
    const base = room.base ?? []
    if (!room.slices.has(sub)) room.slices.set(sub, [])
    const slice = room.slices.get(sub) ?? []
    // Hand back `base` itself when the member has produced nothing yet, so a
    // no-op event keeps referential identity and nothing is re-persisted.
    return { view: slice.length ? base.concat(slice) : base, baseLength: base.length }
  }

  /**
   * Record what a sub-session's event produced. `next` is the whole list the
   * adapter returned for `view`. Messages at or past `baseLength` are the
   * member's own. If the adapter rewrote a base message (a tool result landing
   * on an earlier assistant turn of the same member), that part of `next`
   * replaces the base so the change is not lost at fold time.
   */
  applySubResult(roomId: string, sub: string, next: UIMessage[], baseLength: number): void {
    const room = this.room(roomId)
    const head = next.slice(0, baseLength)
    const base = room.base ?? []
    const baseChanged = head.length !== base.length || head.some((m, i) => m !== base[i])
    if (baseChanged) room.base = head
    room.slices.set(sub, next.slice(baseLength))
  }

  /** `base + every active slice`, in sub-session start order. */
  compose(roomId: string): UIMessage[] {
    const room = this.rooms.get(roomId)
    if (!room) return []
    let out = room.base ?? []
    for (const slice of room.slices.values()) if (slice.length) out = out.concat(slice)
    return out
  }

  /**
   * A member finished: its slice becomes part of the base. Returns the new
   * base so the caller can persist it. `final` lets the caller hand in the
   * post-processed list (dedupe, source merges) it computed from the view.
   */
  fold(roomId: string, sub: string, final?: UIMessage[]): UIMessage[] {
    const room = this.room(roomId)
    const slice = room.slices.get(sub) ?? []
    room.slices.delete(sub)
    room.base = final ?? (room.base ?? []).concat(slice)
    return room.base
  }

  /** Forget a sub-session without folding (interrupt, error). */
  discard(roomId: string, sub: string): void {
    this.rooms.get(roomId)?.slices.delete(sub)
  }

  /** Drop everything for a room at the end of its turn. */
  release(roomId: string): void {
    this.rooms.delete(roomId)
  }

  clear(): void {
    this.rooms.clear()
  }

  private room(roomId: string): RoomStream {
    const existing = this.rooms.get(roomId)
    if (existing) return existing
    const created: RoomStream = { base: null, slices: new Map() }
    this.rooms.set(roomId, created)
    return created
  }
}
