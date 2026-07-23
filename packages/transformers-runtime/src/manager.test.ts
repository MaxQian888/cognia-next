import type { TransformersWorkerRequest, TransformersWorkerResponse } from "./types"
import {
  TransformersManager,
  TransformersManagerError,
  __resetTransformersManagerForTest,
  getTransformersManager,
} from "./manager"

class FakeWorker {
  static instances: FakeWorker[] = []

  readonly requests: TransformersWorkerRequest[] = []
  terminated = false
  private listeners = new Map<string, ((event: MessageEvent | ErrorEvent) => void)[]>()

  constructor() {
    FakeWorker.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent | ErrorEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  postMessage(request: TransformersWorkerRequest) {
    this.requests.push(request)
  }

  respond(response: TransformersWorkerResponse) {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: response } as MessageEvent)
    }
  }

  fail(message: string) {
    for (const listener of this.listeners.get("error") ?? []) {
      listener({ message } as ErrorEvent)
    }
  }

  terminate() {
    this.terminated = true
  }
}

describe("TransformersManager", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    FakeWorker.instances = []
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker })
    __resetTransformersManagerForTest()
  })

  afterEach(() => {
    __resetTransformersManagerForTest()
    jest.useRealTimers()
  })

  it("does not create a worker until inference is explicitly requested", () => {
    const manager = new TransformersManager()

    expect(FakeWorker.instances).toHaveLength(0)
    expect(manager.isWorkerAlive).toBe(false)
  })

  it("generates one normalized embedding through the lazy worker", async () => {
    const manager = new TransformersManager()
    const promise = manager.generateEmbedding("hello", "Xenova/model")
    const worker = FakeWorker.instances[0]
    const request = worker.requests[0]

    expect(request).toMatchObject({
      type: "embed",
      payload: {
        texts: ["hello"],
        modelId: "Xenova/model",
        pooling: "mean",
        normalize: true,
        dtype: "q8",
      },
    })

    worker.respond({
      id: request.id,
      type: "embedding-result",
      embeddings: [[0.25, 0.75]],
      duration: 12,
    })

    await expect(promise).resolves.toMatchObject({
      embedding: [0.25, 0.75],
      modelId: "Xenova/model",
      dimension: 2,
    })
  })

  it("batches inputs without loading more than one worker", async () => {
    const manager = new TransformersManager()
    const promise = manager.generateEmbeddings(["a", "b", "c"], "model", { batchSize: 2 })
    const worker = FakeWorker.instances[0]
    const first = worker.requests[0]

    expect(first).toMatchObject({ payload: { texts: ["a", "b"] } })
    worker.respond({ id: first.id, type: "embedding-result", embeddings: [[1], [2]], duration: 4 })
    await Promise.resolve()

    const second = worker.requests[1]
    expect(second).toMatchObject({ payload: { texts: ["c"] } })
    worker.respond({ id: second.id, type: "embedding-result", embeddings: [[3]], duration: 2 })

    await expect(promise).resolves.toMatchObject({ embeddings: [[1], [2], [3]], dimension: 1 })
    expect(FakeWorker.instances).toHaveLength(1)
  })

  it("forwards download progress and normalizes worker errors", async () => {
    const onProgress = jest.fn()
    const manager = new TransformersManager()
    const promise = manager.generateEmbedding("hello", "model", { onProgress })
    const worker = FakeWorker.instances[0]
    const request = worker.requests[0]
    const progress = { modelId: "model", status: "downloading" as const, progress: 35 }

    worker.respond({ id: request.id, type: "progress", progress })
    expect(onProgress).toHaveBeenCalledWith(progress)

    worker.respond({
      id: request.id,
      type: "error",
      error: "model failed",
      errorCode: "model_load_failed",
    })

    await expect(promise).rejects.toMatchObject({
      name: "TransformersManagerError",
      message: "model failed",
      code: "model_load_failed",
    })
  })

  it("rejects a timed-out request and releases an idle worker", async () => {
    const manager = new TransformersManager()
    const promise = manager.generateEmbedding("hello", "model", { timeoutMs: 50 })
    const worker = FakeWorker.instances[0]

    jest.advanceTimersByTime(50)
    await expect(promise).rejects.toEqual(
      expect.objectContaining<Partial<TransformersManagerError>>({ code: "request_timeout" })
    )

    jest.advanceTimersByTime(5 * 60 * 1000)
    expect(worker.terminated).toBe(true)
    expect(manager.isWorkerAlive).toBe(false)
  })

  it("keeps the singleton lazy and resettable", () => {
    const first = getTransformersManager()
    expect(first).toBe(getTransformersManager())
    expect(FakeWorker.instances).toHaveLength(0)

    __resetTransformersManagerForTest()
    expect(getTransformersManager()).not.toBe(first)
  })

  it("loads and runs arbitrary supported tasks through the same lazy worker", async () => {
    const manager = new TransformersManager()
    const loading = manager.loadModel("text-classification", "Xenova/sentiment")
    const worker = FakeWorker.instances[0]
    const loadRequest = worker.requests[0]

    expect(loadRequest).toMatchObject({
      type: "load",
      payload: { task: "text-classification", modelId: "Xenova/sentiment" },
    })
    worker.respond({
      id: loadRequest.id,
      type: "loaded",
      model: {
        task: "text-classification",
        modelId: "Xenova/sentiment",
        device: "wasm",
        dtype: "q8",
        loadedAt: 1,
        lastUsedAt: 1,
      },
    })
    await expect(loading).resolves.toMatchObject({ modelId: "Xenova/sentiment" })

    const inference = manager.infer("text-classification", "Xenova/sentiment", "Cognia is useful", {
      topK: 2,
    })
    const inferRequest = worker.requests[1]
    expect(inferRequest).toMatchObject({
      type: "infer",
      payload: { input: "Cognia is useful", inferenceOptions: { top_k: 2 } },
    })
    worker.respond({
      id: inferRequest.id,
      type: "inference-result",
      task: "text-classification",
      modelId: "Xenova/sentiment",
      output: [{ label: "POSITIVE", score: 0.99 }],
      duration: 8,
    })

    await expect(inference).resolves.toMatchObject({
      task: "text-classification",
      output: [{ label: "POSITIVE", score: 0.99 }],
    })
  })

  it("reports an empty status without starting a worker", async () => {
    const manager = new TransformersManager()

    await expect(manager.getStatus()).resolves.toEqual({ workerAlive: false, models: [] })
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it("can dispose one cached model without terminating the reusable worker", async () => {
    const manager = new TransformersManager()
    await expect(manager.disposeModel("summarization", "not-loaded")).resolves.toBeUndefined()
    expect(FakeWorker.instances).toHaveLength(0)

    const loading = manager.loadModel("summarization", "Xenova/summary")
    const worker = FakeWorker.instances[0]
    const loadRequest = worker.requests[0]
    worker.respond({
      id: loadRequest.id,
      type: "loaded",
      model: {
        task: "summarization",
        modelId: "Xenova/summary",
        device: "wasm",
        dtype: "q8",
        loadedAt: 1,
        lastUsedAt: 1,
      },
    })
    await loading

    const disposing = manager.disposeModel("summarization", "Xenova/summary")
    const request = worker.requests[1]

    expect(request).toMatchObject({
      type: "dispose",
      payload: { task: "summarization", modelId: "Xenova/summary" },
    })
    worker.respond({ id: request.id, type: "disposed" })

    await expect(disposing).resolves.toBeUndefined()
    expect(worker.terminated).toBe(false)
    expect(manager.isWorkerAlive).toBe(true)
  })

  it("normalizes the complete inference and runtime option set", async () => {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } })
    const manager = new TransformersManager()
    const promise = manager.infer("zero-shot-classification", "model", "input", {
      device: "wasm",
      dtype: "q4",
      cache: { enabled: false, maxCachedModels: 0 },
      temperature: 0.2,
      maxNewTokens: 32,
      maxLength: 64,
      language: "en",
      returnTimestamps: "word",
      candidateLabels: ["a", "b"],
      hypothesisTemplate: "This is {}",
    })
    const worker = FakeWorker.instances[0]
    const request = worker.requests[0]

    expect(request).toMatchObject({
      payload: {
        device: "wasm",
        dtype: "q4",
        cache: { enabled: false, maxCachedModels: 1 },
        inferenceOptions: {
          temperature: 0.2,
          max_new_tokens: 32,
          max_length: 64,
          language: "en",
          return_timestamps: "word",
          candidate_labels: ["a", "b"],
          hypothesis_template: "This is {}",
        },
      },
    })
    worker.respond({
      id: request.id,
      type: "inference-result",
      task: "zero-shot-classification",
      modelId: "model",
      output: {},
      duration: 1,
    })
    await expect(promise).resolves.toMatchObject({ modelId: "model" })
  })

  it("validates requests before starting the worker", async () => {
    const manager = new TransformersManager()

    await expect(manager.loadModel("summarization", " ")).rejects.toMatchObject({
      code: "invalid_request",
    })
    await expect(manager.infer("summarization", "model", null)).rejects.toMatchObject({
      code: "invalid_request",
    })
    await expect(manager.generateEmbeddings([], "model")).resolves.toEqual({
      embeddings: [],
      modelId: "model",
      dimension: 0,
      duration: 0,
    })
    expect(FakeWorker.instances).toHaveLength(0)
  })

  it("reports status from an active worker and disposes all runtime state", async () => {
    const manager = new TransformersManager()
    const inference = manager.infer("summarization", "model", "input")
    const worker = FakeWorker.instances[0]
    const inferRequest = worker.requests[0]
    worker.respond({
      id: inferRequest.id,
      type: "inference-result",
      task: "summarization",
      modelId: "model",
      output: [],
      duration: 1,
    })
    await inference

    const status = manager.getStatus()
    const statusRequest = worker.requests[1]
    worker.respond({ id: statusRequest.id, type: "status", models: [] })
    await expect(status).resolves.toEqual({ workerAlive: true, models: [] })

    const disposing = manager.dispose()
    const disposeRequest = worker.requests[2]
    worker.respond({ id: disposeRequest.id, type: "disposed" })
    await disposing
    expect(worker.terminated).toBe(true)
    await expect(manager.dispose()).resolves.toBeUndefined()
  })

  it("rejects unavailable workers, worker crashes, and invalid embedding counts", async () => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined })
    await expect(
      new TransformersManager().generateEmbedding("hello", "model")
    ).rejects.toMatchObject({ code: "worker_unavailable" })

    Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker })
    const crashedManager = new TransformersManager()
    const crashed = crashedManager.generateEmbedding("hello", "model")
    FakeWorker.instances.at(-1)?.fail("boom")
    await expect(crashed).rejects.toMatchObject({ code: "worker_runtime_error" })

    const mismatchManager = new TransformersManager()
    const mismatch = mismatchManager.generateEmbedding("hello", "model")
    const worker = FakeWorker.instances.at(-1)!
    const request = worker.requests[0]
    worker.respond({ id: request.id, type: "embedding-result", embeddings: [], duration: 1 })
    await expect(mismatch).rejects.toMatchObject({ code: "worker_runtime_error" })
  })

  it("rejects unexpected worker response shapes", async () => {
    const manager = new TransformersManager()
    const loading = manager.loadModel("summarization", "model")
    const worker = FakeWorker.instances[0]
    const loadRequest = worker.requests[0]
    worker.respond({ id: loadRequest.id, type: "status", models: [] })
    await expect(loading).rejects.toMatchObject({ code: "worker_runtime_error" })

    const embedding = manager.generateEmbedding("hello", "model")
    const embedRequest = worker.requests[1]
    worker.respond({
      id: embedRequest.id,
      type: "embedding-result",
      embeddings: [undefined as unknown as number[]],
      duration: 1,
    })
    await expect(embedding).rejects.toMatchObject({ code: "worker_runtime_error" })
  })
})
