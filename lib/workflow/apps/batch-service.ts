import { getDb } from "@/lib/db/schema"
import { resolvePublishedWorkflowApp, resolveWorkflowAppRelease } from "@/lib/db/workflow-apps"
import { cancelWorkflowAppRun } from "./app-api-service"
import type { WorkflowAppRequestActor } from "./app-execution"
import { authorizeWorkflowAppRequest, executePublishedWorkflowApp } from "./app-execution"
import type {
  WorkflowBatchJob,
  WorkflowBatchJobStatus,
  WorkflowBatchRow,
  WorkflowBatchRowStatus,
  WorkflowBatchPage,
} from "@/types/workflow/batch"

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const DEFAULT_DEADLINE_MS = 7 * 24 * 60 * 60 * 1_000
const MAX_DEADLINE_MS = 30 * 24 * 60 * 60 * 1_000
const MAX_CSV_BYTES = 10 * 1024 * 1024
const MAX_ROWS = 10_000
const MAX_CONCURRENCY = 16
const RUNNER_LEASE_MS = 30_000
const RUNNER_HEARTBEAT_MS = 10_000
const RUN_STATE_POLL_MS = 250

export class WorkflowBatchError extends Error {
  constructor(
    readonly code:
      | "invalid_csv"
      | "invalid_concurrency"
      | "invalid_deadline"
      | "app_not_found"
      | "job_not_found"
      | "invalid_transition"
      | "access_denied",
    message: string
  ) {
    super(message)
    this.name = "WorkflowBatchError"
  }
}

/** RFC 4180 parser with quoted newline support and deterministic row limits. */
export function parseWorkflowBatchCsv(csv: string): string[][] {
  if (new TextEncoder().encode(csv).byteLength > MAX_CSV_BYTES) {
    throw new WorkflowBatchError("invalid_csv", "CSV input exceeds 10 MiB")
  }
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]
    if (quoted) {
      if (char === '"') {
        if (csv[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
      continue
    }
    if (char === '"' && cell.length === 0) {
      quoted = true
    } else if (char === ",") {
      row.push(cell)
      cell = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && csv[index + 1] === "\n") index += 1
      row.push(cell)
      rows.push(row)
      if (rows.length > MAX_ROWS + 1) {
        throw new WorkflowBatchError("invalid_csv", `CSV input exceeds ${MAX_ROWS} rows`)
      }
      row = []
      cell = ""
    } else {
      cell += char
    }
  }
  if (quoted) throw new WorkflowBatchError("invalid_csv", "CSV contains an unterminated quote")
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  if (rows[0]?.[0]?.startsWith("\uFEFF")) rows[0][0] = rows[0][0].slice(1)
  while (rows.length > 1 && rows.at(-1)?.every((value) => value === "")) rows.pop()
  return rows
}

function objectSchema(value: unknown): {
  properties: Record<string, Record<string, unknown>>
  required: Set<string>
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { properties: {}, required: new Set() }
  }
  const schema = value as Record<string, unknown>
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {}
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : []
  )
  return { properties, required }
}

function coerceCell(raw: string, schema: Record<string, unknown>): unknown {
  if (raw === "") return undefined
  if (Array.isArray(schema.enum) && !schema.enum.some((value) => String(value) === raw)) {
    throw new Error("value is not in the allowed enum")
  }
  switch (schema.type) {
    case "number": {
      const value = Number(raw)
      if (!Number.isFinite(value)) throw new Error("value is not a number")
      return value
    }
    case "integer": {
      const value = Number(raw)
      if (!Number.isSafeInteger(value)) throw new Error("value is not an integer")
      return value
    }
    case "boolean":
      if (["true", "1"].includes(raw.toLowerCase())) return true
      if (["false", "0"].includes(raw.toLowerCase())) return false
      throw new Error("value is not a boolean")
    case "array":
    case "object": {
      const value: unknown = JSON.parse(raw)
      if (schema.type === "array" && !Array.isArray(value)) throw new Error("value is not an array")
      if (
        schema.type === "object" &&
        (!value || typeof value !== "object" || Array.isArray(value))
      ) {
        throw new Error("value is not an object")
      }
      return value
    }
    default:
      return raw
  }
}

