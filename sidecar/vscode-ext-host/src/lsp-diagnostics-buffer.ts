/**
 * Diagnostics quality stage between `CogniaLspClient.onPublishDiagnostics`
 * and the `lsp:publishDiagnostics` notification consumers (the editor bridge
 * and the agent resolver's cache).
 *
 * Three concerns, all OpenCode/Claude-Code-inspired:
 *
 *   1. **Debounce** (150 ms per `key:uri`): language servers push bursts of
 *      partial results while re-analysing; only the last burst frame matters.
 *   2. **Dedupe**: some servers emit the same diagnostic twice (e.g. once per
 *      overlapping analysis pass). Key = severity|code|source|message|range.
 *   3. **Version guard**: a push tagged with a document version OLDER than
 *      the client's current `didChange` version is stale — attributing
 *      pre-edit diagnostics to the post-edit text made Claude Code's model
 *      re-read files it had just fixed. Stale frames are dropped.
 *
 * The debounce window (150 ms) stays far below the agent's 800 ms
 * diagnostics wait (`sidecar/lsp/resolver.mjs`), so the hook still sees the
 * settled result. Timers are injectable for tests.
 */

import type { PublishDiagnosticsParams } from "./lsp-client"

type Diagnostic = PublishDiagnosticsParams["diagnostics"][number]

export interface DiagnosticsBufferDeps {
  setTimeout?: (cb: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export const DIAGNOSTICS_DEBOUNCE_MS = 150

/** Stable identity for a diagnostic — used to drop duplicates. */
function diagnosticKey(d: Diagnostic): string {
  const r = d.range
  return [
    d.severity ?? "",
    d.code ?? "",
    d.source ?? "",
    d.message,
    r.start.line,
    r.start.character,
    r.end.line,
    r.end.character,
  ].join("|")
}

/** Remove exact duplicates, preserving first-seen order. */
export function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>()
  const out: Diagnostic[] = []
  for (const d of diagnostics) {
    const key = diagnosticKey(d)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(d)
  }
  return out
}

interface PendingEntry {
  handle: unknown
  params: PublishDiagnosticsParams
}

/**
 * Per-`key:uri` debounce + dedupe + stale-version drop. One instance per
 * `LspService`; `flushKey` cancels pending frames when a server stops.
 */
export class DiagnosticsBuffer {
  private pending = new Map<string, PendingEntry>()
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown
  private readonly clearTimeoutFn: (handle: unknown) => void

  constructor(
    private readonly emit: (key: string, params: PublishDiagnosticsParams) => void,
    deps: DiagnosticsBufferDeps = {}
  ) {
    this.setTimeoutFn = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimeoutFn =
      deps.clearTimeout ?? ((h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]))
  }

  /**
   * Ingest a raw publishDiagnostics frame.
   *
   * @param key composite `${ownerId}:${serverId}` routing key
   * @param params the raw frame (may carry an optional document `version`)
   * @param currentVersion the client's latest didOpen/didChange version for
   *   the uri, or null when untracked — used for the stale-frame drop.
   */
  ingest(key: string, params: PublishDiagnosticsParams, currentVersion: number | null): void {
    if (
      typeof params.version === "number" &&
      typeof currentVersion === "number" &&
      params.version < currentVersion
    ) {
      return // stale: diagnostics for a text the document no longer holds
    }
    const slot = `${key}\n${params.uri}`
    const existing = this.pending.get(slot)
    if (existing) this.clearTimeoutFn(existing.handle)
    const deduped: PublishDiagnosticsParams = {
      ...params,
      diagnostics: dedupeDiagnostics(params.diagnostics ?? []),
    }
    const handle = this.setTimeoutFn(() => {
      this.pending.delete(slot)
      this.emit(key, deduped)
    }, DIAGNOSTICS_DEBOUNCE_MS)
    this.pending.set(slot, { handle, params: deduped })
  }

  /** Drop (without emitting) every pending frame for a routing key. */
  cancelKey(key: string): void {
    const prefix = `${key}\n`
    for (const [slot, entry] of this.pending) {
      if (slot.startsWith(prefix)) {
        this.clearTimeoutFn(entry.handle)
        this.pending.delete(slot)
      }
    }
  }

  /** Cancel everything — service shutdown. */
  dispose(): void {
    for (const entry of this.pending.values()) this.clearTimeoutFn(entry.handle)
    this.pending.clear()
  }
}
