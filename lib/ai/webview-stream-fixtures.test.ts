import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider"

import {
  abortableStreamModel,
  completedStreamModel,
  drainRejectionReports,
  simulateWebviewRuntime,
  truncatedStreamModel,
} from "./webview-stream-fixtures"

type StreamModel = ReturnType<typeof completedStreamModel>

async function openStream(model: StreamModel, abortSignal?: AbortSignal) {
  const { stream } = await model.doStream({
    prompt: [],
    ...(abortSignal ? { abortSignal } : {}),
  } as LanguageModelV4CallOptions)
  return stream.getReader()
}

async function readUntilDone(
  reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart>
): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return parts
    parts.push(value)
  }
}

describe("simulateWebviewRuntime", () => {
  it("clears the Node runtime probe and restores it", () => {
    const release = process.release
    const restore = simulateWebviewRuntime()
    expect(process.release).toBeUndefined()
    restore()
    expect(process.release).toBe(release)
    expect(process.release.name).toBe("node")
  })
})

describe("drainRejectionReports", () => {
  it("resolves only after pending immediates have run", async () => {
    const order: string[] = []
    setImmediate(() => order.push("immediate"))
    await drainRejectionReports()
    order.push("drained")
    expect(order).toEqual(["immediate", "drained"])
  })
})

describe("completedStreamModel", () => {
  it("streams the text and a finish part, then closes", async () => {
    const parts = await readUntilDone(await openStream(completedStreamModel("done")))
    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ])
    expect(parts[2]).toMatchObject({ delta: "done" })
  })
})

describe("truncatedStreamModel", () => {
  it("opens the response, then closes with no output and no finish", async () => {
    const parts = await readUntilDone(await openStream(truncatedStreamModel()))
    expect(parts).toEqual([{ type: "stream-start", warnings: [] }])
  })
})

describe("abortableStreamModel", () => {
  it("streams the text and stays open until aborted", async () => {
    const abort = new AbortController()
    const reader = await openStream(abortableStreamModel("half"), abort.signal)
    expect((await reader.read()).value).toMatchObject({ type: "stream-start" })
    expect((await reader.read()).value).toMatchObject({ type: "text-start" })
    expect((await reader.read()).value).toMatchObject({ type: "text-delta", delta: "half" })

    const pending = reader.read()
    abort.abort()
    await expect(pending).rejects.toBe(abort.signal.reason)
  })
})