function rowsFromCsv(
  csv: string,
  inputSchema: unknown
): Array<{ input: Record<string, unknown>; error?: string }> {
  const rows = parseWorkflowBatchCsv(csv)
  if (rows.length < 2)
    throw new WorkflowBatchError("invalid_csv", "CSV requires a header and one row")
  const headers = rows[0].map((header) => header.trim())
  if (headers.some((header) => !header) || new Set(headers).size !== headers.length) {
    throw new WorkflowBatchError("invalid_csv", "CSV headers must be non-empty and unique")
  }
  const { properties, required } = objectSchema(inputSchema)
  const unknown = headers.filter((header) => !(header in properties))
  if (Object.keys(properties).length > 0 && unknown.length > 0) {
    throw new WorkflowBatchError("invalid_csv", `Unknown CSV columns: ${unknown.join(", ")}`)
  }
  const missingHeaders = [...required].filter((field) => !headers.includes(field))
  if (missingHeaders.length > 0) {
    throw new WorkflowBatchError(
      "invalid_csv",
      `CSV is missing required columns: ${missingHeaders.join(", ")}`
    )
  }
  return rows.slice(1).map((cells) => {
    if (cells.length > headers.length) return { input: {}, error: "Row has too many columns" }
    const input: Record<string, unknown> = {}
    try {
      headers.forEach((header, index) => {
        const value = coerceCell(cells[index] ?? "", properties[header] ?? {})
        if (value !== undefined) input[header] = value
      })
      const missing = [...required].filter((field) => input[field] === undefined)
      if (missing.length > 0) throw new Error(`Missing required values: ${missing.join(", ")}`)
      return { input }
    } catch (error) {
      return { input, error: error instanceof Error ? error.message : "Invalid row" }
    }
  })
}

function csvCell(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "")
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function workflowBatchTemplate(inputSchema: unknown): string {
  const { properties } = objectSchema(inputSchema)
  return `${Object.keys(properties).map(csvCell).join(",")}\r\n`
}

