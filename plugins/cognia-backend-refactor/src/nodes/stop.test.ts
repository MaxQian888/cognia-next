import {
  createPipelineStopNode,
  executePipelineStop,
  PIPELINE_STOP_KIND,
  PipelineStoppedError,
} from "./stop"

describe("pipeline.stop node", () => {
  it("is a non-retryable plugin node that needs a reason and no desktop", () => {
    const node = createPipelineStopNode()
    expect(node.kind).toBe(PIPELINE_STOP_KIND)
    expect(node.category).toBe("plugin")
    expect(node.retryable).toBe(false)
    expect(node.desktopOnly).toBeUndefined()
    expect(node.paramsSchema).toMatchObject({ required: ["reason"] })
  })

  it("fails the step with the configured reason", async () => {
    const log = jest.fn()
    await expect(
      executePipelineStop({ params: { reason: "  Reviewer requested changes.  " }, log })
    ).rejects.toThrow(new PipelineStoppedError("Reviewer requested changes."))
    expect(log).toHaveBeenCalledWith("error", "Reviewer requested changes.")
  })

  it("still fails — with a generic reason — when none is configured", async () => {
    await expect(executePipelineStop({ params: {}, log: jest.fn() })).rejects.toThrow(
      /must not continue/
    )
  })

  it("wires the executor into the node definition", async () => {
    const node = createPipelineStopNode()
    await expect(
      node.execute({ params: { reason: "stop" }, log: jest.fn() } as never)
    ).rejects.toBeInstanceOf(PipelineStoppedError)
  })
})
