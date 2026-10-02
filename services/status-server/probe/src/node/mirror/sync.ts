/**
 * Periodic copy of the primary's public, sanitized read surface (plan §12):
 * the four snapshot ranges plus the Atom and RSS feeds.
 *
 * Every copy is validated before it replaces the previous one — a snapshot
 * must parse under contract v1, match its requested range, fit in 256 KiB and
 * not go backwards in revision; a feed must be bounded XML. A failure keeps
 * the previous file, so the page shows the last good evidence with its
 * original timestamps (and computes staleness itself) rather than nothing or
 * something fabricated. Replacement is atomic (temp file + rename).
 */

import { mkdir, open, readFile, rename } from "node:fs/promises"
import path from "node:path"

import {
  HISTORY_RANGES,
  MAX_SNAPSHOT_BYTES,
  type HistoryRange,
} from "../../../../../../lib/status/contract"
import { parsePublicSnapshot } from "../../../../../../lib/status/validate"

import { getText, type FetchLike } from "../http"
import type { Logger } from "../logger"

const MAX_FEED_BYTES = 1024 * 1024
const SYNC_TIMEOUT_MS = 10_000
export const SYNC_STATE_FILE = "sync-state.json"

export interface MirrorResource {
  name: string
  /** Path below the API base. */
  apiPath: string
  file: string
  contentType: string
  kind: "snapshot" | "feed"
  range?: HistoryRange
}

export const MIRROR_RESOURCES: readonly MirrorResource[] = [
  ...HISTORY_RANGES.map((range): MirrorResource => ({
    name: `snapshot-${range}`,
    apiPath: `/snapshot?range=${range}`,
    file: `snapshot-${range}.json`,
    contentType: "application/json; charset=utf-8",
    kind: "snapshot",
    range,
  })),
  {
    name: "feed.atom",
    apiPath: "/feed.atom",
    file: "feed.atom",
    contentType: "application/atom+xml; charset=utf-8",
    kind: "feed",
  },
  {
    name: "feed.rss",
    apiPath: "/feed.rss",
    file: "feed.rss",
    contentType: "application/rss+xml; charset=utf-8",
    kind: "feed",
  },
]

export interface SyncState {
  lastSyncAt: string | null
  lastSyncOk: boolean | null
  resources: Record<string, { lastSuccessAt: string | null; lastError: string | null }>
}

export type ResourceOutcome = "updated" | "unchanged" | "failed"

class SyncFailure extends Error {}

export async function writeFileAtomic(
  dir: string,
  name: string,
  data: string | Uint8Array
): Promise<void> {
  const tmp = path.join(dir, `.tmp-${name}-${process.pid}-${Date.now()}`)
  const handle = await open(tmp, "wx", 0o644)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, path.join(dir, name))
}

export async function readSyncState(dataDir: string): Promise<SyncState> {
  try {
    const raw = JSON.parse(await readFile(path.join(dataDir, SYNC_STATE_FILE), "utf8")) as SyncState
    if (raw && typeof raw === "object" && typeof raw.resources === "object") return raw
  } catch {
    // No state yet (first boot) or unreadable: report "never synced".
  }
  return { lastSyncAt: null, lastSyncOk: null, resources: {} }
}

export interface MirrorSyncOptions {
  sourceApiBase: string
  dataDir: string
  logger: Logger
  fetchImpl?: FetchLike
  now?: () => number
  timeoutMs?: number
}

export class MirrorSync {
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private running: Promise<unknown> | null = null
  private readonly controller = new AbortController()
  private readonly now: () => number

  constructor(private readonly options: MirrorSyncOptions) {
    this.now = options.now ?? Date.now
  }

  /** Sync now, then every `intervalMs`. */
  start(intervalMs: number): void {
    if (!this.stopped) return
    this.stopped = false
    const loop = async () => {
      if (this.stopped) return
      this.running = this.syncOnce().catch(() => undefined)
      await this.running
      if (this.stopped) return
      this.timer = setTimeout(loop, intervalMs)
    }
    void loop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.controller.abort()
    if (this.timer) clearTimeout(this.timer)
    await this.running
  }