export async function createWorkflowBatch(input: {
  accountId: string
  appSlug: string
  actor: WorkflowAppRequestActor
  csv: string
  concurrency?: number
  deadlineMs?: number
  idempotencyKey?: string
  now?: number
}): Promise<WorkflowBatchJob> {
  const concurrency = input.concurrency ?? 4
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new WorkflowBatchError(
      "invalid_concurrency",
      `Concurrency must be between 1 and ${MAX_CONCURRENCY}`
    )
  }
  const deadlineMs = input.deadlineMs ?? DEFAULT_DEADLINE_MS
  if (!Number.isFinite(deadlineMs) || deadlineMs < 60_000 || deadlineMs > MAX_DEADLINE_MS) {
    throw new WorkflowBatchError(
      "invalid_deadline",
      "Batch deadline must be between 1 minute and 30 days"
    )
  }
  const resolved = await resolvePublishedWorkflowApp(input.accountId, input.appSlug)
  if (!resolved || resolved.app.kind !== "workflow") {
    throw new WorkflowBatchError("app_not_found", "Published Workflow app was not found")
  }
  authorizeWorkflowAppRequest(resolved.release, input.actor)
  const parsed = rowsFromCsv(input.csv, resolved.release.workflowInterface.inputSchema)
  const now = input.now ?? Date.now()
  const id = `wfb_${crypto.randomUUID()}`
  const idempotencyKey = input.idempotencyKey?.trim() || id
  if (idempotencyKey.length > 256) {
    throw new WorkflowBatchError("invalid_transition", "Batch idempotency key is too long")
  }
  const expiresAt = now + DEFAULT_RETENTION_MS
  const failedRows = parsed.filter((row) => row.error).length
  const job: WorkflowBatchJob = {
    id,
    accountId: input.accountId,
    appId: resolved.app.id,
    appSlug: resolved.app.slug,
    appReleaseId: resolved.release.id,
    versionId: resolved.release.versionId,
    actor: structuredClone(input.actor),
    idempotencyKey,
    status: "queued",
    concurrency,
    totalRows: parsed.length,
    queuedRows: parsed.length - failedRows,
    activeRows: 0,
    waitingRows: 0,
    succeededRows: 0,
    failedRows,
    cancelledRows: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt,
    totalDeadlineAt: now + deadlineMs,
  }
  const rows: WorkflowBatchRow[] = parsed.map((parsedRow, index) => ({
    id: `wfbr_${crypto.randomUUID()}`,
    accountId: input.accountId,
    jobId: id,
    rowNumber: index + 1,
    idempotencyKey: `${id}:row:${index + 1}`,
    input: parsedRow.input,
    status: parsedRow.error ? "failed" : "queued",
    attempts: 0,
    ...(parsedRow.error
      ? { error: { code: "input_schema_violation", message: parsedRow.error } }
      : {}),
    createdAt: now,
    updatedAt: now,
    expiresAt,
  }))
  const db = getDb()
  return db.transaction("rw", [db.workflowBatchJobs, db.workflowBatchRows], async () => {
    if (input.idempotencyKey) {
      const existing = await db.workflowBatchJobs
        .where("appId")
        .equals(resolved.app.id)
        .filter(
          (candidate) =>
            candidate.idempotencyKey === idempotencyKey &&
            candidate.actor.externalSubjectKey === input.actor.externalSubjectKey &&
            candidate.actor.subjectId === input.actor.subjectId
        )
        .first()
      if (existing) return existing
    }
    await db.workflowBatchJobs.add(job)
    await db.workflowBatchRows.bulkAdd(rows)
    return job
  })
}

async function getJob(accountId: string, jobId: string): Promise<WorkflowBatchJob> {
  const job = await getDb().workflowBatchJobs.get(jobId)
  if (!job || job.accountId !== accountId) {
    throw new WorkflowBatchError("job_not_found", "Workflow batch was not found")
  }
  return job
}

function ownsJob(job: WorkflowBatchJob, appSlug: string, actor: WorkflowAppRequestActor): boolean {
  return (
    job.appSlug === appSlug &&
    job.actor.authenticated === actor.authenticated &&
    job.actor.externalSubjectKey === actor.externalSubjectKey &&
    job.actor.subjectId === actor.subjectId
  )
}

export async function authorizeWorkflowBatch(input: {
  accountId: string
  appSlug: string
  actor: WorkflowAppRequestActor
  jobId: string
}): Promise<WorkflowBatchJob> {
  const job = await getJob(input.accountId, input.jobId)
  if (!ownsJob(job, input.appSlug, input.actor)) {
    throw new WorkflowBatchError("access_denied", "Workflow batch was not found")
  }
  return job
}

export async function getWorkflowBatchPage(input: {
  accountId: string
  appSlug: string
  actor: WorkflowAppRequestActor
  jobId: string
  afterRowNumber?: number
  limit?: number
}): Promise<WorkflowBatchPage> {
  const job = await authorizeWorkflowBatch(input)
  const limit = Math.min(200, Math.max(1, input.limit ?? 50))
  const after = Math.max(0, input.afterRowNumber ?? 0)
  const rows = await getDb()
    .workflowBatchRows.where("[jobId+rowNumber]")
    .between([job.id, after + 1], [job.id, Number.MAX_SAFE_INTEGER])
    .limit(limit + 1)
    .toArray()
  const hasMore = rows.length > limit
  const pageRows = rows.slice(0, limit)
  return {
    job,
    rows: pageRows,
    ...(hasMore ? { nextRowNumber: pageRows.at(-1)?.rowNumber } : {}),
  }
}

