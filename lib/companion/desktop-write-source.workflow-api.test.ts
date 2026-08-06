const dispatchWorkflowApiBridgeCommand = jest.fn(
  async (_command: string, _payload: Record<string, unknown>) => ({
    ok: true,
    data: { runId: "run-1" },
  })
)

jest.mock("@/lib/workflow/api/workflow-api-service", () => ({
  dispatchWorkflowApiBridgeCommand: (command: string, payload: Record<string, unknown>) =>
    dispatchWorkflowApiBridgeCommand(command, payload),
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
})
