/**
 * Adapter contract for the unified scheduler page.
 *
 * Each source (app / workflow / backup / plugin / system) implements this
 * interface and is registered with `SchedulerSourceRegistry`. The interface
 * is intentionally small: read once via `subscribe`, mutate via narrow CRUD
 * methods, dispatch lifecycle through `runNow` / `pause` / `resume`.
 *
 * Why `subscribe` instead of returning an Observable: Dexie's liveQuery
 * already exposes a `subscribe(observer)` shape, and the rest of the app's
 * react integration revolves around `useLiveQuery`. Sticking to a plain
 * subscribe API keeps the contract Dexie-shaped without dragging RxJS in.
 */

import type { UnifiedScheduledItem, ScheduledItemKind } from "@/types/scheduler/unified"

export interface ScheduledItemSubscription {
  unsubscribe(): void
}

export interface ScheduledItemSourceObserver {
  next(items: UnifiedScheduledItem[]): void
  error?(err: unknown): void
}

/**
 * Adapter contract per source. Generic create/update inputs because each
 * source consumes a different payload shape (workflow trigger needs cron +
 * workflowId; backup needs cron + retention; plugin needs cron + handler).
 * The form layer dispatches the right shape to `getSource(kind)`.
 */
export interface ScheduledItemSource<CreateInput = unknown, UpdateInput = unknown> {
  readonly kind: ScheduledItemKind

  /**
   * Subscribe to the current set of items. Implementations MUST emit at least
   * once on subscription with the latest snapshot, then emit again whenever
   * the underlying storage changes. Disposing the returned subscription must
   * stop all further emissions.
   */
  subscribe(observer: ScheduledItemSourceObserver): ScheduledItemSubscription

  /** One-shot read of all items in this source. */
  list(): Promise<UnifiedScheduledItem[]>

  /** One-shot read of a single item by source-native id. */
  get(sourceId: string): Promise<UnifiedScheduledItem | undefined>

  /**
   * Persist a new item. Returns the canonical unified shape of the just-
   * created item (after id assignment / next-run computation).
   */
  create(input: CreateInput): Promise<UnifiedScheduledItem>

  /** Partial update — fields the caller wants to change. */
  update(sourceId: string, input: UpdateInput): Promise<void>

  delete(sourceId: string): Promise<void>

  pause(sourceId: string): Promise<void>

  resume(sourceId: string): Promise<void>

  runNow(sourceId: string): Promise<void>
}
