import type { WorkflowHumanInputRequest } from "@/types/workflow/human-input"
import {
  HUMAN_INPUT_PENDING_PUSH_CHANNEL,
  HUMAN_INPUT_REQUEST_CHANNEL,
  HUMAN_INPUT_RESOLVED_CHANNEL,
  notifyHumanInputRequested,
  notifyHumanInputResolved,
} from "./human-input-notify"

const request: WorkflowHumanInputRequest = {
  id: "hir_1",
  accountId: "account_1",
  waitpointId: "wp_1",
  status: "pending",
  runId: "run_1",
  workflowId: "wf_1",
  stepId: "step_1",
  title: "Review request",
  message: "Contains foreground-only detail",
  fields: [{ id: "answer", type: "short-text", label: "Answer", sensitive: true }],
  actions: [{ id: "submit", label: "Submit" }],
  assignees: [{ kind: "member", id: "member_1" }],
  completionPolicy: { mode: "any" },
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 2,
}

describe("human-input-notify", () => {
  it("delivers the full request in-app and an identifiers-only background push", async () => {
    const notify = jest.fn(async () => "notification_1")
    const emit = jest.fn(async (_event: string, _payload: unknown) => undefined)

    await notifyHumanInputRequested(request, { notify, emit, isTauriFn: () => true })

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Review request",
        body: "Contains foreground-only detail",
        dedupeKey: "hir_1",
      })
    )
    expect(emit).toHaveBeenCalledWith(HUMAN_INPUT_REQUEST_CHANNEL, request)
    expect(emit).toHaveBeenCalledWith(HUMAN_INPUT_PENDING_PUSH_CHANNEL, {
      requestId: "hir_1",
      runId: "run_1",
      workflowId: "wf_1",
    })
    const push = emit.mock.calls.find(([channel]) => channel === HUMAN_INPUT_PENDING_PUSH_CHANNEL)
    expect(JSON.stringify(push?.[1])).not.toContain("foreground-only")
  })

  it("does not fan out companion events outside Tauri", async () => {
    const notify = jest.fn(async () => "notification_1")
    const emit = jest.fn(async (_event: string, _payload: unknown) => undefined)

    await notifyHumanInputRequested(request, { notify, emit, isTauriFn: () => false })

    expect(notify).toHaveBeenCalledTimes(1)
    expect(emit).not.toHaveBeenCalled()
  })

  it("emits a compact terminal update and treats transport failures as best effort", async () => {
    const emit = jest.fn(async (_event: string, _payload: unknown) => undefined)
    await notifyHumanInputResolved(request, "completed", { emit, isTauriFn: () => true })
    expect(emit).toHaveBeenCalledWith(HUMAN_INPUT_RESOLVED_CHANNEL, {
      requestId: "hir_1",
      runId: "run_1",
      workflowId: "wf_1",
      status: "completed",
    })

    emit.mockRejectedValueOnce(new Error("transport unavailable"))
    await expect(
      notifyHumanInputResolved(request, "cancelled", { emit, isTauriFn: () => true })
    ).resolves.toBeUndefined()
  })
})
