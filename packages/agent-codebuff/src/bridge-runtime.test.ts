/** @jest-environment node */
import {
  CodebuffBridgeRuntime,
  codebuffBridgeLine,
  readCodebuffBoundedText,
  type CodebuffBridgeHost,
} from "./bridge-runtime"
import type { BridgeFrame } from "./bridge-protocol"
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
it("runs the published SDK contract without blocking approvals or abort dispatch", async () => {
  const frames: BridgeFrame[] = []
  let hooks!: Parameters<CodebuffBridgeHost["createClient"]>[0], signal!: AbortSignal
  const runtime = new CodebuffBridgeRuntime({
    send: async (f) => {
      frames.push(f)
    },
    createClient: async (h) => {
      hooks = h
      return {
        run: async (o) => {
          signal = o.signal
          const approved = await h.requestPermission("write_file", { path: "a" })
          h.onChunk("text")
          return { sessionState: { approved }, output: { type: "lastMessage", value: [] } }
        },
      }
    },
  })
  await runtime.receive(codebuffBridgeLine({ type: "init", cwd: "/workspace" }))
  await runtime.receive(
    codebuffBridgeLine({
      type: "run",
      turnId: "t",
      agent: "codebuff/base@0.0.16",
      prompt: "hello",
      previousRun: { previous: true },
    })
  )
  expect(frames.at(-1)).toMatchObject({
    type: "host-request",
    kind: "approval",
    name: "write_file",
  })
  const permission = frames.at(-1)!
  await runtime.receive(
    codebuffBridgeLine({ type: "host-result", requestId: permission.requestId, result: true })
  )
  await tick()
  expect(frames).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "chunk", turnId: "t", chunk: "text" }),
      expect.objectContaining({ type: "result", turnId: "t" }),
    ])
  )
  expect(signal.aborted).toBe(false)
  expect(hooks.cwd).toBe("/workspace")
  runtime.close()
})
it("proxies streamed fetch with acknowledgements and keeps abort active after headers", async () => {
  const frames: BridgeFrame[] = [],
    runtime = new CodebuffBridgeRuntime({
      send: async (f) => {
        frames.push(f)
      },
      createClient: async () => ({ run: async () => ({}) }),
    })
  const controller = new AbortController(),
    promise = runtime.fetch("https://example.com/model", {
      method: "POST",
      body: "private prompt",
      signal: controller.signal,
    })
  await tick()
  const request = frames.find((f) => f.type === "host-request")!
  expect(request).toMatchObject({ kind: "network", body: "private prompt" })
  await runtime.receive(
    codebuffBridgeLine({
      type: "network-head",
      requestId: request.requestId,
      status: 200,
      headers: {},
    })
  )
  const response = await promise,
    reader = response.body!.getReader()
  await runtime.receive(
    codebuffBridgeLine({
      type: "network-chunk",
      requestId: request.requestId,
      seq: 0,
      data: btoa("one"),
    })
  )
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("one")
  expect(frames).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "network-ack", seq: 0 })])
  )
  const pending = reader.read()
  controller.abort()
  await expect(pending).rejects.toThrow(/cancelled/)
  expect(frames.at(-1)).toMatchObject({ type: "network-cancel", requestId: request.requestId })
  reader.releaseLock()
  runtime.close()
})
it("rejects oversized bodies during reading and cancels the source", async () => {
  const cancel = jest.fn(),
    stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(128))
      },
      cancel,
    })
  await expect(readCodebuffBoundedText(stream, 64)).rejects.toThrow(/limit/)
  expect(cancel).toHaveBeenCalledTimes(1)
})
