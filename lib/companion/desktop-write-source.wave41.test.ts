/**
 * @jest-environment jsdom
 *
 * Wave 4.1 desktop-write bridge handlers — Workflow CRUD, Twin source/job
 * control, conversation overrides, and app-data backup. Kept in a separate
 * file from `desktop-write-source.test.ts` (which uses real Dexie) so these
 * can mock the underlying Dexie/store ops and assert the dispatch contract in
 * isolation.
 */

import "fake-indexeddb/auto"

jest.mock("@/lib/db/workflows", () => ({
  createWorkflow: jest.fn(async (draft: Record<string, unknown>) => ({ id: "wf1", ...draft })),
  updateWorkflow: jest.fn(async () => undefined),
  deleteWorkflow: jest.fn(async () => undefined),
  listWorkflowRuns: jest.fn(async () => [{ id: "run1", workflowId: "wf1" }]),
}))
jest.mock("@/lib/scheduler/sources/workflow-source", () => ({
  createWorkflowSource: jest.fn(() => ({
    pause: jest.fn(async () => undefined),
    resume: jest.fn(async () => undefined),
  })),
}))
jest.mock("@/lib/workflow/runtime/run-cancel-registry", () => ({
  requestCancelRun: jest.fn(() => true),
}))
jest.mock("@/lib/db/twins", () => ({
  deleteTwin: jest.fn(async () => ({ sources: 2, chunks: 5 })),
}))
jest.mock("@/lib/db/twin-sources", () => ({
  listTwinSourcesByTwin: jest.fn(async () => [{ id: "src1" }]),
  updateTwinSource: jest.fn(async (id: string, patch: Record<string, unknown>) => ({
    id,
    ...patch,
  })),
  deleteTwinSource: jest.fn(async () => undefined),
}))
jest.mock("@/lib/db/twin-jobs", () => ({
  getTwinJob: jest.fn(async () => ({ id: "job1", status: "running" })),
  listActiveJobsByTwin: jest.fn(async () => [{ id: "job1" }]),
  cancelJob: jest.fn(async () => undefined),
  pauseJob: jest.fn(async () => undefined),
  resumeJob: jest.fn(async () => undefined),
  retryDeadLetterJob: jest.fn(async () => undefined),
}))
jest.mock("@/lib/twin/lifecycle", () => ({
  removeTwin: jest.fn(async () => ({
    ok: true,
    removed: true,
    value: { sources: 2, chunks: 5 },
  })),
  removeTwinSource: jest.fn(async () => ({ ok: true, removed: true })),
}))
jest.mock("@/lib/db/conversation-overrides", () => ({
  upsertByConversationKey: jest.fn(async (input: Record<string, unknown>) => ({
    id: "co1",
    ...input,
  })),
}))
jest.mock("@/lib/data/build-package", () => ({
  buildBackupPackage: jest.fn(async () => ({ schemaVersion: 3, tables: {} })),
}))
jest.mock("@/lib/data/apply-package", () => ({
  applyBackupPackage: jest.fn(async () => ({ applied: true })),
}))

import { dispatchCommand } from "./desktop-write-source"

const workflows = jest.requireMock("@/lib/db/workflows") as Record<string, jest.Mock>
const workflowSource = jest.requireMock("@/lib/scheduler/sources/workflow-source") as Record<
  string,
  jest.Mock
>
const cancelRegistry = jest.requireMock("@/lib/workflow/runtime/run-cancel-registry") as Record<
  string,
  jest.Mock
>
const twinJobs = jest.requireMock("@/lib/db/twin-jobs") as Record<string, jest.Mock>
const buildPkg = jest.requireMock("@/lib/data/build-package") as Record<string, jest.Mock>
const applyPkg = jest.requireMock("@/lib/data/apply-package") as Record<string, jest.Mock>

beforeEach(() => jest.clearAllMocks())

describe("dispatchCommand: workflow CRUD", () => {
  it("workflow_create returns the created row", async () => {
    const res = (await dispatchCommand("workflow_create", { draft: { name: "Demo" } })) as {
      workflow: { id: string; name: string }
    }
    expect(workflows.createWorkflow).toHaveBeenCalledWith({ name: "Demo" })
    expect(res.workflow.id).toBe("wf1")
    expect(res.workflow.name).toBe("Demo")
  })

  it("workflow_create rejects a missing draft", async () => {
    await expect(dispatchCommand("workflow_create", {})).rejects.toThrow(/draft is required/)
  })

  it("workflow_update patches by id", async () => {
    const res = await dispatchCommand("workflow_update", { id: "wf1", patch: { name: "New" } })
    expect(workflows.updateWorkflow).toHaveBeenCalledWith("wf1", { name: "New" })
    expect(res).toBeNull()
  })

  it("workflow_update requires id and patch", async () => {
    await expect(dispatchCommand("workflow_update", { id: "wf1" })).rejects.toThrow(
      /patch is required/
    )
    await expect(dispatchCommand("workflow_update", { patch: {} })).rejects.toThrow(
      /id is required/
    )
  })

  it("workflow_delete deletes by id", async () => {
    await dispatchCommand("workflow_delete", { id: "wf1" })
    expect(workflows.deleteWorkflow).toHaveBeenCalledWith("wf1")
  })

  it("workflow_run_list returns runs", async () => {
    const res = (await dispatchCommand("workflow_run_list", { workflowId: "wf1", limit: 10 })) as {
      runs: unknown[]
    }
    expect(workflows.listWorkflowRuns).toHaveBeenCalledWith({
      workflowId: "wf1",
      limit: 10,
      offset: undefined,
    })
    expect(res.runs).toHaveLength(1)
  })

  it("workflow_cancel_run reports a live abort", async () => {
    const res = (await dispatchCommand("workflow_cancel_run", { runId: "run1" })) as {
      cancelled: boolean
      live: boolean
    }
    expect(cancelRegistry.requestCancelRun).toHaveBeenCalledWith("run1", expect.any(String))
    // `mode` joined the payload with the execution-lease work (cross-device
    // cancel); a live in-process abort reports "aborted".
    expect(res).toEqual({ cancelled: true, live: true, mode: "aborted" })
  })

  it("workflow_cancel_run soft-cancels a non-live run", async () => {
    cancelRegistry.requestCancelRun.mockReturnValueOnce(false)
    const { getDb } = await import("@/lib/db/schema")
    await getDb().workflowRuns.put({
      id: "runStale",
      workflowId: "wf1",
      status: "running",
      startedAt: Date.now(),
    } as never)
    const res = (await dispatchCommand("workflow_cancel_run", { runId: "runStale" })) as {
      cancelled: boolean
      live: boolean
    }
    expect(res.live).toBe(false)
    expect(res.cancelled).toBe(true)
    const row = await getDb().workflowRuns.get("runStale")
    expect(row?.status).toBe("cancelled")
  })

  it("workflow_schedule_pause / resume drive the source", async () => {
    await dispatchCommand("workflow_schedule_pause", { triggerId: "t1" })
    await dispatchCommand("workflow_schedule_resume", { triggerId: "t1" })
    expect(workflowSource.createWorkflowSource).toHaveBeenCalledTimes(2)
  })
})