export async function getWorkflowBatchTemplate(input: {
  accountId: string
  appSlug: string
  actor: WorkflowAppRequestActor
}): Promise<string> {
  const resolved = await resolvePublishedWorkflowApp(input.accountId, input.appSlug)
  if (!resolved || resolved.app.kind !== "workflow") {
    throw new WorkflowBatchError("app_not_found", "Published Workflow app was not found")
  }
  authorizeWorkflowAppRequest(resolved.release, input.actor)
  return workflowBatchTemplate(resolved.release.workflowInterface.inputSchema)
}

async function claimRow(job: WorkflowBatchJob): Promise<WorkflowBatchRow | undefined> {
  const db = getDb()
  return db.transaction("rw", [db.workflowBatchJobs, db.workflowBatchRows], async () => {
    const current = await db.workflowBatchJobs.get(job.id)
    if (!current || current.status !== "running" || current.totalDeadlineAt <= Date.now())
      return undefined
    const row = await db.workflowBatchRows
      .where("[jobId+status]")
      .equals([job.id, "queued"])
      .first()
    if (!row) return undefined
    const updated = await db.workflowBatchRows.update(row.id, {
      status: "running",
      attempts: row.attempts + 1,
      updatedAt: Date.now(),
    })
    return updated ? { ...row, status: "running", attempts: row.attempts + 1 } : undefined
  })
}

async function acquireRunnerLease(
  accountId: string,
  jobId: string,
  runnerId: string
): Promise<WorkflowBatchJob> {
  const db = getDb()
  return db.transaction("rw", [db.workflowBatchJobs, db.workflowBatchRows], async () => {
    const job = await db.workflowBatchJobs.get(jobId)
    if (!job || job.accountId !== accountId) {
      throw new WorkflowBatchError("job_not_found", "Workflow batch was not found")
    }
    if (!["queued", "running", "paused"].includes(job.status)) {
      throw new WorkflowBatchError("invalid_transition", `Cannot run a ${job.status} batch`)
    }
    const now = Date.now()
    if (
      job.runnerLeaseOwner &&
      job.runnerLeaseOwner !== runnerId &&
      (job.runnerLeaseExpiresAt ?? 0) > now
    ) {
      throw new WorkflowBatchError("invalid_transition", "Workflow batch already has a runner")
    }
    if (job.runnerLeaseOwner && (job.runnerLeaseExpiresAt ?? 0) <= now) {
      const abandoned = await db.workflowBatchRows
        .where("[jobId+status]")
        .equals([jobId, "running"])
        .toArray()
      await db.workflowBatchRows.bulkPut(
        abandoned.map((row) => ({ ...row, status: "queued" as const, updatedAt: now }))
      )
    }
    const leased: WorkflowBatchJob = {
      ...job,
      status: "running",
      runnerLeaseOwner: runnerId,
      runnerLeaseExpiresAt: now + RUNNER_LEASE_MS,
      updatedAt: now,
    }
    await db.workflowBatchJobs.put(leased)
    return leased
  })
}

async function renewRunnerLease(jobId: string, runnerId: string): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.workflowBatchJobs, async () => {
    const job = await db.workflowBatchJobs.get(jobId)
    if (!job || job.runnerLeaseOwner !== runnerId) return false
    await db.workflowBatchJobs.update(jobId, {
      runnerLeaseExpiresAt: Date.now() + RUNNER_LEASE_MS,
      updatedAt: Date.now(),
    })
    return true
  })
}

async function releaseRunnerLease(jobId: string, runnerId: string): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.workflowBatchJobs, async () => {
    const job = await db.workflowBatchJobs.get(jobId)
    if (!job || job.runnerLeaseOwner !== runnerId) return
    const { runnerLeaseOwner: _owner, runnerLeaseExpiresAt: _expires, ...released } = job
    await db.workflowBatchJobs.put({ ...released, updatedAt: Date.now() })
  })
}

