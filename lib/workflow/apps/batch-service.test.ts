/** @jest-environment jsdom */
import "fake-indexeddb/auto"

jest.mock("@/lib/db/workflow-apps", () => ({
  resolvePublishedWorkflowApp: jest.fn(),
  resolveWorkflowAppRelease: jest.fn(),
}))
jest.mock("./app-execution", () => ({
  authorizeWorkflowAppRequest: jest.fn(),
  executePublishedWorkflowApp: jest.fn(),
}))
jest.mock("./app-api-service", () => ({
  cancelWorkflowAppRun: jest.fn(),
}))

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { resolvePublishedWorkflowApp, resolveWorkflowAppRelease } from "@/lib/db/workflow-apps"
import { executePublishedWorkflowApp } from "./app-execution"
import { cancelWorkflowAppRun } from "./app-api-service"
import {
  cancelWorkflowBatch,
  createWorkflowBatch,
  exportWorkflowBatchCsv,
  getWorkflowBatchPage,
  parseWorkflowBatchCsv,
  runWorkflowBatch,
  workflowBatchTemplate,
} from "./batch-service"

async function waitUntil(assertion: () => void | Promise<void>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      await assertion()
      return
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

const actor = { authenticated: false, externalSubjectKey: "anon_1", legalConsentGranted: true }
const resolved = {
  app: { id: "app_1", slug: "review", kind: "workflow" },
  release: {
    id: "release_1",
    versionId: "version_1",
    workflowInterface: {
      inputSchema: {
        type: "object",
        properties: { topic: { type: "string" }, priority: { type: "integer" } },
        required: ["topic"],
      },
    },
  },
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  jest.clearAllMocks()
  jest.mocked(resolvePublishedWorkflowApp).mockResolvedValue(resolved as never)
  jest.mocked(resolveWorkflowAppRelease).mockResolvedValue(resolved as never)
})

afterEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

it("parses quoted RFC 4180 cells and generates a release interface template", () => {
  expect(parseWorkflowBatchCsv('topic,priority\r\n"line 1\nline 2",2')).toEqual([
    ["topic", "priority"],
    ["line 1\nline 2", "2"],
  ])
  expect(workflowBatchTemplate(resolved.release.workflowInterface.inputSchema)).toBe(
    "topic,priority\r\n"
  )
})

it("pins one immutable release and isolates invalid rows", async () => {
  const job = await createWorkflowBatch({
    accountId: "acct_a",
    appSlug: "review",
    actor,
    csv: "topic,priority\r\nAlpha,1\r\n,wrong",
    now: 1_000,
  })
  expect(job).toMatchObject({
    appReleaseId: "release_1",
    totalRows: 2,
    queuedRows: 1,
    failedRows: 1,
  })
  const rows = await getDb().workflowBatchRows.where("jobId").equals(job.id).sortBy("rowNumber")
  expect(rows.map((row) => row.status)).toEqual(["queued", "failed"])
})

it("deduplicates batch creation by app owner and hides pages across owners", async () => {
  const first = await createWorkflowBatch({
    accountId: "acct_a",
    appSlug: "review",
    actor,
    csv: "topic,priority\r\nAlpha,1",
    idempotencyKey: "batch-request-1",
  })
  const replay = await createWorkflowBatch({
    accountId: "acct_a",
    appSlug: "review",
    actor,
    csv: "topic,priority\r\nDifferent,2",
    idempotencyKey: "batch-request-1",
  })
  expect(replay.id).toBe(first.id)
  await expect(
    getWorkflowBatchPage({
      accountId: "acct_a",
      appSlug: "review",
      actor,
      jobId: first.id,
    })
  ).resolves.toMatchObject({ job: { id: first.id }, rows: [{ rowNumber: 1 }] })
  await expect(
    getWorkflowBatchPage({
      accountId: "acct_a",
      appSlug: "review",
      actor: { authenticated: false, externalSubjectKey: "anon_other" },
      jobId: first.id,
    })
  ).rejects.toMatchObject({ code: "access_denied" })
})

