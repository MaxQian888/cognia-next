// Tests for the dynamic compaction seam (pre-compact-hook.mjs).
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { validatePreCompactResult, queryPreCompactDecision } from "./pre-compact-hook.mjs"

describe("validatePreCompactResult", () => {
  it("returns fallback for null/undefined", () => {
    const result = validatePreCompactResult(null)
    assert.equal(result.source, "fallback")
    assert.equal(result.skip, false)
    assert.equal(result.contextToInject, undefined)
  })

  it("returns fallback for non-object", () => {
    assert.equal(validatePreCompactResult("string").source, "fallback")
    assert.equal(validatePreCompactResult(42).source, "fallback")
  })

  it("honors skipCompaction: true", () => {
    const result = validatePreCompactResult({ skipCompaction: true })
    assert.equal(result.skip, true)
    assert.equal(result.source, "plugin")
  })

  it("ignores skipCompaction when not boolean true", () => {
    assert.equal(validatePreCompactResult({ skipCompaction: "yes" }).skip, false)
    assert.equal(validatePreCompactResult({ skipCompaction: 1 }).skip, false)
  })

  it("passes contextToInject string through", () => {
    const result = validatePreCompactResult({ contextToInject: "important context" })
    assert.equal(result.contextToInject, "important context")
    assert.equal(result.source, "plugin")
  })

  it("truncates contextToInject at 4096 chars", () => {
    const long = "x".repeat(8000)
    const result = validatePreCompactResult({ contextToInject: long })
    assert.equal(result.contextToInject.length, 4096)
  })

  it("ignores empty contextToInject", () => {
    assert.equal(validatePreCompactResult({ contextToInject: "" }).contextToInject, undefined)
  })

  it("maps customStrategy 'aggressive' to 'recursive'", () => {
    const result = validatePreCompactResult({ customStrategy: "aggressive" })
    assert.equal(result.strategyOverride, "recursive")
  })

  it("maps customStrategy 'moderate' to 'selective'", () => {
    const result = validatePreCompactResult({ customStrategy: "moderate" })
    assert.equal(result.strategyOverride, "selective")
  })

  it("maps customStrategy 'minimal' to 'sliding-window'", () => {
    const result = validatePreCompactResult({ customStrategy: "minimal" })
    assert.equal(result.strategyOverride, "sliding-window")
  })

  it("ignores unknown customStrategy values", () => {
    assert.equal(
      validatePreCompactResult({ customStrategy: "unknown" }).strategyOverride,
      undefined
    )
  })
})

describe("queryPreCompactDecision", () => {
  it("returns fallback when hostRpc is null", async () => {
    const result = await queryPreCompactDecision(null, {
      sessionId: "s1",
      messageCount: 10,
      tokenCount: 5000,
      compressionRatio: 0.8,
    })
    assert.equal(result.source, "fallback")
  })

  it("returns fallback when hostRpc is closed", async () => {
    const rpc = {
      isClosed: true,
      call: () => {
        throw new Error("should not be called")
      },
    }
    const result = await queryPreCompactDecision(rpc, {
      sessionId: "s1",
      messageCount: 10,
      tokenCount: 5000,
      compressionRatio: 0.8,
    })
    assert.equal(result.source, "fallback")
  })

  it("returns the plugin decision when the renderer bridge responds", async () => {
    // The transport is the plugin-hook round-trip, NOT `host_rpc`: that frame is
    // answered in Rust and never reaches the renderer, which is why this hook
    // fell back on every call before.
    const result = await queryPreCompactDecision(
      null,
      { sessionId: "s1", messageCount: 10, tokenCount: 5000, compressionRatio: 0.8 },
      { pluginHookBridge: async () => ({ skipCompaction: true }) }
    )
    assert.equal(result.source, "plugin")
    assert.equal(result.skip, true)
  })

  it("falls back when no renderer bridge is supplied", async () => {
    // Headless, or a rail with no renderer: compaction proceeds on its built-in
    // strategy exactly as before.
    const result = await queryPreCompactDecision(null, {
      sessionId: "s1",
      messageCount: 10,
      tokenCount: 5000,
      compressionRatio: 0.8,
    })
    assert.equal(result.source, "fallback")
  })

  it("returns fallback when the bridge throws", async () => {
    const rpc = {
      isClosed: false,
      call: async () => {
        throw new Error("timeout")
      },
    }
    const result = await queryPreCompactDecision(rpc, {
      sessionId: "s1",
      messageCount: 10,
      tokenCount: 5000,
      compressionRatio: 0.8,
    })
    assert.equal(result.source, "fallback")
  })

  it("passes the context and the hook name through the bridge", async () => {
    let received
    const ctx = { sessionId: "s1", messageCount: 20, tokenCount: 10000, compressionRatio: 0.75 }
    await queryPreCompactDecision(null, ctx, {
      pluginHookBridge: async (req) => {
        received = req
        return {}
      },
    })
    assert.deepEqual(received.payload, ctx)
    assert.equal(received.hookId, "onPreCompact")
  })
})