async function settleRow(
  row: WorkflowBatchRow,
  patch: Pick<WorkflowBatchRow, "status"> & Partial<WorkflowBatchRow>
): Promise<void> {
  await getDb().workflowBatchRows.update(row.id, { ...patch, updatedAt: Date.now() })
}

async function refreshJob(jobId: string): Promise<WorkflowBatchJob | undefined> {
  const db = getDb()
  return db.transaction("rw", [db.workflowBatchJobs, db.workflowBatchRows], async () => {
    const job = await db.workflowBatchJobs.get(jobId)
    if (!job) return undefined
    const rows = await db.workflowBatchRows.where("jobId").equals(jobId).toArray()
    const count = (status: WorkflowBatchRowStatus) =>
      rows.filter((row) => row.status === status).length
    const counts = {
      queuedRows: count("queued"),
      activeRows: count("running"),
      waitingRows: count("waiting"),
      succeededRows: count("succeeded"),
      failedRows: count("failed"),
      cancelledRows: count("cancelled"),
    }
    let status: WorkflowBatchJobStatus = job.status
    const now = Date.now()
    if (job.status === "pausing" && counts.activeRows === 0) status = "paused"
    if (job.status === "cancelling" && counts.activeRows + counts.waitingRows === 0)
      status = "cancelled"
    if (job.totalDeadlineAt <= now && counts.queuedRows > 0) {
      const queued = rows.filter((row) => row.status === "queued")
      await db.workflowBatchRows.bulkPut(
        queued.map((row) => ({ ...row, status: "cancelled" as const, updatedAt: now }))
      )
      counts.cancelledRows += queued.length
      counts.queuedRows = 0
      status = counts.activeRows + counts.waitingRows > 0 ? "cancelling" : "cancelled"
    }
    if (
      ["running", "queued"].includes(job.status) &&
      counts.queuedRows + counts.activeRows + counts.waitingRows === 0
    ) {
      status = "completed"
    }
    const updated: WorkflowBatchJob = {
      ...job,
      ...counts,
      status,
      updatedAt: now,
      ...(["completed", "cancelled", "failed"].includes(status) ? { completedAt: now } : {}),
    }
    await db.workflowBatchJobs.put(updated)
    return updated
  })
}

async function reconcileWaitingRows(job: WorkflowBatchJob): Promise<void> {
  const db = getDb()
  const waiting = await db.workflowBatchRows
    .where("[jobId+status]")
    .equals([job.id, "waiting"])
    .toArray()
  for (const row of waiting) {
    if (!row.runId) continue
    const run = await db.workflowRuns.get(row.runId)
    if (!run || ["pending", "running", "waiting", "paused"].includes(run.status)) continue
    if (run.status === "succeeded") {
      await settleRow(row, { status: "succeeded", output: run.output })
    } else if (run.status === "cancelled") {
      await settleRow(row, { status: "cancelled" })
    } else {
      await settleRow(row, {
        status: "failed",
        error: {
          code: "row_execution_failed",
          message: run.error?.message?.slice(0, 500) ?? "Workflow run failed",
        },
      })
    }
  }
}

async function cancelRowRun(job: WorkflowBatchJob, row: WorkflowBatchRow): Promise<void> {
  if (!row.runId) return
  try {
    await cancelWorkflowAppRun({
      accountId: job.accountId,
      appSlug: job.appSlug,
      runId: row.runId,
      actor: job.actor,
    })
  } catch {
    // Cancellation remains idempotent at the row layer. A terminal or already
    // deleted run is reconciled from the durable run row below.
  }
}