  async syncOnce(): Promise<Record<string, ResourceOutcome>> {
    await mkdir(this.options.dataDir, { recursive: true, mode: 0o755 })
    const state = await readSyncState(this.options.dataDir)
    const outcomes: Record<string, ResourceOutcome> = {}
    const at = new Date(this.now()).toISOString()
    for (const resource of MIRROR_RESOURCES) {
      if (this.controller.signal.aborted) break
      const previous = state.resources[resource.name] ?? { lastSuccessAt: null, lastError: null }
      try {
        outcomes[resource.name] = await this.syncResource(resource)
        state.resources[resource.name] = { lastSuccessAt: at, lastError: null }
      } catch (error) {
        outcomes[resource.name] = "failed"
        const reason = error instanceof SyncFailure ? error.message : "fetch_failed"
        state.resources[resource.name] = {
          lastSuccessAt: previous.lastSuccessAt,
          lastError: reason,
        }
        this.options.logger.warn("mirror_sync_failed", { resource: resource.name, reason })
      }
    }
    if (this.controller.signal.aborted) {
      // Shutdown cut the pass short: files already replaced are valid, but
      // the pass as a whole is not a successful sync, so leave the state as is.
      this.options.logger.info("mirror_sync_aborted", {})
      return outcomes
    }
    state.lastSyncAt = at
    state.lastSyncOk = Object.values(outcomes).every((outcome) => outcome !== "failed")
    await writeFileAtomic(this.options.dataDir, SYNC_STATE_FILE, JSON.stringify(state))
    this.options.logger.info("mirror_sync", {
      ok: state.lastSyncOk,
      updated: Object.values(outcomes).filter((outcome) => outcome === "updated").length,
      failed: Object.values(outcomes).filter((outcome) => outcome === "failed").length,
    })
    return outcomes
  }

  private async syncResource(resource: MirrorResource): Promise<ResourceOutcome> {
    const url = `${this.options.sourceApiBase.replace(/\/+$/, "")}${resource.apiPath}`
    const response = await getText(url, {
      timeoutMs: this.options.timeoutMs ?? SYNC_TIMEOUT_MS,
      maxBytes: resource.kind === "snapshot" ? MAX_SNAPSHOT_BYTES : MAX_FEED_BYTES,
      signal: this.controller.signal,
      accept: resource.kind === "snapshot" ? "application/json" : "application/xml",
      fetchImpl: this.options.fetchImpl,
      userAgent: "cognia-status-mirror",
    })
    if (response.status !== 200) throw new SyncFailure(`http_${response.status}`)
    if (response.text === null || response.bytes === null) throw new SyncFailure("too_large")
    if (resource.kind === "snapshot") return this.storeSnapshot(resource, response.text)
    const trimmed = response.text.trimStart()
    const xml =
      /xml/i.test(response.contentType) && trimmed.startsWith("<") && /<(feed|rss)\b/i.test(trimmed)
    if (!xml) throw new SyncFailure("not_a_feed")
    await writeFileAtomic(this.options.dataDir, resource.file, response.bytes)
    return "updated"
  }

  private async storeSnapshot(resource: MirrorResource, text: string): Promise<ResourceOutcome> {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new SyncFailure("not_json")
    }
    const parsed = parsePublicSnapshot(json)
    if (!parsed.ok) throw new SyncFailure("schema_mismatch")
    if (parsed.value.range !== resource.range) throw new SyncFailure("range_mismatch")
    const current = await this.readStoredRevision(resource.file)
    if (current !== null && parsed.value.revision < current) {
      // An older aggregate (e.g. from a stale cache) never replaces a newer one.
      return "unchanged"
    }
    // A read-only mirror cannot take subscriptions, whatever the primary says.
    const sanitized = {
      ...parsed.value,
      capabilities: { ...parsed.value.capabilities, email: false },
    }
    const body = JSON.stringify(sanitized)
    if (new TextEncoder().encode(body).byteLength > MAX_SNAPSHOT_BYTES)
      throw new SyncFailure("too_large")
    await writeFileAtomic(this.options.dataDir, resource.file, body)
    return "updated"
  }

  private async readStoredRevision(file: string): Promise<number | null> {
    try {
      const stored = JSON.parse(await readFile(path.join(this.options.dataDir, file), "utf8")) as {
        revision?: unknown
      }
      return typeof stored.revision === "number" ? stored.revision : null
    } catch {
      return null
    }
  }
}
