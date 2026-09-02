/**
 * `provider usage`: what this install spent, per provider and model, from
 * the two ledgers the CLI actually has.
 *
 *   1. The Dexie `sessionUsage` ledger (the same table the desktop keeps,
 *      restored from `~/.cognia/db.json`), read through the shared
 *      `usage.local.read` operation. Every row names the provider that served
 *      it, so attribution is exact.
 *   2. The canonical session store (`~/.cognia/sessions/<id>/manifest.json`),
 *      which carries cumulative usage per session and, when the runtime
 *      recorded one, the provider it was bound to. A manifest without a
 *      provider is attributed through the model catalog, which is exact for a
 *      model only one configured provider lists and APPROXIMATE for an alias
 *      several providers share. The report says which.
 *
 * Costs are priced by `effectiveCostUsd`, the one pricing path, and an
 * unpriced row is reported as unknown rather than as free.
 */

import type { z } from "zod"
import type { ProviderOperationFailure, usageLocalReadOutput } from "@cognia/provider-types"

import { catalogModelIds } from "@/lib/ai/model-options"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import { aggregateByModel, effectiveCostUsd } from "@/lib/usage/session-analytics"

import { parseManifest, type SessionManifest } from "../agent/session-store/manifest"
import {
  manifestPath,
  realSessionStoreFs,
  sessionsRoot,
  type SessionStoreFs,
} from "../agent/session-store/paths"
import type { ResolvedConfig } from "../config/schema"
import { configuredProviderIds, type CliProviderExecutor } from "./local"

export type UsageLedgerOutput = z.infer<typeof usageLocalReadOutput>
export type UsageAttribution = UsageLedgerOutput["rows"][number]["attribution"]

export interface ProviderUsageRow {
  providerId?: string
  model: string
  attribution: UsageAttribution
  turns: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  /** False when no pricing layer knew the model. `costUsd` is then 0, not free. */
  costKnown: boolean
}

export interface ProviderUsageReport {
  from: number
  to: number
  ledger: {
    rows: ProviderUsageRow[]
    /** Per-provider read failures (the ledger is one operation per provider). */
    failures: Array<{ providerId: string; failure: ProviderOperationFailure }>
    /** Set when the local database could not be opened at all. */
    unavailable?: string
  }
  sessions: {
    rows: ProviderUsageRow[]
    scanned: number
    /** Manifests inside the window that recorded no usage. */
    withoutUsage: number
    /** Rows whose provider came from the catalog, not the session. */
    catalogAttributed: number
    approximate: number
  }
}

export interface ReadUsageDeps {
  config: ResolvedConfig
  executor: CliProviderExecutor
  home: string
  providerId?: string
  from?: number
  to?: number
  now?: () => number
  /** Opens the local database before the ledger read. Defaults to `ensureCliDb`. */
  ensureDb?: () => Promise<void>
  fsx?: SessionStoreFs
  /** Model catalog per provider (tests). Defaults to the shared catalog. */
  modelCatalog?: (providerId: string) => string[]
}

const DAY_MS = 24 * 60 * 60 * 1000

async function defaultEnsureDb(home: string): Promise<void> {
  const { ensureCliDb } = await import("../db/bootstrap")
  await ensureCliDb({ home })
}

function windowOf(deps: ReadUsageDeps): { from: number; to: number } {
  const now = (deps.now ?? Date.now)()
  const to = deps.to ?? now
  const from = deps.from ?? to - 7 * DAY_MS
  if (from >= to) throw new Error("usage window must start before it ends")
  return { from, to }
}

async function readLedger(
  deps: ReadUsageDeps,
  window: { from: number; to: number }
): Promise<ProviderUsageReport["ledger"]> {
  try {
    await (deps.ensureDb ?? (() => defaultEnsureDb(deps.home)))()
  } catch (error) {
    return { rows: [], failures: [], unavailable: (error as Error).message }
  }
  const ids = deps.providerId ? [deps.providerId] : configuredProviderIds(deps.config)
  const rows: ProviderUsageRow[] = []
  const failures: ProviderUsageReport["ledger"]["failures"] = []
  for (const providerId of ids) {
    const result = await deps.executor.execute<UsageLedgerOutput>("usage.local.read", providerId, {
      from: window.from,
      to: window.to,
      providerId,
    })
    if (!result.ok) {
      failures.push({ providerId, failure: result })
      continue
    }
    for (const row of result.output.rows) {
      rows.push({
        providerId: row.providerId ?? providerId,
        model: row.model,
        attribution: row.attribution,
        turns: 0,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        costUsd: row.costUsd,
        costKnown: true,
      })
    }
  }
  return { rows, failures }
}

/** Walk every canonical session manifest under `home`. */
export function readSessionManifests(home: string, fsx: SessionStoreFs): SessionManifest[] {
  const root = sessionsRoot(home)
  if (!fsx.exists(root)) return []
  const manifests: SessionManifest[] = []
  for (const id of fsx.readdir(root)) {
    const path = manifestPath(home, id)
    if (!fsx.exists(path)) continue
    const manifest = parseManifest(fsx.readFile(path))
    if (manifest) manifests.push(manifest)
  }
  return manifests
}