async function settleExecutionResult(
  job: WorkflowBatchJob,
  row: WorkflowBatchRow,
  result: Awaited<ReturnType<typeof executePublishedWorkflowApp>>
): Promise<void> {
  if (["pending", "running", "waiting", "paused"].includes(result.result.status)) {
    await settleRow(row, {
      status:
        result.result.status === "waiting" || result.result.status === "paused"
          ? "waiting"
          : "running",
      runId: result.runId,
    })
    return
  }
  if (result.result.status === "succeeded") {
    await settleRow(row, { status: "succeeded", runId: result.runId, output: result.result.output })
    return
  }
  const latest = await getDb().workflowBatchJobs.get(job.id)
  if (result.result.status === "cancelled" || latest?.status === "cancelling") {
    await settleRow(row, { status: "cancelled", runId: result.runId })
    return
  }
  await settleRow(row, {
    status: "failed",
    runId: result.runId,
    error: {
      code: "row_execution_failed",
      message: result.result.error?.message?.slice(0, 500) ?? "Workflow run failed",
    },
  })
}

async function waitForRowControlState(
  job: WorkflowBatchJob,
  row: WorkflowBatchRow,
  runId: Promise<string>
): Promise<"waiting" | "cancel" | "deadline"> {
  const admittedRunId = await runId
  while (true) {
    const [currentJob, run] = await Promise.all([
      getDb().workflowBatchJobs.get(job.id),
      getDb().workflowRuns.get(admittedRunId),
    ])
    if (!currentJob || currentJob.status === "cancelling") return "cancel"
    if (currentJob.totalDeadlineAt <= Date.now()) return "deadline"
    if (run?.status === "waiting" || run?.status === "paused") {
      await settleRow(row, { status: "waiting", runId: admittedRunId })
      return "waiting"
    }
    await new Promise((resolve) => setTimeout(resolve, RUN_STATE_POLL_MS))
  }
}

async function executeRow(job: WorkflowBatchJob, row: WorkflowBatchRow): Promise<void> {
  const resolved = await resolveWorkflowAppRelease(job.accountId, job.appId, job.appReleaseId)
  if (!resolved || resolved.release.versionId !== job.versionId) {
    await settleRow(row, {
      status: "failed",
      error: { code: "release_not_found", message: "Pinned application release is unavailable" },
    })
    return
  }
  try {
    let admit!: (runId: string) => void
    const admitted = new Promise<string>((resolve) => {
      admit = resolve
    })
    const completion = executePublishedWorkflowApp({
      resolved,
      actor: job.actor,
      input: row.input,
      idempotencyKey: row.idempotencyKey,
      entrypoint: "http",
      onAdmitted: (runId) => {
        admit(runId)
        void getDb().workflowBatchRows.update(row.id, { runId, updatedAt: Date.now() })
      },
    })
    const outcome = await Promise.race([
      completion.then((result) => ({ kind: "completed" as const, result })),
      waitForRowControlState(job, row, admitted).then((state) => ({ kind: state }) as const),
    ])
    if (outcome.kind === "completed") {
      await settleExecutionResult(job, row, outcome.result)
      return
    }
    if (outcome.kind === "waiting") {
      void completion
        .then((result) => settleExecutionResult(job, row, result))
        .then(() => refreshJob(job.id))
        .catch(async (error) => {
          const latest = await getDb().workflowBatchJobs.get(job.id)
          await settleRow(row, {
            status: latest?.status === "cancelling" ? "cancelled" : "failed",
            ...(latest?.status === "cancelling"
              ? {}
              : {
                  error: {
                    code: "row_execution_failed",
                    message:
                      error instanceof Error ? error.message.slice(0, 500) : "Row execution failed",
                  },
                }),
          })
          await refreshJob(job.id)
        })
      return
    }
    await cancelRowRun(job, { ...row, runId: await admitted })
    await settleRow(row, { status: "cancelled", runId: await admitted })
  } catch (error) {
    const latest = await getDb().workflowBatchJobs.get(job.id)
    await settleRow(row, {
      status: latest?.status === "cancelling" ? "cancelled" : "failed",
      ...(latest?.status === "cancelling"
        ? {}
        : {
            error: {
              code: "row_execution_failed",
              message:
                error instanceof Error ? error.message.slice(0, 500) : "Row execution failed",
            },
          }),
    })
  }
}

