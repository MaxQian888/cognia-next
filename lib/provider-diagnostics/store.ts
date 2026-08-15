import type {
  ProviderBalanceSnapshot,
  ProviderDiagnosticJob,
  ProviderDiagnosticSample,
} from "@cognia/provider-types"

import Dexie from "dexie"

import { getDb } from "@/lib/db/schema"

export interface ProviderDiagnosticHistoryQuery {
  providerId?: string
  modelId?: string
  status?: ProviderDiagnosticSample["status"]
  from?: number
  to?: number
  limit?: number
}

export interface ProviderBalanceHistoryQuery {
  providerId?: string
  sourceId?: string
  limit?: number
}

export async function recordProviderDiagnosticJob(
  job: ProviderDiagnosticJob
): Promise<ProviderDiagnosticJob> {
  await getDb().providerDiagnosticJobs.put(job)
  return job
}

export async function recordProviderDiagnosticSample(
  sample: ProviderDiagnosticSample
): Promise<ProviderDiagnosticSample> {
  await getDb().providerDiagnosticSamples.put(sample)
  return sample
}

export async function recordProviderBalanceSnapshot(
  snapshot: ProviderBalanceSnapshot
): Promise<ProviderBalanceSnapshot> {
  await getDb().providerBalanceSnapshots.put(snapshot)
  return snapshot
}

export async function queryProviderDiagnosticHistory(
  query: ProviderDiagnosticHistoryQuery
): Promise<ProviderDiagnosticSample[]> {
  let rows = query.providerId
    ? await getDb().providerDiagnosticSamples.where("providerId").equals(query.providerId).toArray()
    : await getDb().providerDiagnosticSamples.toArray()
  rows = rows.filter(
    (row) =>
      (query.modelId === undefined || row.modelId === query.modelId) &&
      (query.status === undefined || row.status === query.status) &&
      (query.from === undefined || row.startedAt >= query.from) &&
      (query.to === undefined || row.startedAt <= query.to)
  )
  rows.sort((a, b) => b.startedAt - a.startedAt)
  return rows.slice(0, query.limit ?? rows.length)
}

/**
 * Latest sample per provider — one indexed `last()` per distinct provider id
 * over `[providerId+startedAt]` instead of a full-table scan. The provider rail
 * re-derives its diagnostic badges from this on every table change; with the
 * scan that was every sample ever recorded (pruning keeps it bounded, but a
 * busy install still carries thousands of rows).
 */
export async function queryLatestProviderDiagnosticSamples(): Promise<
  Map<string, ProviderDiagnosticSample>
> {
  const table = getDb().providerDiagnosticSamples
  const providerIds = (await table.orderBy("providerId").uniqueKeys()) as string[]
  const latest = new Map<string, ProviderDiagnosticSample>()
  await Promise.all(
    providerIds.map(async (providerId) => {
      const sample = await table
        .where("[providerId+startedAt]")
        .between([providerId, Dexie.minKey], [providerId, Dexie.maxKey])
        .last()
      if (sample) latest.set(providerId, sample)
    })
  )
  return latest
}

/**
 * Latest sample per model for ONE provider (`Map<modelId, sample>`), read from
 * the `providerId` index. Only the selected provider's models need badges, so
 * this replaces scanning every provider's samples for model-level rows.
 */
export async function queryLatestProviderModelDiagnosticSamples(
  providerId: string
): Promise<Map<string, ProviderDiagnosticSample>> {
  const rows = await getDb()
    .providerDiagnosticSamples.where("providerId")
    .equals(providerId)
    .toArray()
  const latest = new Map<string, ProviderDiagnosticSample>()
  for (const row of rows) {
    const key = row.modelId ?? ""
    const current = latest.get(key)
    if (!current || row.startedAt > current.startedAt) latest.set(key, row)
  }
  return latest
}

export async function listProviderBalanceSnapshots(
  query: ProviderBalanceHistoryQuery
): Promise<ProviderBalanceSnapshot[]> {
  let rows = query.providerId
    ? await getDb().providerBalanceSnapshots.where("providerId").equals(query.providerId).toArray()
    : await getDb().providerBalanceSnapshots.toArray()
  if (query.sourceId !== undefined) rows = rows.filter((row) => row.sourceId === query.sourceId)
  rows.sort((a, b) => b.fetchedAt - a.fetchedAt)
  return rows.slice(0, query.limit ?? rows.length)
}