interface Attributed {
  providerId?: string
  attribution: UsageAttribution
}

/**
 * Which configured provider a model belongs to. The session's own binding
 * wins. Otherwise the catalog decides: one listing provider is exact by
 * catalog, several is an alias and only approximate, none is unknown.
 */
export function attributeModel(
  model: string,
  bound: string | undefined,
  config: ResolvedConfig,
  catalog: (providerId: string) => string[]
): Attributed {
  if (bound) return { providerId: bound, attribution: "exact" }
  const listing = configuredProviderIds(config).filter((id) => catalog(id).includes(model))
  if (listing.length === 1) return { providerId: listing[0], attribution: "catalog" }
  if (listing.length > 1) {
    const active = listing.includes(config.provider) ? config.provider : listing[0]
    return { providerId: active, attribution: "approximate" }
  }
  return { attribution: "approximate" }
}

function sessionRows(
  deps: ReadUsageDeps,
  window: { from: number; to: number }
): ProviderUsageReport["sessions"] {
  const fsx = deps.fsx ?? realSessionStoreFs
  const catalog = deps.modelCatalog ?? catalogModelIds
  const manifests = readSessionManifests(deps.home, fsx).filter((manifest) => {
    const at = Date.parse(manifest.updatedAt)
    return Number.isFinite(at) && at >= window.from && at < window.to
  })
  let withoutUsage = 0
  const synthetic: Array<SessionUsageRow & { attribution: UsageAttribution }> = []
  for (const manifest of manifests) {
    const usage = manifest.usage
    if (!usage || ((usage.inputTokens ?? 0) === 0 && (usage.outputTokens ?? 0) === 0)) {
      withoutUsage += 1
      continue
    }
    const model = manifest.runtimeBinding?.model ?? "(unknown)"
    const attributed = attributeModel(
      model,
      manifest.runtimeBinding?.provider,
      deps.config,
      catalog
    )
    if (deps.providerId && attributed.providerId !== deps.providerId) continue
    synthetic.push({
      messageId: manifest.sessionId,
      sessionId: manifest.sessionId,
      at: Date.parse(manifest.updatedAt),
      model,
      ...(attributed.providerId ? { providerId: attributed.providerId } : {}),
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheCreationTokens: usage.cacheCreationTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      costUsd: usage.costUsd ?? 0,
      durationMs: 0,
      attribution: attributed.attribution,
    })
  }

  // Bucket by (provider, attribution) first so the model rollup never merges an
  // exact binding with a catalog guess for the same model id.
  const groups = new Map<string, typeof synthetic>()
  for (const row of synthetic) {
    const key = `${row.providerId ?? ""} ${row.attribution}`
    const slot = groups.get(key) ?? []
    slot.push(row)
    groups.set(key, slot)
  }
  const rows: ProviderUsageRow[] = []
  let catalogAttributed = 0
  let approximate = 0
  for (const group of groups.values()) {
    const first = group[0]!
    for (const bucket of aggregateByModel(group)) {
      const priced = group
        .filter((row) => row.model === bucket.model)
        .some((row) => effectiveCostUsd(row) > 0 || row.costUsd > 0)
      const row: ProviderUsageRow = {
        ...(first.providerId ? { providerId: first.providerId } : {}),
        model: bucket.model,
        attribution: first.attribution,
        turns: bucket.turns,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        costUsd: bucket.costUsd,
        costKnown: priced || bucket.unpricedTurns === 0,
      }
      if (row.attribution === "catalog") catalogAttributed += 1
      if (row.attribution === "approximate") approximate += 1
      rows.push(row)
    }
  }
  rows.sort(
    (a, b) =>
      b.costUsd - a.costUsd ||
      b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
      a.model.localeCompare(b.model)
  )
  return { rows, scanned: manifests.length, withoutUsage, catalogAttributed, approximate }
}

export async function readProviderUsage(deps: ReadUsageDeps): Promise<ProviderUsageReport> {
  const window = windowOf(deps)
  const ledger = await readLedger(deps, window)
  const sessions = sessionRows(deps, window)
  return { from: window.from, to: window.to, ledger, sessions }
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** One line per row. The first column marks how the provider was attributed. */
export function formatUsageRow(row: ProviderUsageRow): string {
  const provider = (row.providerId ?? "?").padEnd(16)
  const model = row.model.padEnd(32)
  const cost = row.costKnown ? `$${row.costUsd.toFixed(4)}` : "cost unknown"
  const mark = row.attribution === "exact" ? " " : row.attribution === "catalog" ? "c" : "~"
  const input = tokens(row.inputTokens).padStart(7)
  const output = tokens(row.outputTokens).padStart(7)
  return `${mark} ${provider} ${model} in ${input}  out ${output}  ${cost}`
}