/** Run/recover a batch. Row claims make concurrent recovery runners safe. */
export async function runWorkflowBatch(
  accountId: string,
  jobId: string
): Promise<WorkflowBatchJob> {
  const runnerId = `wfbrun_${crypto.randomUUID()}`
  const job = await acquireRunnerLease(accountId, jobId, runnerId)
  await reconcileWaitingRows(job)
  const heartbeat = setInterval(() => {
    void renewRunnerLease(jobId, runnerId)
  }, RUNNER_HEARTBEAT_MS)
  const worker = async () => {
    while (true) {
      const row = await claimRow(job)
      if (!row) return
      await executeRow(job, row)
      await refreshJob(job.id)
    }
  }
  try {
    await Promise.all(Array.from({ length: job.concurrency }, () => worker()))
    const refreshed = await refreshJob(job.id)
    if (!refreshed) throw new WorkflowBatchError("job_not_found", "Workflow batch was not found")
    return refreshed
  } finally {
    clearInterval(heartbeat)
    await releaseRunnerLease(jobId, runnerId)
  }
}

export async function pauseWorkflowBatch(
  accountId: string,
  jobId: string
): Promise<WorkflowBatchJob> {
  const job = await getJob(accountId, jobId)
  if (job.status !== "running") {
    throw new WorkflowBatchError("invalid_transition", "Only a running batch can be paused")
  }
  await getDb().workflowBatchJobs.update(jobId, { status: "pausing", updatedAt: Date.now() })
  return (await refreshJob(jobId))!
}

export function resumeWorkflowBatch(accountId: string, jobId: string): Promise<WorkflowBatchJob> {
  return runWorkflowBatch(accountId, jobId)
}

export async function cancelWorkflowBatch(
  accountId: string,
  jobId: string
): Promise<WorkflowBatchJob> {
  const job = await getJob(accountId, jobId)
  if (["completed", "cancelled", "failed"].includes(job.status)) return job
  const db = getDb()
  await db.transaction("rw", [db.workflowBatchJobs, db.workflowBatchRows], async () => {
    await db.workflowBatchJobs.update(jobId, { status: "cancelling", updatedAt: Date.now() })
    const queued = await db.workflowBatchRows
      .where("[jobId+status]")
      .equals([jobId, "queued"])
      .toArray()
    await db.workflowBatchRows.bulkPut(
      queued.map((row) => ({ ...row, status: "cancelled", updatedAt: Date.now() }))
    )
  })
  const active = await db.workflowBatchRows
    .where("jobId")
    .equals(jobId)
    .filter((row) => (row.status === "running" || row.status === "waiting") && !!row.runId)
    .toArray()
  await Promise.all(active.map((row) => cancelRowRun(job, row)))
  return (await refreshJob(jobId))!
}

export async function exportWorkflowBatchCsv(accountId: string, jobId: string): Promise<string> {
  await getJob(accountId, jobId)
  const rows = await getDb().workflowBatchRows.where("jobId").equals(jobId).sortBy("rowNumber")
  return [
    ["row_number", "status", "run_id", "input", "output", "error"].join(","),
    ...rows.map((row) =>
      [row.rowNumber, row.status, row.runId ?? "", row.input, row.output ?? "", row.error ?? ""]
        .map(csvCell)
        .join(",")
    ),
  ].join("\r\n")
}

export async function pruneExpiredWorkflowBatches(now = Date.now()): Promise<number> {
  const db = getDb()
  const jobs = await db.workflowBatchJobs.where("expiresAt").belowOrEqual(now).toArray()
  await db.transaction("rw", [db.workflowBatchJobs, db.workflowBatchRows], async () => {
    for (const job of jobs) {
      await db.workflowBatchRows.where("jobId").equals(job.id).delete()
      await db.workflowBatchJobs.delete(job.id)
    }
  })
  return jobs.length
}