export async function clearProviderDiagnosticHistory(query: {
  providerId?: string
}): Promise<void> {
  const db = getDb()
  await db.transaction(
    "rw",
    db.providerDiagnosticJobs,
    db.providerDiagnosticSamples,
    db.providerBalanceSnapshots,
    async () => {
      if (query.providerId === undefined) {
        await Promise.all([
          db.providerDiagnosticJobs.clear(),
          db.providerDiagnosticSamples.clear(),
          db.providerBalanceSnapshots.clear(),
        ])
        return
      }
      await Promise.all([
        db.providerDiagnosticJobs.where("providerId").equals(query.providerId).delete(),
        db.providerDiagnosticSamples.where("providerId").equals(query.providerId).delete(),
        db.providerBalanceSnapshots.where("providerId").equals(query.providerId).delete(),
      ])
    }
  )
}

export async function pruneProviderDiagnosticHistory({
  now = Date.now(),
  retentionMs = 90 * 24 * 60 * 60 * 1_000,
  rowLimit = 20_000,
}: {
  now?: number
  retentionMs?: number
  rowLimit?: number
} = {}): Promise<void> {
  const db = getDb()
  const cutoff = now - retentionMs
  await db.transaction(
    "rw",
    db.providerDiagnosticJobs,
    db.providerDiagnosticSamples,
    db.providerBalanceSnapshots,
    async () => {
      await Promise.all([
        db.providerDiagnosticJobs.where("startedAt").below(cutoff).delete(),
        db.providerDiagnosticSamples.where("startedAt").below(cutoff).delete(),
        db.providerBalanceSnapshots.where("fetchedAt").below(cutoff).delete(),
      ])

      const [jobs, samples, balances] = await Promise.all([
        db.providerDiagnosticJobs.toArray(),
        db.providerDiagnosticSamples.toArray(),
        db.providerBalanceSnapshots.toArray(),
      ])
      const rows = [
        ...jobs.map((row) => ({ table: "jobs" as const, id: row.id, at: row.startedAt })),
        ...samples.map((row) => ({ table: "samples" as const, id: row.id, at: row.startedAt })),
        ...balances.map((row) => ({ table: "balances" as const, id: row.id, at: row.fetchedAt })),
      ].sort((a, b) => a.at - b.at)
      const overflow = rows.slice(0, Math.max(0, rows.length - Math.max(0, rowLimit)))
      await Promise.all([
        db.providerDiagnosticJobs.bulkDelete(
          overflow.filter((row) => row.table === "jobs").map((row) => row.id)
        ),
        db.providerDiagnosticSamples.bulkDelete(
          overflow.filter((row) => row.table === "samples").map((row) => row.id)
        ),
        db.providerBalanceSnapshots.bulkDelete(
          overflow.filter((row) => row.table === "balances").map((row) => row.id)
        ),
      ])
    }
  )
}

function sanitizedEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return "[INVALID ENDPOINT]"
  }
}

function sanitizedSample(sample: ProviderDiagnosticSample): ProviderDiagnosticSample {
  return {
    ...sample,
    endpoint: sanitizedEndpoint(sample.endpoint),
    ...(sample.failure
      ? { failure: { ...sample.failure, message: "[REDACTED TECHNICAL DETAIL]" } }
      : {}),
  }
}

export async function exportProviderDiagnosticHistory({
  format,
  ...query
}: ProviderDiagnosticHistoryQuery & { format: "json" | "csv" }): Promise<string> {
  const rows = (await queryProviderDiagnosticHistory(query)).map(sanitizedSample)
  if (format === "json") return JSON.stringify(rows, null, 2)
  const columns = [
    "id",
    "jobId",
    "providerId",
    "modelId",
    "endpoint",
    "capability",
    "status",
    "sampleRole",
    "startedAt",
    "completedAt",
    "ttftMs",
    "totalDurationMs",
    "outputTokensPerSecond",
    "estimatedCostUsd",
    "failureCode",
  ]
  const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`
  return [
    columns.join(","),
    ...rows.map((row) =>
      [
        row.id,
        row.jobId,
        row.providerId,
        row.modelId,
        row.endpoint,
        row.capability,
        row.status,
        row.sampleRole,
        row.startedAt,
        row.completedAt,
        row.metrics?.ttftMs,
        row.metrics?.totalDurationMs,
        row.metrics?.outputTokensPerSecond,
        row.metrics?.estimatedCostUsd,
        row.failure?.code,
      ]
        .map(escape)
        .join(",")
    ),
  ].join("\n")
}
