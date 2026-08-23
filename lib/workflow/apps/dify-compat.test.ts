jest.mock("./app-api-service", () => ({
  admitWorkflowAppRun: jest.fn(),
  getWorkflowAppRun: jest.fn(),
  cancelWorkflowAppRun: jest.fn(),
}))
jest.mock("./chatflow-service", () => ({ sendChatflowMessage: jest.fn() }))
jest.mock("./file-upload-service", () => ({
  WorkflowAppFileError: class WorkflowAppFileError extends Error {
    code = "invalid_file"
  },
  resolveDifyInputFiles: jest.fn(async ({ value }) => value),
}))
jest.mock("@/lib/db/workflow-apps", () => ({
  getWorkflowAppBySlug: jest.fn(async () => ({ id: "app_1" })),
}))

import { admitWorkflowAppRun, cancelWorkflowAppRun, getWorkflowAppRun } from "./app-api-service"
import { sendChatflowMessage } from "./chatflow-service"
import { resolveDifyInputFiles } from "./file-upload-service"
import {
  DIFY_1_16_PROFILE,
  createDifyChatMessage,
  createDifyWorkflowRun,
  difyActor,
  formatDifyWorkflowSse,
  stopDifyWorkflowTask,
} from "./dify-compat"

const admit = admitWorkflowAppRun as jest.MockedFunction<typeof admitWorkflowAppRun>
const getRun = getWorkflowAppRun as jest.MockedFunction<typeof getWorkflowAppRun>
const cancel = cancelWorkflowAppRun as jest.MockedFunction<typeof cancelWorkflowAppRun>
const sendChat = sendChatflowMessage as jest.MockedFunction<typeof sendChatflowMessage>

beforeEach(() => {
  jest.clearAllMocks()
  admit.mockResolvedValue({
    runId: "run_1",
    releaseId: "release_1",
    completion: Promise.resolve({ runId: "run_1", result: {} } as never),
  })
  getRun.mockResolvedValue({
    runId: "run_1",
    workflowId: "wf_1",
    status: "succeeded",
    startedAt: 1_000,
    completedAt: 1_250,
    output: { result: "ok" },
  })
})

describe("dify-1.16 compatibility profile", () => {
  it("keeps Dify user as an app-local external key without member authority", () => {
    expect(difyActor("customer-7")).toEqual({
      authenticated: false,
      externalSubjectKey: "dify:customer-7",
    })
    expect(DIFY_1_16_PROFILE.unsupported).toContain("admin-api")
  })

  it("maps a blocking workflow run to the Dify response contract", async () => {
    const response = await createDifyWorkflowRun({
      accountId: "account_1",
      appSlug: "review",
      idempotencyKey: "request-1",
      request: { inputs: { topic: "release" }, response_mode: "blocking", user: "customer-7" },
    })

    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { authenticated: false, externalSubjectKey: "dify:customer-7" },
        input: { topic: "release" },
      })
    )
    expect(response).toMatchObject({
      workflow_run_id: "run_1",
      task_id: "run_1",
      data: { status: "succeeded", outputs: { result: "ok" }, elapsed_time: 0.25 },
    })
  })

  it("resolves app-owned Dify file mappings before workflow and Chatflow execution", async () => {
    jest.mocked(resolveDifyInputFiles).mockImplementation(async ({ value }) => {
      if (Array.isArray(value)) return [{ ref: "cognia-upload:upl_1", type: "image" }]
      return value
    })
    await createDifyWorkflowRun({
      accountId: "account_1",
      appSlug: "review",
      idempotencyKey: "request-file",
      request: {
        inputs: { topic: "release" },
        files: [{ type: "image", transfer_method: "local_file", upload_file_id: "upl_1" }],
        response_mode: "blocking",
        user: "customer-7",
      },
    })
    expect(admit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: {
          topic: "release",
          files: [{ ref: "cognia-upload:upl_1", type: "image" }],
        },
      })
    )

    sendChat.mockResolvedValue({
      conversation: { id: "conversation_1", revision: 1 },
      answer: { text: "ok", citations: [], files: [], suggestions: [] },
      runId: "run_2",
      reused: false,
    } as never)
    await createDifyChatMessage({
      accountId: "account_1",
      appSlug: "chat",
      idempotencyKey: "message-file",
      request: {
        query: "Review",
        files: [{ type: "image", transfer_method: "local_file", upload_file_id: "upl_1" }],
        response_mode: "blocking",
        user: "customer-7",
      },
    })
    expect(sendChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: {
          text: "Review",
          data: {
            inputs: {},
            files: [{ ref: "cognia-upload:upl_1", type: "image" }],
          },
        },
      })
    )
  })

  it("emits resumable Dify SSE frames with the durable event sequence", () => {
    expect(
      formatDifyWorkflowSse({
        runId: "run_1",
        sequence: 7,
        type: "step.completed",
        timestamp: "2026-01-01T00:00:00.000Z",
        stepId: "answer",
        payload: { output: "done" },
      })
    ).toBe(
      'id: 7\ndata: {"event":"node_finished","task_id":"run_1","workflow_run_id":"run_1","data":{"id":"answer","status":"succeeded","outputs":{"output":"done"}}}\n\n'
    )
  })

  it("maps Chatflow messages and stop without treating user as OIDC", async () => {
    sendChat.mockResolvedValue({
      conversation: { id: "conversation_1", revision: 3 },
      answer: { text: "Reviewed", citations: [], files: [], suggestions: [] },
      runId: "run_2",
      reused: false,
    } as never)
    const response = await createDifyChatMessage({
      accountId: "account_1",
      appSlug: "chat",
      idempotencyKey: "message-1",
      request: { query: "Review this", response_mode: "blocking", user: "customer-7" },
    })
    expect(response).toMatchObject({
      event: "message",
      task_id: "run_2",
      conversation_id: "conversation_1",
      answer: "Reviewed",
    })

    cancel.mockResolvedValue({ runId: "run_2", cancelled: true, mode: "cooperative" })
    await stopDifyWorkflowTask({
      accountId: "account_1",
      appSlug: "chat",
      taskId: "run_2",
      user: "customer-7",
    })
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { authenticated: false, externalSubjectKey: "dify:customer-7" },
      })
    )
  })
})
