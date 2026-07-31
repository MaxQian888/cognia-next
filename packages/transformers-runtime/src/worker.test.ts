import type { TransformersWorkerRequest, TransformersWorkerResponse } from "./types"

const mockDispose = jest.fn()
const mockExtractor = jest.fn()
const mockPipeline = jest.fn(async (..._args: unknown[]) =>
  Object.assign(mockExtractor, { dispose: mockDispose })
)

jest.mock("@huggingface/transformers", () => ({
  pipeline: (...args: unknown[]) => mockPipeline(...args),
}))

describe("Transformers.js embedding worker", () => {
  let listener: ((event: MessageEvent<TransformersWorkerRequest>) => Promise<void>) | undefined
  let responses: TransformersWorkerResponse[]

  beforeEach(async () => {
    jest.resetModules()
    mockPipeline.mockClear()
    mockExtractor.mockReset()
    mockDispose.mockReset()
    responses = []
    listener = undefined

    Object.defineProperty(globalThis, "self", {
      configurable: true,
      value: {
        addEventListener: (_type: string, handler: typeof listener) => {
          listener = handler
        },
        postMessage: (response: TransformersWorkerResponse) => responses.push(response),
      },
    })

    await import("./worker")
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "self")
  })

  it("does not import or initialize a pipeline at worker startup", () => {
    expect(listener).toBeDefined()
    expect(mockPipeline).not.toHaveBeenCalled()
  })

  it("loads a quantized feature-extraction pipeline on the first request", async () => {
    mockExtractor.mockResolvedValue({ tolist: () => [[0.1, 0.2]] })

    await listener?.({
      data: {
        id: "1",
        type: "embed",
        payload: {
          texts: ["hello"],
          modelId: "Xenova/model",
          pooling: "mean",
          normalize: true,
          device: "wasm",
          dtype: "q8",
        },
      },
    } as unknown as MessageEvent<TransformersWorkerRequest>)

    expect(mockPipeline).toHaveBeenCalledWith(
      "feature-extraction",
      "Xenova/model",
      expect.objectContaining({ device: "wasm", dtype: "q8" })
    )
    expect(mockExtractor).toHaveBeenCalledWith(["hello"], {
      pooling: "mean",
      normalize: true,
    })
    expect(responses.at(-1)).toMatchObject({
      id: "1",
      type: "embedding-result",
      embeddings: [[0.1, 0.2]],
    })
  })

  it("reuses a loaded pipeline and disposes it on request", async () => {
    mockExtractor.mockResolvedValue({ tolist: () => [[1]] })
    const payload = {
      texts: ["a"],
      modelId: "model",
      pooling: "mean" as const,
      normalize: true,
      device: "wasm" as const,
      dtype: "q8" as const,
    }

    await listener?.({ data: { id: "1", type: "embed", payload } } as MessageEvent)
    await listener?.({ data: { id: "2", type: "embed", payload } } as MessageEvent)
    await listener?.({ data: { id: "3", type: "dispose", payload: {} } } as MessageEvent)

    expect(mockPipeline).toHaveBeenCalledTimes(1)
    expect(mockDispose).toHaveBeenCalledTimes(1)
    expect(responses.at(-1)).toEqual({ id: "3", type: "disposed" })
  })

  it("returns a structured error for malformed pipeline output", async () => {
    mockExtractor.mockResolvedValue({ tolist: () => ["not-a-number"] })

    await listener?.({
      data: {
        id: "bad",
        type: "embed",
        payload: {
          texts: ["a"],
          modelId: "model",
          pooling: "mean",
          normalize: true,
          device: "wasm",
          dtype: "q8",
        },
      },
    } as unknown as MessageEvent<TransformersWorkerRequest>)

    expect(responses.at(-1)).toMatchObject({
      id: "bad",
      type: "error",
      errorCode: "worker_runtime_error",
    })
  })

  it("preloads and executes a generic task with normalized options", async () => {
    mockExtractor.mockResolvedValue([{ label: "POSITIVE", score: 0.98 }])
    const runtime = {
      task: "text-classification" as const,
      modelId: "Xenova/sentiment",
      device: "wasm" as const,
      dtype: "q8" as const,
      cache: { enabled: true, maxCachedModels: 2 },
    }

    await listener?.({
      data: { id: "load", type: "load", payload: runtime },
    } as unknown as MessageEvent<TransformersWorkerRequest>)
    await listener?.({
      data: {
        id: "infer",
        type: "infer",
        payload: { ...runtime, input: "great", inferenceOptions: { top_k: 2 } },
      },
    } as unknown as MessageEvent<TransformersWorkerRequest>)

    expect(mockPipeline).toHaveBeenCalledWith(
      "text-classification",
      "Xenova/sentiment",
      expect.objectContaining({ device: "wasm", dtype: "q8" })
    )
    expect(mockExtractor).toHaveBeenCalledWith("great", { top_k: 2 })
    expect(responses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "load", type: "loaded" }),
        expect.objectContaining({
          id: "infer",
          type: "inference-result",
          output: [{ label: "POSITIVE", score: 0.98 }],
        }),
      ])
    )
  })

  it("reports loaded models and supports targeted disposal", async () => {
    mockExtractor.mockResolvedValue([])
    const payload = {
      task: "summarization" as const,
      modelId: "Xenova/summary",
      device: "wasm" as const,
      dtype: "q8" as const,
      cache: { enabled: true, maxCachedModels: 2 },
    }

    await listener?.({ data: { id: "load", type: "load", payload } } as MessageEvent)
    await listener?.({ data: { id: "status", type: "status", payload: {} } } as MessageEvent)
    expect(responses.at(-1)).toMatchObject({
      type: "status",
      models: [expect.objectContaining({ task: "summarization", modelId: "Xenova/summary" })],
    })

    await listener?.({
      data: {
        id: "dispose",
        type: "dispose",
        payload: { task: "summarization", modelId: "Xenova/summary" },
      },
    } as MessageEvent)
    expect(mockDispose).toHaveBeenCalledTimes(1)
  })

  it("evicts the least recently used model when the cache limit is reached", async () => {
    mockExtractor.mockResolvedValue([])
    const base = {
      task: "text-generation" as const,
      device: "wasm" as const,
      dtype: "q8" as const,
      cache: { enabled: true, maxCachedModels: 1 },
    }

    await listener?.({
      data: { id: "one", type: "load", payload: { ...base, modelId: "model-one" } },
    } as MessageEvent)
    await listener?.({
      data: { id: "two", type: "load", payload: { ...base, modelId: "model-two" } },
    } as MessageEvent)

    expect(mockDispose).toHaveBeenCalledTimes(1)
    expect(mockPipeline).toHaveBeenCalledTimes(2)
  })

  it("normalizes runtime download progress states", async () => {
    mockExtractor.mockResolvedValue([])
    const payload = {
      task: "summarization" as const,
      modelId: "model",
      device: "wasm" as const,
      dtype: "q8" as const,
      cache: { enabled: true, maxCachedModels: 2 },
    }
    await listener?.({ data: { id: "load", type: "load", payload } } as MessageEvent)
    const progress = mockPipeline.mock.calls[0]?.[2] as {
      progress_callback: (value: Record<string, unknown>) => void
    }
    progress.progress_callback({ status: "loading", progress: 25 })
    progress.progress_callback({ status: "initiate" })
    progress.progress_callback({ status: "done" })
    expect(responses.filter((response) => response.type === "progress")).toEqual([
      expect.objectContaining({ progress: expect.objectContaining({ status: "loading" }) }),
      expect.objectContaining({ progress: expect.objectContaining({ status: "initiating" }) }),
      expect.objectContaining({
        progress: expect.objectContaining({ status: "ready", progress: 100 }),
      }),
    ])
  })

  it("supports zero-shot arguments, transferable tensors, and no-cache execution", async () => {
    mockExtractor.mockResolvedValue({
      nested: [{ vector: { tolist: () => [1, 2] } }],
      label: "ok",
    })
    const payload = {
      task: "zero-shot-classification" as const,
      modelId: "model",
      device: "wasm" as const,
      dtype: "q8" as const,
      cache: { enabled: false, maxCachedModels: 2 },
      input: "text",
      inferenceOptions: { candidate_labels: ["a"], hypothesis_template: "This is {}" },
    }

    await listener?.({ data: { id: "infer", type: "infer", payload } } as MessageEvent)

    expect(mockExtractor).toHaveBeenCalledWith("text", ["a"], {
      hypothesis_template: "This is {}",
    })
    expect(responses.at(-1)).toMatchObject({
      type: "inference-result",
      output: { nested: [{ vector: [1, 2] }], label: "ok" },
    })
    expect(mockDispose).toHaveBeenCalledTimes(1)
  })

  it("rejects malformed requests, missing models, empty text, and non-tensor embeddings", async () => {
    await listener?.({ data: { id: "", type: "status", payload: {} } } as MessageEvent)
    expect(responses.at(-1)).toMatchObject({ type: "error", errorCode: "invalid_request" })

    await listener?.({
      data: {
        id: "missing",
        type: "load",
        payload: {
          task: "summarization",
          modelId: "",
          device: "wasm",
          dtype: "q8",
          cache: { enabled: true, maxCachedModels: 2 },
        },
      },
    } as MessageEvent)
    expect(responses.at(-1)).toMatchObject({ type: "error", errorCode: "invalid_request" })

    mockExtractor.mockResolvedValueOnce({ tolist: () => [] }).mockResolvedValueOnce([])
    const base = {
      modelId: "model",
      pooling: "mean" as const,
      normalize: true,
      device: "wasm" as const,
      dtype: "q8" as const,
      cache: { enabled: true, maxCachedModels: 2 },
    }
    await listener?.({
      data: { id: "empty", type: "embed", payload: { ...base, texts: [] } },
    } as MessageEvent)
    expect(responses.at(-1)).toMatchObject({ type: "error", errorCode: "invalid_request" })
    await listener?.({
      data: { id: "tensor", type: "embed", payload: { ...base, texts: ["a"] } },
    } as MessageEvent)
    expect(responses.at(-1)).toMatchObject({ type: "error", errorCode: "worker_runtime_error" })
  })

  it("normalizes model loading failures and removes failed cache entries", async () => {
    mockPipeline
      .mockRejectedValueOnce(new Error("load failed"))
      .mockRejectedValueOnce("string failure")
    const payload = {
      task: "summarization" as const,
      modelId: "model",
      device: "wasm" as const,
      dtype: "q8" as const,
      cache: { enabled: true, maxCachedModels: 2 },
    }

    await listener?.({ data: { id: "one", type: "load", payload } } as MessageEvent)
    await listener?.({ data: { id: "two", type: "load", payload } } as MessageEvent)

    expect(mockPipeline).toHaveBeenCalledTimes(2)
    expect(responses.at(-2)).toMatchObject({ error: "load failed", errorCode: "model_load_failed" })
    expect(responses.at(-1)).toMatchObject({
      error: "string failure",
      errorCode: "model_load_failed",
    })
  })

  it("normalizes unexpected pipeline failures", async () => {
    mockExtractor.mockRejectedValueOnce(new Error("inference failed")).mockRejectedValueOnce("bad")
    const base = {
      task: "summarization" as const,
      modelId: "model",
      device: "wasm" as const,
      dtype: "q8" as const,
      cache: { enabled: true, maxCachedModels: 2 },
      input: "text",
      inferenceOptions: {},
    }

    await listener?.({ data: { id: "one", type: "infer", payload: base } } as MessageEvent)
    await listener?.({ data: { id: "two", type: "infer", payload: base } } as MessageEvent)

    expect(responses.at(-2)).toMatchObject({
      error: "inference failed",
      errorCode: "worker_runtime_error",
    })
    expect(responses.at(-1)).toMatchObject({ error: "bad", errorCode: "worker_runtime_error" })
  })

  it("blocks remote media URLs at the runtime boundary", async () => {
    await listener?.({
      data: {
        id: "remote",
        type: "infer",
        payload: {
          task: "image-classification",
          modelId: "Xenova/model",
          device: "wasm",
          dtype: "q8",
          cache: { enabled: true, maxCachedModels: 2 },
          input: { images: ["https://example.com/private.png"] },
          inferenceOptions: {},
        },
      },
    } as MessageEvent)

    expect(mockPipeline).not.toHaveBeenCalled()
    expect(responses.at(-1)).toMatchObject({ type: "error", errorCode: "invalid_request" })
  })
})
