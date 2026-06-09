import { describe, it, expect, jest } from "@jest/globals"
import { createPluginAgentRun } from "./stream"
import type { PluginAgentRunResult } from "@/types/plugin/plugin-agent-sdk"

const RESULT: PluginAgentRunResult = {
  text: "done",
  channel: "text",
  toolsAvailable: false,
  agentId: "a1",
}

describe("createPluginAgentRun", () => {
  it("replays events buffered before iteration, in order, then ends", async () => {
    const { run, push, close } = createPluginAgentRun("a1", () => {})
    push({ type: "text-delta", delta: "he" })
    push({ type: "text-delta", delta: "llo" })
    close(RESULT)

    const seen: string[] = []
    for await (const ev of run) {
      if (ev.type === "text-delta") seen.push(ev.delta)
      if (ev.type === "result") seen.push("[result]")
    }
    expect(seen).toEqual(["he", "llo", "[result]"])
  })

  it("delivers events pushed AFTER the consumer is waiting", async () => {
    const { run, push, close } = createPluginAgentRun("a1", () => {})
    const iterator = run[Symbol.asyncIterator]()
    const firstP = iterator.next()
    push({ type: "tool-call", toolName: "t", input: { a: 1 } })
    const first = await firstP
    expect(first.done).toBe(false)
    expect(first.value).toEqual({ type: "tool-call", toolName: "t", input: { a: 1 } })
    close(RESULT)
  })

  it("resolves the result promise with the final result", async () => {
    const { run, close } = createPluginAgentRun("a1", () => {})
    close(RESULT)
    await expect(run.result).resolves.toEqual(RESULT)
  })

  it("rejects iteration and the result promise on fail()", async () => {
    const { run, fail } = createPluginAgentRun("a1", () => {})
    const err = new Error("boom")
    fail(err)
    await expect(run.result).rejects.toThrow("boom")
    await expect(
      (async () => {
        for await (const _ev of run) void _ev
      })()
    ).rejects.toThrow("boom")
  })

  it("invokes onCancel exactly once", () => {
    const onCancel = jest.fn()
    const { run } = createPluginAgentRun("a1", onCancel)
    run.cancel()
    run.cancel()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("ignores push/close after the stream has failed", async () => {
    const { run, push, fail } = createPluginAgentRun("a1", () => {})
    fail(new Error("x"))
    push({ type: "text-delta", delta: "ignored" })
    await expect(run.result).rejects.toThrow("x")
  })

  it("rejects a waiting consumer when fail() arrives while it is pending", async () => {
    const { run, fail } = createPluginAgentRun("a1", () => {})
    const iterator = run[Symbol.asyncIterator]()
    const pending = iterator.next()
    fail(new Error("late"))
    await expect(pending).rejects.toThrow("late")
  })

  it("ends a waiting consumer cleanly once the result is consumed after close", async () => {
    const { run, close } = createPluginAgentRun("a1", () => {})
    const iterator = run[Symbol.asyncIterator]()
    const firstP = iterator.next()
    close(RESULT)
    const first = await firstP
    expect(first).toEqual({ value: { type: "result", result: RESULT }, done: false })
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true })
  })

  it("return() terminates iteration early (break out of for-await)", async () => {
    const { run, push } = createPluginAgentRun("a1", () => {})
    push({ type: "text-delta", delta: "a" })
    push({ type: "text-delta", delta: "b" })
    const seen: string[] = []
    for await (const ev of run) {
      if (ev.type === "text-delta") {
        seen.push(ev.delta)
        break
      }
    }
    expect(seen).toEqual(["a"])
  })

  it("next() rejects immediately when already failed (no pending)", async () => {
    const { run, fail } = createPluginAgentRun("a1", () => {})
    fail(new Error("boom"))
    const iterator = run[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow("boom")
  })

  it("resolves a pending consumer as done when return() ends the stream", async () => {
    const { run } = createPluginAgentRun("a1", () => {})
    const iterator = run[Symbol.asyncIterator]()
    const pending = iterator.next() // pending: queue empty, not ended
    void iterator.return?.() // flips ended → settleNext resolves the waiter as done
    await expect(pending).resolves.toEqual({ value: undefined, done: true })
  })
})
