const loadModel = jest.fn()
const infer = jest.fn()
const getStatus = jest.fn()
const disposeModel = jest.fn()
const dispose = jest.fn()

jest.mock("@cognia/transformers-runtime", () => ({
  getTransformersManager: () => ({ loadModel, infer, getStatus, disposeModel, dispose }),
}))

import "./browser-model"
import { getExecutor } from "./registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

function context(params: Record<string, unknown>): StepExecutionContext {
  return {
    runId: "run",
    workflowId: "workflow",
    stepId: "step",
    params,
    signal: new AbortController().signal,
  } as StepExecutionContext
}

async function execute(params: Record<string, unknown>) {
  const registration = getExecutor("ai.browserModel", 1)
  if (!registration) throw new Error("ai.browserModel is not registered")
  return registration.execute(context(params))
}

beforeEach(() => {
  jest.clearAllMocks()
  loadModel.mockResolvedValue({ modelId: "model" })
  infer.mockResolvedValue({ task: "summarization", modelId: "model", output: "summary" })
  getStatus.mockResolvedValue({ workerAlive: true, models: [] })
  disposeModel.mockResolvedValue(undefined)
  dispose.mockResolvedValue(undefined)
})

describe("ai.browserModel", () => {
  it("runs generic local inference with parsed input and bounded runtime options", async () => {
    const result = await execute({
      operation: "infer",
      task: "question-answering",
      modelId: "model",
      inputJson: '{"question":"why?","context":"because"}',
      device: "wasm",
      dtype: "q8",
      cacheEnabled: false,
      maxCachedModels: 3,
      topK: 2,
      maxNewTokens: 64,
      candidateLabels: ["yes", "no"],
    })

    expect(infer).toHaveBeenCalledWith(
      "question-answering",
      "model",
      { question: "why?", context: "because" },
      expect.objectContaining({
        device: "wasm",
        dtype: "q8",
        cache: { enabled: false, maxCachedModels: 3 },
        topK: 2,
        maxNewTokens: 64,
        candidateLabels: ["yes", "no"],
      })
    )
    expect(result.output).toMatchObject({ operation: "infer", output: "summary" })
  })

  it("supports preload, status, targeted disposal, and full disposal", async () => {
    await execute({ operation: "preload", task: "summarization", modelId: "model" })
    expect(loadModel).toHaveBeenCalledWith("summarization", "model", expect.any(Object))

    await expect(execute({ operation: "status" })).resolves.toMatchObject({
      output: { operation: "status", workerAlive: true },
    })
    await execute({ operation: "disposeModel", task: "summarization", modelId: "model" })
    expect(disposeModel).toHaveBeenCalledWith("summarization", "model")
    await execute({ operation: "disposeAll" })
    expect(dispose).toHaveBeenCalled()
  })

  it("rejects invalid JSON and missing inference input", async () => {
    await expect(
      execute({
        operation: "infer",
        task: "summarization",
        modelId: "model",
        inputJson: "{bad",
      })
    ).rejects.toThrow(/inputJson/)
    await expect(
      execute({ operation: "infer", task: "summarization", modelId: "model" })
    ).rejects.toThrow(/input/)
  })

  it("blocks remote media fetches and unsafe outbound model IDs", async () => {
    await expect(
      execute({
        operation: "infer",
        task: "image-classification",
        modelId: "Xenova/vit-base-patch16-224",
        input: "https://example.com/private-person.jpg",
      })
    ).rejects.toThrow(/remote media URLs are disabled/)
    await expect(
      execute({
        operation: "preload",
        task: "summarization",
        modelId: "Xenova/model?token=secret",
      })
    ).rejects.toThrow(/safe Hugging Face model ID/)
  })

  it("defaults to inference and accepts local plain-text or data URL input", async () => {
    await execute({
      task: "summarization",
      modelId: " Xenova/summary ",
      input: "local text",
      temperature: 0.5,
      maxLength: 512,
      language: "en",
      returnTimestamps: true,
      hypothesisTemplate: "This is {}",
    })
    expect(infer).toHaveBeenCalledWith(
      "summarization",
      "Xenova/summary",
      "local text",
      expect.objectContaining({
        temperature: 0.5,
        maxLength: 512,
        language: "en",
        returnTimestamps: true,
        hypothesisTemplate: "This is {}",
      })
    )

    await execute({
      task: "image-classification",
      modelId: "Xenova/vit",
      input: "data:image/png;base64,AAAA",
    })
    expect(infer).toHaveBeenLastCalledWith(
      "image-classification",
      "Xenova/vit",
      "data:image/png;base64,AAAA",
      expect.any(Object)
    )
  })

  it("rejects missing model metadata and nested remote media input", async () => {
    await expect(execute({ operation: "preload" })).rejects.toThrow(/task.*modelId/)
    await expect(
      execute({
        operation: "infer",
        task: "image-to-text",
        modelId: "Xenova/image",
        inputJson: '{"images":[{"url":"https://example.com/private.png"}]}',
      })
    ).rejects.toThrow(/remote media URLs are disabled/)
  })
})
