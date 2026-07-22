import type { PluginToolContext } from "@/types/plugin"
import type { WorkPluginContext } from "./runtime"

const mockRuntime = {
  createDeliverable: jest.fn(),
  updateDeliverable: jest.fn(),
  reviewDeliverable: jest.fn(),
  runParallel: jest.fn(),
}

jest.mock("./runtime", () => ({
  createWorkRuntime: () => mockRuntime,
}))

import { createWorkTools, WORK_TOOL_NAMES } from "./tools"

const context = (overrides: Partial<PluginToolContext> = {}): PluginToolContext => ({
  config: {},
  ...overrides,
})

describe("createWorkTools", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRuntime.createDeliverable.mockResolvedValue({ ok: true, artifactId: "a1" })
    mockRuntime.updateDeliverable.mockReturnValue({ ok: true, artifactId: "a1" })
    mockRuntime.reviewDeliverable.mockResolvedValue({ ok: true, reviewArtifactId: "r1" })
    mockRuntime.runParallel.mockResolvedValue({ ok: true, results: [] })
  })

  it("keeps tool names and schemas aligned with the Work mode contract", () => {
    const tools = createWorkTools({ pluginId: "cognia-work-mode" } as unknown as WorkPluginContext)
    expect(tools.map((tool) => tool.name)).toEqual(WORK_TOOL_NAMES)
    expect(tools.map((tool) => tool.definition.name)).toEqual(WORK_TOOL_NAMES)
    expect(tools.every((tool) => tool.definition.parametersSchema.type === "object")).toBe(true)
  })

  it("forwards create/update inputs and optional message ownership", async () => {
    const tools = createWorkTools({ pluginId: "cognia-work-mode" } as unknown as WorkPluginContext)
    await tools[0].execute(
      { kind: "document", title: "Brief", content: "Done" },
      context({ sessionId: "s1", messageId: "m1" })
    )
    await tools[0].execute({ kind: "report", title: "Report", content: "Done" }, context())
    await tools[1].execute({ artifactId: "a1", title: "Revised" }, context())

    expect(mockRuntime.createDeliverable).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: "s1", messageId: "m1" })
    )
    expect(mockRuntime.createDeliverable).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ sessionId: expect.anything(), messageId: expect.anything() })
    )
    expect(mockRuntime.updateDeliverable).toHaveBeenCalledWith({
      artifactId: "a1",
      title: "Revised",
    })
  })

  it("combines lifecycle and turn cancellation for review and parallel dispatch", async () => {
    const lifecycle = new AbortController()
    const turn = new AbortController()
    let finishReview!: () => void
    mockRuntime.reviewDeliverable.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReview = () => resolve({ ok: true, reviewArtifactId: "r1" })
        })
    )
    const tools = createWorkTools(
      { pluginId: "cognia-work-mode" } as unknown as WorkPluginContext,
      lifecycle.signal
    )
    const reviewRun = tools[2].execute(
      { artifactId: "a1" },
      context({ sessionId: "s1", messageId: "m1", signal: turn.signal })
    )
    const reviewSignal = mockRuntime.reviewDeliverable.mock.calls[0][1].signal as AbortSignal
    expect(reviewSignal.aborted).toBe(false)
    turn.abort()
    expect(reviewSignal.aborted).toBe(true)
    finishReview()
    await reviewRun

    const progress = jest.fn()
    await tools[3].execute(
      { tasks: [{ role: "researcher", prompt: "Research" }] },
      context({ reportProgress: progress })
    )
    expect(mockRuntime.runParallel).toHaveBeenCalledWith(
      expect.objectContaining({ tasks: expect.any(Array) }),
      expect.objectContaining({ reportProgress: progress, signal: lifecycle.signal })
    )
  })

  it("runs review and parallel tools without cancellation signals", async () => {
    const tools = createWorkTools({ pluginId: "cognia-work-mode" } as unknown as WorkPluginContext)
    await tools[2].execute({ artifactId: "a1" }, context())
    await tools[3].execute({ tasks: [{ role: "analyst", prompt: "Analyze" }] }, context())

    expect(mockRuntime.reviewDeliverable).toHaveBeenCalledWith(
      { artifactId: "a1" },
      { signal: undefined }
    )
    expect(mockRuntime.runParallel).toHaveBeenCalledWith(expect.any(Object), {
      reportProgress: undefined,
      signal: undefined,
    })
  })
})
