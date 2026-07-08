import { dispatchCompletionFanout, gateModelText } from "./completion-linkage-core"

const dispatchTrigger = jest.fn(async () => {})
const findMatchingWorkflows = jest.fn(
  (): Array<{ workflowId: string }> => [{ workflowId: "wf-1" }, { workflowId: "wf-2" }]
)
jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  dispatchTrigger: (...args: unknown[]) => dispatchTrigger(...(args as [])),
}))
jest.mock("@/lib/workflow/runtime/trigger-subscriptions", () => ({
  findMatchingWorkflows: (...args: unknown[]) => findMatchingWorkflows(...(args as [])),
}))

const hasNoLeakingPii = jest.fn((text: string) => !text.includes("SECRET"))
jest.mock("@/lib/twin/ingest/redact", () => ({
  hasNoLeakingPii: (text: string) => hasNoLeakingPii(text),
}))

beforeEach(() => {
  jest.clearAllMocks()
  findMatchingWorkflows.mockReturnValue([{ workflowId: "wf-1" }, { workflowId: "wf-2" }])
})

describe("dispatchCompletionFanout", () => {
  const input = {
    kind: "trigger.team" as const,
    match: { teamId: "t1", status: "completed" },
    payload: { teamId: "t1", event: "team.completed" },
    binding: { teamId: "t1" },
  }

  it("dispatches every match with the shared payload/binding", async () => {
    await dispatchCompletionFanout(input)
    expect(findMatchingWorkflows).toHaveBeenCalledWith("trigger.team", input.match)
    expect(dispatchTrigger).toHaveBeenCalledTimes(2)
    expect(dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-1",
        kind: "trigger.team",
        payload: input.payload,
        binding: input.binding,
        originAt: expect.any(Number),
      })
    )
  })

  it("early-returns when nothing matches", async () => {
    findMatchingWorkflows.mockReturnValue([])
    await dispatchCompletionFanout(input)
    expect(dispatchTrigger).not.toHaveBeenCalled()
  })

  it("isolates per-match failures and never throws", async () => {
    dispatchTrigger.mockRejectedValueOnce(new Error("boom"))
    await expect(dispatchCompletionFanout(input)).resolves.toBeUndefined()
    expect(dispatchTrigger).toHaveBeenCalledTimes(2)
  })

  it("swallows a broken workflow runtime entirely", async () => {
    findMatchingWorkflows.mockImplementation(() => {
      throw new Error("runtime unavailable")
    })
    await expect(dispatchCompletionFanout(input)).resolves.toBeUndefined()
  })
})

describe("gateModelText", () => {
  it("passes clean text through, capped when requested", async () => {
    expect(await gateModelText("all good")).toBe("all good")
    expect(await gateModelText("abcdef", 3)).toBe("abc")
  })

  it("omits unsafe text and empty input", async () => {
    expect(await gateModelText("has SECRET inside")).toBeUndefined()
    expect(await gateModelText(undefined)).toBeUndefined()
    expect(await gateModelText("")).toBeUndefined()
  })

  it("fails closed when the redaction gate can't run", async () => {
    hasNoLeakingPii.mockImplementationOnce(() => {
      throw new Error("gate broken")
    })
    expect(await gateModelText("anything")).toBeUndefined()
  })
})
