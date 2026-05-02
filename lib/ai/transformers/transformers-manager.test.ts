/**
 * TransformersManager tests. We mock `@huggingface/transformers` so the
 * test never loads ONNX weights — we just verify the manager calls the
 * pipeline correctly, caches pipelines per modelId, and slices batch
 * outputs by the dims tail value.
 */

const pipelineFactory = jest.fn()

jest.mock("@huggingface/transformers", () => ({
  __esModule: true,
  pipeline: pipelineFactory,
  env: { allowRemoteModels: false, useBrowserCache: false },
}))

import {
  TransformersManager,
  getTransformersManager,
  __resetTransformersManagerForTest,
} from "./transformers-manager"

function makePipelineMock(impl?: (input: unknown, opts?: unknown) => unknown) {
  return jest.fn(
    async (input: string | string[], opts?: { pooling?: string; normalize?: boolean }) => {
      if (impl) return impl(input, opts)
      if (typeof input === "string") {
        return { data: new Float32Array([1, 0, 0]), dims: [1, 3] }
      }
      const arr = new Float32Array(input.length * 3)
      for (let i = 0; i < input.length; i++) {
        arr[i * 3] = i + 1
      }
      return { data: arr, dims: [input.length, 3] }
    }
  )
}

describe("TransformersManager", () => {
  beforeEach(() => {
    pipelineFactory.mockReset()
    __resetTransformersManagerForTest()
  })

  describe("generateEmbedding", () => {
    it("calls pipeline('feature-extraction', modelId) and returns the embedding array", async () => {
      const pipeMock = makePipelineMock()
      pipelineFactory.mockResolvedValue(pipeMock)

      const mgr = new TransformersManager()
      const out = await mgr.generateEmbedding("hello", "Xenova/all-MiniLM-L6-v2")

      expect(pipelineFactory).toHaveBeenCalledWith("feature-extraction", "Xenova/all-MiniLM-L6-v2")
      expect(pipeMock).toHaveBeenCalledWith("hello", { pooling: "mean", normalize: true })
      expect(out.embedding).toEqual([1, 0, 0])
      expect(out.dimension).toBe(3)
      expect(out.modelId).toBe("Xenova/all-MiniLM-L6-v2")
      expect(typeof out.duration).toBe("number")
    })

    it("threads pooling and normalize options through to the pipeline", async () => {
      const pipeMock = makePipelineMock()
      pipelineFactory.mockResolvedValue(pipeMock)
      const mgr = new TransformersManager()
      await mgr.generateEmbedding("x", "m", { pooling: "cls", normalize: false })
      expect(pipeMock).toHaveBeenCalledWith("x", { pooling: "cls", normalize: false })
    })

    it("rejects when modelId is empty", async () => {
      const mgr = new TransformersManager()
      await expect(mgr.generateEmbedding("x", "")).rejects.toThrow(/modelId is required/)
    })

    it("returns an array (not Float32Array) so vector backends can JSON-serialize", async () => {
      pipelineFactory.mockResolvedValue(makePipelineMock())
      const mgr = new TransformersManager()
      const out = await mgr.generateEmbedding("x", "m")
      expect(Array.isArray(out.embedding)).toBe(true)
    })
  })

  describe("generateEmbeddings (batch)", () => {
    it("splits a flat tensor by the trailing dims value into one row per input", async () => {
      pipelineFactory.mockResolvedValue(makePipelineMock())
      const mgr = new TransformersManager()
      const out = await mgr.generateEmbeddings(["a", "b", "c"], "m")
      expect(out.embeddings).toHaveLength(3)
      expect(out.dimension).toBe(3)
      expect(out.embeddings[0]).toEqual([1, 0, 0])
      expect(out.embeddings[1]).toEqual([2, 0, 0])
      expect(out.embeddings[2]).toEqual([3, 0, 0])
    })

    it("returns an empty result for an empty input array without invoking the pipeline", async () => {
      pipelineFactory.mockResolvedValue(makePipelineMock())
      const mgr = new TransformersManager()
      const out = await mgr.generateEmbeddings([], "m")
      expect(out.embeddings).toEqual([])
      expect(out.dimension).toBe(0)
      expect(pipelineFactory).not.toHaveBeenCalled()
    })

    it("falls back to flat.length / texts.length when dims tail is missing or 0", async () => {
      const pipe = jest.fn(async () => ({
        data: new Float32Array([1, 2, 3, 4]),
        dims: [],
      }))
      pipelineFactory.mockResolvedValue(pipe)
      const mgr = new TransformersManager()
      const out = await mgr.generateEmbeddings(["a", "b"], "m")
      expect(out.dimension).toBe(2)
      expect(out.embeddings[0]).toEqual([1, 2])
      expect(out.embeddings[1]).toEqual([3, 4])
    })

    it("throws when the pipeline returns a malformed tensor", async () => {
      const pipe = jest.fn(async () => ({ data: new Float32Array([1, 2]), dims: [2, 3] }))
      pipelineFactory.mockResolvedValue(pipe)
      const mgr = new TransformersManager()
      await expect(mgr.generateEmbeddings(["a", "b"], "m")).rejects.toThrow(/expected 6/)
    })
  })

  describe("caching", () => {
    it("caches pipelines by modelId and only calls the factory once per model", async () => {
      pipelineFactory.mockResolvedValue(makePipelineMock())
      const mgr = new TransformersManager()
      await mgr.generateEmbedding("x", "m1")
      await mgr.generateEmbedding("y", "m1")
      await mgr.generateEmbedding("z", "m1")
      expect(pipelineFactory).toHaveBeenCalledTimes(1)
    })

    it("creates a separate pipeline per distinct modelId", async () => {
      pipelineFactory.mockResolvedValue(makePipelineMock())
      const mgr = new TransformersManager()
      await mgr.generateEmbedding("x", "m1")
      await mgr.generateEmbedding("y", "m2")
      expect(pipelineFactory).toHaveBeenCalledTimes(2)
      expect(pipelineFactory).toHaveBeenNthCalledWith(1, "feature-extraction", "m1")
      expect(pipelineFactory).toHaveBeenNthCalledWith(2, "feature-extraction", "m2")
    })

    it("dedupes concurrent loads for the same modelId", async () => {
      // Use a deferred promise so we can observe the dedupe before resolving.
      let resolvePipe!: (p: unknown) => void
      const pending = new Promise<unknown>((r) => {
        resolvePipe = r
      })
      pipelineFactory.mockReturnValueOnce(pending)

      const mgr = new TransformersManager()
      const a = mgr.generateEmbedding("x", "m1")
      const b = mgr.generateEmbedding("y", "m1")

      // Yield to the microtask queue so the in-flight load actually starts.
      // jsdom doesn't expose setImmediate; a few Promise.resolve()s flush enough microtasks.
      for (let i = 0; i < 5; i++) await Promise.resolve()

      resolvePipe(makePipelineMock())
      await Promise.all([a, b])
      expect(pipelineFactory).toHaveBeenCalledTimes(1)
    })

    it("reset() drops the cache so the next call reloads", async () => {
      pipelineFactory.mockResolvedValue(makePipelineMock())
      const mgr = new TransformersManager()
      await mgr.generateEmbedding("x", "m")
      mgr.reset()
      await mgr.generateEmbedding("x", "m")
      expect(pipelineFactory).toHaveBeenCalledTimes(2)
    })
  })

  describe("getTransformersManager singleton", () => {
    it("returns the same instance across calls", () => {
      const a = getTransformersManager()
      const b = getTransformersManager()
      expect(a).toBe(b)
    })

    it("__resetTransformersManagerForTest creates a fresh singleton", () => {
      const a = getTransformersManager()
      __resetTransformersManagerForTest()
      const b = getTransformersManager()
      expect(a).not.toBe(b)
    })
  })
})
