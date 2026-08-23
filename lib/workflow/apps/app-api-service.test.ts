jest.mock("@/lib/db/workflow-apps", () => ({
  resolvePublishedWorkflowApp: jest.fn(),
  resolveWorkflowAppRelease: jest.fn(),
}))
jest.mock("./app-execution", () => ({
  authorizeWorkflowAppRequest: jest.fn(() => ({ caller: "external:visitor" })),
  executePublishedWorkflowApp: jest.fn(),
}))
jest.mock("@/lib/workflow/api/workflow-api-service", () => ({
  getWorkflowApiRun: jest.fn(),
  listWorkflowApiEvents: jest.fn(),
  cancelWorkflowApiRun: jest.fn(),
}))

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { resolvePublishedWorkflowApp, resolveWorkflowAppRelease } from "@/lib/db/workflow-apps"
import { executePublishedWorkflowApp } from "./app-execution"
import {
  admitWorkflowAppRun,
  cancelWorkflowAppRun,
  getWorkflowAppRun,
  listWorkflowAppRunEvents,
  WorkflowAppApiError,
} from "./app-api-service"
import {
  cancelWorkflowApiRun,
  getWorkflowApiRun,
  listWorkflowApiEvents,
} from "../api/workflow-api-service"

const dbFixture = createDbTestFixture()
const resolveApp = resolvePublishedWorkflowApp as jest.MockedFunction<
  typeof resolvePublishedWorkflowApp
>
const resolveRelease = resolveWorkflowAppRelease as jest.MockedFunction<
  typeof resolveWorkflowAppRelease
>
const execute = executePublishedWorkflowApp as jest.MockedFunction<
  typeof executePublishedWorkflowApp
>
const getRun = getWorkflowApiRun as jest.MockedFunction<typeof getWorkflowApiRun>
const listEvents = listWorkflowApiEvents as jest.MockedFunction<typeof listWorkflowApiEvents>
const cancelRun = cancelWorkflowApiRun as jest.MockedFunction<typeof cancelWorkflowApiRun>

const resolved = {
  app: { id: "app_1", accountId: "account_1", slug: "review" },
  release: { id: "release_1" },
} as never
const actor = { authenticated: false, externalSubjectKey: "visitor" }

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  jest.clearAllMocks()
  resolveApp.mockResolvedValue(resolved)
  resolveRelease.mockResolvedValue(resolved)
  getRun.mockResolvedValue({
    runId: "run_1",
    workflowId: "wf_1",
    status: "succeeded",
    startedAt: 1,
  })
  listEvents.mockResolvedValue({ events: [], terminal: true })
  cancelRun.mockResolvedValue({ runId: "run_1", cancelled: true, mode: "cooperative" })
})
afterAll(dbFixture.dispose)

describe("application-level workflow API", () => {
  it("returns a stable run id at admission while completion continues", async () => {
    let finish!: (value: never) => void
    execute.mockImplementation(
      ({ onAdmitted }) =>
        new Promise((resolve) => {
          onAdmitted?.("run_1")
          finish = resolve
        })
    )

    const admitted = await admitWorkflowAppRun({
      accountId: "account_1",
      appSlug: "review",
      actor,
      input: { topic: "release" },
      idempotencyKey: "request-1",
    })

    expect(admitted.runId).toBe("run_1")
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        resolved,
        actor,
        entrypoint: "http",
        idempotencyKey: "request-1",
      })
    )
    finish({ runId: "run_1", result: { output: { ok: true } } } as never)
    await expect(admitted.completion).resolves.toMatchObject({ runId: "run_1" })
  })

  it("scopes status, SSE replay, and cancellation to the app release and actor", async () => {
    await getDb().workflowInvocations.put({
      id: "inv_1",
      accountId: "account_1",
      entrypoint: "http",
      caller: "app:app_1:release:release_1:external:visitor",
      deploymentId: "deployment_1",
      deploymentRevision: 1,
      versionId: "version_1",
      runId: "run_1",
      status: "completed",
      createdAt: 1,
      updatedAt: 1,
    })

    await expect(
      getWorkflowAppRun({ accountId: "account_1", appSlug: "review", runId: "run_1", actor })
    ).resolves.toMatchObject({ runId: "run_1" })
    await listWorkflowAppRunEvents({
      accountId: "account_1",
      appSlug: "review",
      runId: "run_1",
      actor,
      afterSequence: 12,
    })
    expect(listEvents).toHaveBeenCalledWith(expect.objectContaining({ afterSequence: 12 }))
    await cancelWorkflowAppRun({
      accountId: "account_1",
      appSlug: "review",
      runId: "run_1",
      actor,
    })
    expect(cancelRun).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_1" }))
  })

  it("does not let an external subject read another subject's run", async () => {
    await getDb().workflowInvocations.put({
      id: "inv_1",
      accountId: "account_1",
      entrypoint: "http",
      caller: "app:app_1:release:release_1:external:other",
      deploymentId: "deployment_1",
      deploymentRevision: 1,
      versionId: "version_1",
      runId: "run_1",
      status: "completed",
      createdAt: 1,
      updatedAt: 1,
    })
    await expect(
      getWorkflowAppRun({ accountId: "account_1", appSlug: "review", runId: "run_1", actor })
    ).rejects.toBeInstanceOf(WorkflowAppApiError)
  })
})
