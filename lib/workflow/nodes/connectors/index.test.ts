const mockEnqueueAuthorized = jest.fn()
jest.mock("@/lib/connectors/delivery-gateway", () => ({
  enqueueAuthorized: (...args: unknown[]) => mockEnqueueAuthorized(...args),
}))
const mockWorkflowRun = jest.fn()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ workflowRuns: { get: (id: string) => mockWorkflowRun(id) } }),
}))

import "."
import { getExecutor } from "../registry"

describe("connector-nodes registration", () => {
  it.each([
    ["action.connector.delete", 1],
    ["action.connector.draft", 1],
    ["action.connector.forward", 1],
    ["action.connector.reaction", 1],
    ["action.connector.send", 1],
    ["action.connector.waitReply", 1],
  ])("registers %s@%s", (kind, version) => {
    expect(getExecutor(kind as never, version)).toBeDefined()
  })
})

describe("action.connector.send and the outbound policy (ADR-0239)", () => {
  const ctx = {
    params: { adapterId: "bot-a", conversationKey: "lark:bot-a:oc_1", content: "build is green" },
    runId: "run-1",
    stepId: "step-1",
    workflowId: "wf-1",
  }
  const send = () =>
    getExecutor("action.connector.send" as never, 1)!.execute(ctx as never) as Promise<{
      output: Record<string, unknown>
    }>

  beforeEach(() => {
    mockEnqueueAuthorized.mockReset()
    mockWorkflowRun.mockReset()
  })

  it("plans the send in the run's origin: its IM trigger conversation", async () => {
    mockWorkflowRun.mockResolvedValue({ triggeredBy: { conversationKey: "lark:bot-a:oc_1" } })
    mockEnqueueAuthorized.mockResolvedValue({ kind: "queued", job: { id: "job-1" } })

    const { output } = await send()

    expect(mockEnqueueAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "workflow",
        authorization: {
          kind: "unattended",
          ownerRef: "workflow:wf-1",
          origin: {
            rootSessionId: "workflow-run:run-1",
            instructionEpoch: "workflow-run:run-1",
            originThread: expect.objectContaining({ kind: "conversation", channel: "bot-a" }),
          },
        },
      })
    )
    expect(output).toMatchObject({ jobId: "job-1" })
  })

  it("reports a send held as a draft, without waiting for a delivery", async () => {
    mockWorkflowRun.mockResolvedValue(undefined)
    mockEnqueueAuthorized.mockResolvedValue({ kind: "drafted", draft: { id: "cdr_1" } })

    const { output } = await send()

    expect(mockEnqueueAuthorized.mock.calls[0][0].authorization.origin).toEqual({
      rootSessionId: "workflow-run:run-1",
      instructionEpoch: "workflow-run:run-1",
    })
    expect(output).toMatchObject({ draftId: "cdr_1", heldAsDraft: true, delivered: false })
    expect(output).not.toHaveProperty("jobId")
  })
})