describe("dispatchCommand: twin source/job control", () => {
  it("twin_delete returns the cascade result", async () => {
    const res = (await dispatchCommand("twin_delete", { id: "twin1" })) as { result: unknown }
    expect(res.result).toEqual({ sources: 2, chunks: 5 })
  })

  it("twin_source_list returns sources", async () => {
    const res = (await dispatchCommand("twin_source_list", { twinId: "twin1" })) as {
      sources: unknown[]
    }
    expect(res.sources).toHaveLength(1)
  })

  it("twin_source_update patches and returns the row", async () => {
    const res = (await dispatchCommand("twin_source_update", {
      id: "src1",
      patch: { label: "x" },
    })) as { source: { id: string; label: string } }
    expect(res.source).toEqual({ id: "src1", label: "x" })
  })

  it("twin_source_delete deletes by id", async () => {
    const res = await dispatchCommand("twin_source_delete", { id: "src1" })
    expect(res).toBeNull()
  })

  it("twin_job_status returns one job by id", async () => {
    const res = (await dispatchCommand("twin_job_status", { jobId: "job1" })) as { job: unknown }
    expect(res.job).toEqual({ id: "job1", status: "running" })
  })

  it("twin_job_status lists active jobs by twin", async () => {
    const res = (await dispatchCommand("twin_job_status", { twinId: "twin1" })) as {
      jobs: unknown[]
    }
    expect(res.jobs).toHaveLength(1)
  })

  it("twin_job_status requires jobId or twinId", async () => {
    await expect(dispatchCommand("twin_job_status", {})).rejects.toThrow(/jobId or twinId/)
  })

  it("twin_job_* actions route to the right op", async () => {
    await dispatchCommand("twin_job_cancel", { jobId: "j", reason: "r" })
    await dispatchCommand("twin_job_pause", { jobId: "j" })
    await dispatchCommand("twin_job_resume", { jobId: "j" })
    await dispatchCommand("twin_job_retry", { jobId: "j" })
    expect(twinJobs.cancelJob).toHaveBeenCalledWith("j", "r")
    expect(twinJobs.pauseJob).toHaveBeenCalledWith("j")
    expect(twinJobs.resumeJob).toHaveBeenCalledWith("j")
    expect(twinJobs.retryDeadLetterJob).toHaveBeenCalledWith("j")
  })
})

describe("dispatchCommand: settings + backup", () => {
  it("conversation_overrides_update upserts the input", async () => {
    const res = (await dispatchCommand("conversation_overrides_update", {
      input: { conversationKey: "c1", pinned: true },
    })) as { override: { id: string } }
    expect(res.override.id).toBe("co1")
  })

  it("conversation_overrides_update requires input", async () => {
    await expect(dispatchCommand("conversation_overrides_update", {})).rejects.toThrow(
      /input is required/
    )
  })

  it("backup_export builds a package with secrets excluded", async () => {
    const res = (await dispatchCommand("backup_export", {
      options: { includeSessions: true },
    })) as {
      package: { schemaVersion: number }
    }
    expect(buildPkg.buildBackupPackage).toHaveBeenCalledWith(
      expect.objectContaining({ includeApiKey: false, includeSessions: true })
    )
    expect(res.package.schemaVersion).toBe(3)
  })

  it("backup_import applies a package and requires one", async () => {
    const res = (await dispatchCommand("backup_import", {
      package: { schemaVersion: 3 },
      options: { mergeStrategy: "overwrite" },
    })) as { summary: unknown }
    expect(applyPkg.applyBackupPackage).toHaveBeenCalledWith(
      { schemaVersion: 3 },
      expect.objectContaining({ mergeStrategy: "overwrite", includeApiKey: false })
    )
    expect(res.summary).toEqual({ applied: true })
    await expect(dispatchCommand("backup_import", {})).rejects.toThrow(/package is required/)
  })
})
