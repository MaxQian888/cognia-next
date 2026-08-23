jest.mock("./api-key-service", () => ({
  WorkflowAppKeyError: class WorkflowAppKeyError extends Error {
    code = "invalid_key"
  },
  authenticateWorkflowAppApiKey: jest.fn(),
}))
jest.mock("./dify-compat", () => ({
  DifyCompatibilityError: class DifyCompatibilityError extends Error {
    code = "invalid_param"
  },
  createDifyWorkflowRun: jest.fn(),
  createDifyChatMessage: jest.fn(),
  stopDifyWorkflowTask: jest.fn(),
  listDifyConversations: jest.fn(),
  listDifyConversationMessages: jest.fn(),
  renameDifyConversation: jest.fn(),
  deleteDifyConversation: jest.fn(),
  updateDifyConversationVariables: jest.fn(),
  difyActor: (user: string) => ({ authenticated: false, externalSubjectKey: `dify:${user}` }),
  formatDifyWorkflowSse: jest.fn((event) => `id: ${event.sequence}\n\n`),
}))
jest.mock("./app-api-service", () => ({
  listWorkflowAppRunEvents: jest.fn(),
  getWorkflowAppRun: jest.fn(),
}))
jest.mock("../quality/quality-service", () => ({
  WorkflowQualityError: class WorkflowQualityError extends Error {
    code = "invalid_feedback"
  },
  removeWorkflowFeedback: jest.fn(),
  submitWorkflowFeedback: jest.fn(),
}))
jest.mock("./file-upload-service", () => ({
  WorkflowAppFileError: class WorkflowAppFileError extends Error {
    code = "invalid_file"
    status = 400
  },
  uploadWorkflowAppFile: jest.fn(),
}))

import { authenticateWorkflowAppApiKey } from "./api-key-service"
import { createDifyChatMessage, createDifyWorkflowRun, listDifyConversations } from "./dify-compat"
import { listWorkflowAppRunEvents } from "./app-api-service"
import { dispatchDifyBridgeCommand } from "./dify-bridge-service"
import { uploadWorkflowAppFile } from "./file-upload-service"

const authenticate = jest.mocked(authenticateWorkflowAppApiKey)

beforeEach(() => {
  jest.clearAllMocks()
  authenticate.mockResolvedValue({
    accountId: "acct_a",
    appId: "app_1",
    appSlug: "review",
    key: { id: "key_1" },
  } as never)
})

it("authenticates and dispatches workflow and chat requests with separate scopes", async () => {
  jest.mocked(createDifyWorkflowRun).mockResolvedValue({ task_id: "run_1" } as never)
  await expect(
    dispatchDifyBridgeCommand("dify_workflow_run", {
      apiKey: "cog_app_secret",
      idempotencyKey: "idem_1",
      request: { inputs: {}, response_mode: "blocking", user: "customer" },
    })
  ).resolves.toEqual({ ok: true, data: { task_id: "run_1" } })
  expect(authenticate).toHaveBeenCalledWith("cog_app_secret", "workflow:run")

  jest.mocked(createDifyChatMessage).mockResolvedValue({ message_id: "message_1" } as never)
  await dispatchDifyBridgeCommand("dify_chat_message", {
    apiKey: "cog_app_secret",
    idempotencyKey: "idem_2",
    request: { query: "Hello", response_mode: "blocking", user: "customer" },
  })
  expect(authenticate).toHaveBeenLastCalledWith("cog_app_secret", "chat:write")
})

it("authenticates and dispatches a quarantined file upload with file scope", async () => {
  jest.mocked(uploadWorkflowAppFile).mockResolvedValue({ id: "upl_1" } as never)
  const bytes = new Uint8Array([1, 2, 3])
  await expect(
    dispatchDifyBridgeCommand("dify_file_upload", {
      apiKey: "cog_app_secret",
      user: "customer",
      name: "photo.png",
      mediaType: "image/png",
      dataBase64: btoa(String.fromCharCode(...bytes)),
    })
  ).resolves.toEqual({ ok: true, data: { id: "upl_1" } })
  expect(authenticate).toHaveBeenCalledWith("cog_app_secret", "file:write")
  expect(uploadWorkflowAppFile).toHaveBeenCalledWith({
    accountId: "acct_a",
    appId: "app_1",
    externalSubjectKey: "dify:customer",
    name: "photo.png",
    declaredMediaType: "image/png",
    bytes,
  })
})

it("returns owner-scoped conversation pages and resumable Dify event frames", async () => {
  jest.mocked(listDifyConversations).mockResolvedValue({ data: [] } as never)
  await dispatchDifyBridgeCommand("dify_conversations_list", {
    apiKey: "cog_app_secret",
    user: "customer",
    limit: 20,
  })
  expect(listDifyConversations).toHaveBeenCalledWith({
    accountId: "acct_a",
    appSlug: "review",
    user: "customer",
    limit: 20,
  })

  jest.mocked(listWorkflowAppRunEvents).mockResolvedValue({
    events: [{ runId: "run_1", sequence: 3, type: "workflow.completed" }],
    nextSequence: 3,
    terminal: true,
  } as never)
  await expect(
    dispatchDifyBridgeCommand("dify_events_list", {
      apiKey: "cog_app_secret",
      runId: "run_1",
      user: "customer",
      afterSequence: 2,
    })
  ).resolves.toMatchObject({ ok: true, data: { frames: ["id: 3\n\n"], terminal: true } })
})

it("rejects malformed requests before calling compatibility services", async () => {
  await expect(
    dispatchDifyBridgeCommand("dify_conversations_list", {
      apiKey: "cog_app_secret",
      user: "customer",
      limit: 101,
    })
  ).resolves.toMatchObject({ ok: false, error: { code: "invalid_param", status: 400 } })
  expect(listDifyConversations).not.toHaveBeenCalled()
})
