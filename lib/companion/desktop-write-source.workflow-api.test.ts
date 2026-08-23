const dispatchWorkflowApiBridgeCommand = jest.fn(
  async (_command: string, _payload: Record<string, unknown>) => ({
    ok: true,
    data: { runId: "run-1" },
  })
)
const probeWorkflowPlacement = jest.fn(async () => ({ compatible: true }))
const createWorkflowApiRun = jest.fn(async () => ({ runId: "run-remote", status: "pending" }))
const dispatchPublicWorkflowAppBridgeCommand = jest.fn(
  async (_command: string, _payload: Record<string, unknown>) => ({
    ok: true,
    data: { app: { slug: "review" } },
  })
)
const dispatchDifyBridgeCommand = jest.fn(
  async (_command: string, _payload: Record<string, unknown>) => ({
    ok: true,
    data: { task_id: "run-1" },
  })
)

jest.mock("@/lib/workflow/api/workflow-api-service", () => ({
  dispatchWorkflowApiBridgeCommand: (command: string, payload: Record<string, unknown>) =>
    dispatchWorkflowApiBridgeCommand(command, payload),
  probeWorkflowPlacement: (payload: Record<string, unknown>) => probeWorkflowPlacement(payload),
  createWorkflowApiRun: (payload: Record<string, unknown>) => createWorkflowApiRun(payload),
}))

jest.mock("@/lib/accounts/active-account-id", () => ({
  getActiveAccountId: () => "acct-1",
}))

jest.mock("@/lib/workflow/apps/public-app-service", () => ({
  dispatchPublicWorkflowAppBridgeCommand: (command: string, payload: Record<string, unknown>) =>
    dispatchPublicWorkflowAppBridgeCommand(command, payload),
}))
jest.mock("@/lib/workflow/apps/dify-bridge-service", () => ({
  dispatchDifyBridgeCommand: (command: string, payload: Record<string, unknown>) =>
    dispatchDifyBridgeCommand(command, payload),
}))

import { dispatchCommand } from "./desktop-write-source"

describe("desktop write source workflow API bridge", () => {
  beforeEach(() => jest.clearAllMocks())

  it.each([
    "workflow_api_run_create",
    "workflow_api_run_get",
    "workflow_api_events_list",
    "workflow_api_run_cancel",
  ])("routes %s to the shared workflow API service", async (command) => {
    const payload = { accountId: "acct-1" }

    await expect(dispatchCommand(command, payload)).resolves.toEqual({
      ok: true,
      data: { runId: "run-1" },
    })
    expect(dispatchWorkflowApiBridgeCommand).toHaveBeenCalledWith(command, payload)
  })

  it.each([
    "workflow_app_bootstrap",
    "workflow_app_run_create",
    "workflow_app_run_get",
    "workflow_app_events_list",
    "workflow_app_run_cancel",
    "workflow_app_chat_message",
    "workflow_app_feedback_submit",
    "workflow_app_mcp",
    "workflow_app_batch_template",
    "workflow_app_batch_create",
    "workflow_app_batch_get",
    "workflow_app_batch_pause",
    "workflow_app_batch_resume",
    "workflow_app_batch_cancel",
    "workflow_app_batch_export",
    "workflow_app_human_input_list",
    "workflow_app_human_input_submit",
    "workflow_app_human_input_file_upload",
  ])("routes %s to the public application authority", async (command) => {
    const payload = { appSlug: "review" }
    await expect(dispatchCommand(command, payload)).resolves.toEqual({
      ok: true,
      data: { app: { slug: "review" } },
    })
    expect(dispatchPublicWorkflowAppBridgeCommand).toHaveBeenCalledWith(command, payload)
  })

  it.each([
    "dify_workflow_run",
    "dify_workflow_status",
    "dify_events_list",
    "dify_task_stop",
    "dify_chat_message",
    "dify_conversations_list",
    "dify_messages_list",
    "dify_conversation_rename",
    "dify_conversation_delete",
    "dify_conversation_variables",
    "dify_message_feedback",
    "dify_file_upload",
  ])("routes %s to the Dify compatibility authority", async (command) => {
    const payload = { apiKey: "cog_app_secret" }
    await expect(dispatchCommand(command, payload)).resolves.toEqual({
      ok: true,
      data: { task_id: "run-1" },
    })
    expect(dispatchDifyBridgeCommand).toHaveBeenCalledWith(command, payload)
  })

  it("probes and admits authenticated Host-to-Host workflow placement", async () => {
    await expect(
      dispatchCommand("workflow_placement_probe", {
        deploymentId: "dep-1",
        expectedVersionDigest: "wfv1:digest",
      })
    ).resolves.toEqual({ compatible: true })
    expect(probeWorkflowPlacement).toHaveBeenCalledWith({
      accountId: "acct-1",
      deploymentId: "dep-1",
      expectedVersionDigest: "wfv1:digest",
      scopes: ["workflow:read"],
    })

    const trigger = {
      workflowId: "wf-1",
      kind: "trigger.cron",
      payload: { scheduled: true },
      originAt: 100,
    }
    await expect(
      dispatchCommand("workflow_handoff_create", {
        deploymentId: "dep-1",
        expectedVersionDigest: "wfv1:digest",
        idempotencyKey: "occurrence-1",
        trigger,
        callerDeviceId: "source-host-device",
      })
    ).resolves.toEqual({ runId: "run-remote", status: "pending" })
    expect(createWorkflowApiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-1",
        deploymentId: "dep-1",
        expectedVersionDigest: "wfv1:digest",
        idempotencyKey: "occurrence-1",
        trigger,
        entrypoint: "trigger",
        caller: "host:source-host-device",
      })
    )
  })
})
