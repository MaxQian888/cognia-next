/**
 * Snapshot cache for the embedded browser engine (ADR-0127).
 *
 * The agent walks the page's accessibility tree (`browser_embed_snapshot`)
 * before most steps. Between two steps the DOM often has not changed at all —
 * the previous action was a scroll, a read, or a no-op — yet each walk costs a
 * full `evaluate` round trip plus a re-serialization of every node. This cache
 * keeps the last snapshot and hands it back until something says the DOM
 * changed:
 *
 *   - the overlay's `browser://snapshot` marker (a debounced MutationObserver
 *     batch, or a load / route change), routed here by the engine's listener;
 *   - any engine call that can mutate the page (`act`, `navigate`, `back`,
 *     `reload`, `evaluate`, …) — the engine calls {@link SnapshotCache.markDirty}
 *     itself so the cache is safe even if a marker is late.
 *
 * Refs stay valid across a cache hit: the overlay only rebuilds `refMap` when
 * it builds a *new* snapshot, so acting by ref against the cached generation
 * is exactly as valid as acting against a fresh walk that changed nothing.
 *
 * Pure and framework-free so the invalidation policy is unit-tested; the
 * engine owns the Tauri listener.
 */

import type { BrowserSnapshot, SnapshotOptions } from "@/lib/browser/protocol"

/** Cache-relevant part of {@link SnapshotOptions}: `includeText` changes the tree. */
export function snapshotCacheKey(opts?: SnapshotOptions): string {
  return opts?.includeText ? "text" : "plain"
}

export interface SnapshotCacheStats {
  hits: number
  misses: number
  invalidations: number
}

export class SnapshotCache {
  private snapshot: BrowserSnapshot | null = null
  private key: string | null = null
  private dirty = true
  private readonly stats: SnapshotCacheStats = { hits: 0, misses: 0, invalidations: 0 }

  /** Return the cached snapshot for `opts` when nothing invalidated it. */
  get(opts?: SnapshotOptions): BrowserSnapshot | null {
    if (opts?.fresh || this.dirty || !this.snapshot || this.key !== snapshotCacheKey(opts)) {
      this.stats.misses += 1
      return null
    }
    this.stats.hits += 1
    return this.snapshot
  }

  /** Store the result of a real walk. */
  set(snapshot: BrowserSnapshot, opts?: SnapshotOptions): void {
    this.snapshot = snapshot
    this.key = snapshotCacheKey(opts)
    this.dirty = false
  }

  /** The DOM (or the page) changed — the next `get` misses. */
  markDirty(): void {
    if (!this.dirty) this.stats.invalidations += 1
    this.dirty = true
  }

  /** Forget everything (pane closed / engine reset). */
  clear(): void {
    this.snapshot = null
    this.key = null
    this.dirty = true
  }

  isDirty(): boolean {
    return this.dirty
  }

  getStats(): SnapshotCacheStats {
    return { ...this.stats }
  }
}