it("runs rows with bounded claims and exports row-correlated results", async () => {
  jest.mocked(executePublishedWorkflowApp).mockImplementation(async (input) => {
    input.onAdmitted?.("run_1")
    return {
      runId: "run_1",
      result: { status: "succeeded", output: { approved: true } },
    } as never
  })
  const job = await createWorkflowBatch({
    accountId: "acct_a",
    appSlug: "review",
    actor,
    csv: "topic,priority\r\nAlpha,1",
    concurrency: 2,
  })
  await expect(runWorkflowBatch("acct_a", job.id)).resolves.toMatchObject({
    status: "completed",
    succeededRows: 1,
  })
  expect(executePublishedWorkflowApp).toHaveBeenCalledWith(
    expect.objectContaining({
      resolved,
      actor,
      idempotencyKey: `${job.id}:row:1`,
      input: { topic: "Alpha", priority: 1 },
    })
  )
  await expect(exportWorkflowBatchCsv("acct_a", job.id)).resolves.toContain(
    '1,succeeded,run_1,"{""topic"":""Alpha"",""priority"":1}","{""approved"":true}"'
  )
})

it("leases one runner and recovers abandoned running rows without duplicate admission", async () => {
  let finish!: (value: never) => void
  jest.mocked(executePublishedWorkflowApp).mockImplementation(
    (input) =>
      new Promise((resolve) => {
        input.onAdmitted?.("run_leased")
        finish = resolve
      })
  )
  const job = await createWorkflowBatch({
    accountId: "acct_a",
    appSlug: "review",
    actor,
    csv: "topic,priority\r\nAlpha,1",
  })
  const running = runWorkflowBatch("acct_a", job.id)
  await waitUntil(() => expect(executePublishedWorkflowApp).toHaveBeenCalledTimes(1))
  await expect(runWorkflowBatch("acct_a", job.id)).rejects.toMatchObject({
    code: "invalid_transition",
  })
  finish({
    runId: "run_leased",
    result: { status: "succeeded", output: { ok: true } },
  } as never)
  await expect(running).resolves.toMatchObject({ status: "completed", succeededRows: 1 })

  await getDb().workflowBatchJobs.update(job.id, {
    status: "running",
    runnerLeaseOwner: "dead_runner",
    runnerLeaseExpiresAt: 1,
  })
  const row = await getDb().workflowBatchRows.where("jobId").equals(job.id).first()
  await getDb().workflowBatchRows.update(row!.id, { status: "running" })
  jest.mocked(executePublishedWorkflowApp).mockResolvedValue({
    runId: "run_leased",
    result: { status: "succeeded", output: { ok: true } },
  } as never)
  await expect(runWorkflowBatch("acct_a", job.id)).resolves.toMatchObject({ status: "completed" })
  expect(executePublishedWorkflowApp).toHaveBeenCalledTimes(2)
})

it("surfaces waiting rows without blocking the whole batch and cancels active runs", async () => {
  let rejectRun!: (error: Error) => void
  jest.mocked(executePublishedWorkflowApp).mockImplementation(
    (input) =>
      new Promise((_resolve, reject) => {
        input.onAdmitted?.("run_waiting")
        rejectRun = reject
        void getDb().workflowRuns.put({
          id: "run_waiting",
          workflowId: "workflow_1",
          versionId: "version_1",
          status: "waiting",
          triggerKind: "trigger.manual",
          startedAt: Date.now(),
        } as never)
      })
  )
  const job = await createWorkflowBatch({
    accountId: "acct_a",
    appSlug: "review",
    actor,
    csv: "topic,priority\r\nAlpha,1",
  })
  await expect(runWorkflowBatch("acct_a", job.id)).resolves.toMatchObject({
    status: "running",
    waitingRows: 1,
  })
  await cancelWorkflowBatch("acct_a", job.id)
  expect(cancelWorkflowAppRun).toHaveBeenCalledWith({
    accountId: "acct_a",
    appSlug: "review",
    runId: "run_waiting",
    actor,
  })
  rejectRun(new Error("cancelled"))
  await waitUntil(async () => {
    const row = await getDb().workflowBatchRows.where("jobId").equals(job.id).first()
    expect(row?.status).toBe("cancelled")
  })
})
