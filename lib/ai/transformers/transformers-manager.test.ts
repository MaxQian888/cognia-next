/**
 * Tests for the cognia-next TransformersManager stub.
 *
 * The full Cognia implementation runs Transformers.js inside Web Workers and
 * caches pipelines per modelId. cognia-next has not ported the worker pool
 * yet — see `transformers-manager.ts` header — so the manager is a stub that
 * throws a runtime-required error for every embed call. The original Cognia
 * tests asserted on pipeline calls / dim-slicing / caching: none of that
 * applies here. This file pins the stub's surface instead.
 */

import {
  TransformersManager,
  getTransformersManager,
  __resetTransformersManagerForTest,
} from "./transformers-manager"
import { TRANSFORMERS_RUNTIME_ERROR_MESSAGE } from "@/lib/vector/embedding"

describe("TransformersManager (cognia-next stub)", () => {
  beforeEach(() => {
    __resetTransformersManagerForTest()
  })

  it("rejects single-text generateEmbedding with the runtime-required error", async () => {
    const mgr = new TransformersManager()
    await expect(mgr.generateEmbedding("hello", "all-MiniLM-L6-v2")).rejects.toThrow(
      TRANSFORMERS_RUNTIME_ERROR_MESSAGE
    )
  })

  it("rejects batch generateEmbeddings with the runtime-required error", async () => {
    const mgr = new TransformersManager()
    await expect(mgr.generateEmbeddings(["a", "b"], "all-MiniLM-L6-v2")).rejects.toThrow(
      TRANSFORMERS_RUNTIME_ERROR_MESSAGE
    )
  })

  it("forwards options to generateEmbedding without changing the rejection", async () => {
    const mgr = new TransformersManager()
    await expect(
      mgr.generateEmbedding("hello", "model", { pooling: "mean", normalize: true })
    ).rejects.toThrow(TRANSFORMERS_RUNTIME_ERROR_MESSAGE)
  })

  it("forwards options to batch generateEmbeddings without changing the rejection", async () => {
    const mgr = new TransformersManager()
    await expect(
      mgr.generateEmbeddings(["a"], "model", { pooling: "cls", normalize: false })
    ).rejects.toThrow(TRANSFORMERS_RUNTIME_ERROR_MESSAGE)
  })

  it("reset() is a no-op (the stub holds no cache)", () => {
    const mgr = new TransformersManager()
    expect(() => mgr.reset()).not.toThrow()
  })

  describe("getTransformersManager singleton", () => {
    it("returns the same instance across calls", () => {
      const a = getTransformersManager()
      const b = getTransformersManager()
      expect(a).toBe(b)
    })

    it("__resetTransformersManagerForTest discards the singleton between specs", () => {
      const before = getTransformersManager()
      __resetTransformersManagerForTest()
      const after = getTransformersManager()
      expect(after).not.toBe(before)
    })

    it("singleton instance still throws on embed calls", async () => {
      const mgr = getTransformersManager()
      await expect(mgr.generateEmbedding("x", "m")).rejects.toThrow(
        TRANSFORMERS_RUNTIME_ERROR_MESSAGE
      )
    })
  })
})
