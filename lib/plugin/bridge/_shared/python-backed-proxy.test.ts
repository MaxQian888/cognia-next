import {
  PYTHON_CONTRIBUTION_DISPATCH,
  createDescribedPythonContribution,
  createPythonBackedProxy,
  isPythonBackedContribution,
  subscribePythonContributionPush,
  type PythonCallTransport,
  type PythonEventSubscribe,
} from "./python-backed-proxy"
import type { PythonPluginEvent } from "@/lib/plugin/python/log-buffer"
import { isHeadlessHost } from "@/lib/platform/detect"
import { invoke } from "@tauri-apps/api/core"
import { transport } from "@/lib/tauri/transport-instance"

jest.mock("@/lib/platform/detect", () => ({ isHeadlessHost: jest.fn(() => false) }))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn(async () => "via-invoke") }))
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: jest.fn(async () => "via-transport") },
}))

const mockIsHeadlessHost = isHeadlessHost as jest.MockedFunction<typeof isHeadlessHost>
const mockInvoke = invoke as jest.MockedFunction<typeof invoke>
const mockTransportCall = transport.call as jest.MockedFunction<typeof transport.call>

/** Minimal in-memory stand-in for the `plugin:python` fan-out. */
function createEventHarness() {
  const listeners = new Set<(event: PythonPluginEvent) => void>()
  const subscribe: PythonEventSubscribe = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return {
    subscribe,
    listenerCount: () => listeners.size,
    emit(event: PythonPluginEvent) {
      for (const listener of [...listeners]) listener(event)
    },
  }
}

interface OcrLike {
  extract(image: string): Promise<unknown>
}

describe("createPythonBackedProxy", () => {
  it("routes a method call through the contribution dispatcher", async () => {
    const call = jest.fn<ReturnType<PythonCallTransport>, Parameters<PythonCallTransport>>(
      async () => "recognized"
    )
    const proxy = createPythonBackedProxy<OcrLike>({
      pluginId: "py-ocr",
      contributionId: "tesseract",
      methods: ["extract"],
      call,
    })

    await expect(proxy.extract("a.png")).resolves.toBe("recognized")
    expect(call).toHaveBeenCalledWith("py-ocr", PYTHON_CONTRIBUTION_DISPATCH, [
      "tesseract",
      "extract",
      ["a.png"],
      null,
    ])
  })

  it("exposes exactly the requested methods", () => {
    const proxy = createPythonBackedProxy<Record<string, unknown>>({
      pluginId: "p",
      contributionId: "c",
      methods: ["clone", "commitAndPush", "remove"],
      call: async () => undefined,
    })
    expect(Object.keys(proxy).sort()).toEqual(["clone", "commitAndPush", "remove"])
    for (const method of ["clone", "commitAndPush", "remove"]) {
      expect(typeof proxy[method]).toBe("function")
    }
  })

  it("wraps a transport failure with plugin and method context", async () => {
    const proxy = createPythonBackedProxy<OcrLike>({
      pluginId: "py-ocr",
      contributionId: "tesseract",
      methods: ["extract"],
      label: "OCR provider",
      call: async () => {
        throw new Error("python handler missing")
      },
    })

    await expect(proxy.extract("a.png")).rejects.toThrow(
      'python-backed OCR provider "py-ocr:tesseract".extract failed: python handler missing'
    )
  })

  it("streams chunks and returns the call's final value", async () => {
    const harness = createEventHarness()
    let resolveCall: (value: unknown) => void = () => {}
    const call: PythonCallTransport = () =>
      new Promise((resolve) => {
        resolveCall = resolve
      })

    const proxy = createPythonBackedProxy<{
      complete(prompt: string): AsyncGenerator<unknown, unknown, void>
    }>({
      pluginId: "py-ai",
      contributionId: "llm",
      methods: ["complete"],
      streamingMethods: ["complete"],
      call,
      subscribe: harness.subscribe,
      newStreamId: () => "stream-1",
    })

    const iterator = proxy.complete("hi")
    const first = iterator.next()
    // The generator only subscribes once pulled, so emit after the first pull.
    await Promise.resolve()
    harness.emit({
      pluginId: "py-ai",
      kind: "chunk",
      data: { streamId: "stream-1", value: "he" },
    })
    expect(await first).toEqual({ value: "he", done: false })

    harness.emit({
      pluginId: "py-ai",
      kind: "chunk",
      data: { streamId: "stream-1", value: "llo" },
    })
    expect(await iterator.next()).toEqual({ value: "llo", done: false })

    resolveCall("hello")
    expect(await iterator.next()).toEqual({ value: "hello", done: true })
    expect(harness.listenerCount()).toBe(0)
  })

  it("ignores frames from other plugins and other streams", async () => {
    const harness = createEventHarness()
    let resolveCall: (value: unknown) => void = () => {}
    const proxy = createPythonBackedProxy<{
      run(): AsyncGenerator<unknown, unknown, void>
    }>({
      pluginId: "mine",
      contributionId: "c",
      methods: ["run"],
      streamingMethods: ["run"],
      call: () =>
        new Promise((resolve) => {
          resolveCall = resolve
        }),
      subscribe: harness.subscribe,
      newStreamId: () => "wanted",
    })

    const iterator = proxy.run()
    const pull = iterator.next()
    await Promise.resolve()
    harness.emit({ pluginId: "other", kind: "chunk", data: { streamId: "wanted", value: "x" } })
    harness.emit({ pluginId: "mine", kind: "chunk", data: { streamId: "other", value: "y" } })
    harness.emit({ pluginId: "mine", kind: "log", data: { streamId: "wanted", value: "z" } })
    harness.emit({ pluginId: "mine", kind: "chunk", data: null })
    harness.emit({ pluginId: "mine", kind: "chunk", data: { streamId: "wanted", value: "kept" } })

    expect(await pull).toEqual({ value: "kept", done: false })
    resolveCall(undefined)
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
  })

  it("ends the stream on chunk_end even before the call resolves", async () => {
    const harness = createEventHarness()
    let resolveCall: (value: unknown) => void = () => {}
    const proxy = createPythonBackedProxy<{
      run(): AsyncGenerator<unknown, unknown, void>
    }>({
      pluginId: "p",
      contributionId: "c",
      methods: ["run"],
      streamingMethods: ["run"],
      call: () =>
        new Promise((resolve) => {
          resolveCall = resolve
        }),
      subscribe: harness.subscribe,
      newStreamId: () => "s",
    })

    const iterator = proxy.run()
    const pull = iterator.next()
    await Promise.resolve()
    harness.emit({ pluginId: "p", kind: "chunk", data: { streamId: "s", value: 1 } })
    harness.emit({ pluginId: "p", kind: "chunk_end", data: { streamId: "s" } })
    expect(await pull).toEqual({ value: 1, done: false })

    // chunk_end stops the yield loop; the generator still awaits the result.
    const final = iterator.next()
    resolveCall("done")
    expect(await final).toEqual({ value: "done", done: true })
    expect(harness.listenerCount()).toBe(0)
  })

  it("propagates a streaming failure and always unsubscribes", async () => {
    const harness = createEventHarness()
    const proxy = createPythonBackedProxy<{
      run(): AsyncGenerator<unknown, unknown, void>
    }>({
      pluginId: "p",
      contributionId: "c",
      methods: ["run"],
      streamingMethods: ["run"],
      call: async () => {
        throw new Error("boom")
      },
      subscribe: harness.subscribe,
      newStreamId: () => "s",
    })

    await expect(proxy.run().next()).rejects.toThrow('python-backed "p:c".run failed: boom')
    expect(harness.listenerCount()).toBe(0)
  })
})

describe("isPythonBackedContribution", () => {
  it("honours an explicit per-entry backend above everything else", () => {
    expect(isPythonBackedContribution({ backend: "python", entry: "dist/x.js" }, "frontend")).toBe(
      true
    )
    expect(isPythonBackedContribution({ backend: "js" }, "python")).toBe(false)
  })

  it("treats a declared JS entry as JS intent", () => {
    expect(isPythonBackedContribution({ entry: "dist/x.js" }, "python")).toBe(false)
    // An empty entry is not a declaration.
    expect(isPythonBackedContribution({ entry: "" }, "python")).toBe(true)
  })

  it("falls back to the plugin type", () => {
    expect(isPythonBackedContribution({ id: "a" }, "python")).toBe(true)
    expect(isPythonBackedContribution({ id: "a" }, "frontend")).toBe(false)
    // hybrid must be explicit; an omitted backend resolves to JS.
    expect(isPythonBackedContribution({ id: "a" }, "hybrid")).toBe(false)
    expect(isPythonBackedContribution({ id: "a" }, undefined)).toBe(false)
  })

  it("supports a non-default entry field and non-object defs", () => {
    expect(isPythonBackedContribution({ factory: "makeIt" }, "python", "factory")).toBe(false)
    expect(isPythonBackedContribution(null, "python")).toBe(true)
  })
})

describe("createDescribedPythonContribution", () => {
  it("merges the Python descriptor with proxied methods", async () => {
    const call = jest.fn(async (_pluginId: string, _fn: string, args: readonly unknown[]) => {
      const method = (args as unknown[])[1]
      if (method === "describe") {
        return { label: "Tesseract", category: "local", credentialKeys: [] }
      }
      return "text from python"
    })

    const provider = await createDescribedPythonContribution<{
      label: string
      category: string
      extract(input: string): Promise<unknown>
    }>({
      pluginId: "py-ocr",
      contributionId: "tesseract",
      methods: ["extract"],
      call,
    })

    expect(provider.label).toBe("Tesseract")
    expect(provider.category).toBe("local")
    await expect(provider.extract("a.png")).resolves.toBe("text from python")
    expect(call).toHaveBeenCalledWith("py-ocr", PYTHON_CONTRIBUTION_DISPATCH, [
      "tesseract",
      "describe",
      [],
      null,
    ])
  })

  it("still yields callable methods when describe returns a non-object", async () => {
    const contribution = await createDescribedPythonContribution<{
      run(): Promise<unknown>
    }>({
      pluginId: "p",
      contributionId: "c",
      methods: ["run"],
      call: async (_pluginId, _fn, args) => ((args as unknown[])[1] === "describe" ? null : "ran"),
    })

    expect(typeof contribution.run).toBe("function")
    await expect(contribution.run()).resolves.toBe("ran")
  })
})

describe("default transport and stream ids", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsHeadlessHost.mockReturnValue(false)
  })

  it("invokes the Tauri command directly outside a headless host", async () => {
    const proxy = createPythonBackedProxy<OcrLike>({
      pluginId: "p",
      contributionId: "c",
      methods: ["extract"],
    })

    await expect(proxy.extract("a.png")).resolves.toBe("via-invoke")
    expect(mockInvoke).toHaveBeenCalledWith("plugin_python_call", {
      pluginId: "p",
      functionName: PYTHON_CONTRIBUTION_DISPATCH,
      args: ["c", "extract", ["a.png"], null],
    })
    expect(mockTransportCall).not.toHaveBeenCalled()
  })

  it("routes through the headless transport when there is no Tauri bridge", async () => {
    mockIsHeadlessHost.mockReturnValue(true)
    const proxy = createPythonBackedProxy<OcrLike>({
      pluginId: "p",
      contributionId: "c",
      methods: ["extract"],
    })

    await expect(proxy.extract("a.png")).resolves.toBe("via-transport")
    expect(mockTransportCall).toHaveBeenCalledWith("plugin_python_call", {
      pluginId: "p",
      functionName: PYTHON_CONTRIBUTION_DISPATCH,
      args: ["c", "extract", ["a.png"], null],
    })
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("generates a distinct stream id per streaming call by default", async () => {
    const harness = createEventHarness()
    const seen: unknown[] = []
    const proxy = createPythonBackedProxy<{
      run(): AsyncGenerator<unknown, unknown, void>
    }>({
      pluginId: "p",
      contributionId: "c",
      methods: ["run"],
      streamingMethods: ["run"],
      subscribe: harness.subscribe,
      call: async (_pluginId, _fn, args) => {
        seen.push((args as unknown[])[3])
        return "ok"
      },
    })

    await proxy.run().next()
    await proxy.run().next()

    expect(seen).toHaveLength(2)
    for (const streamId of seen) {
      expect(typeof streamId).toBe("string")
      expect(streamId as string).not.toHaveLength(0)
    }
    expect(seen[0]).not.toEqual(seen[1])
  })
})

describe("subscribePythonContributionPush", () => {
  it("delivers only matching emit frames", () => {
    const harness = createEventHarness()
    const pushes: unknown[] = []
    const unsubscribe = subscribePythonContributionPush({
      pluginId: "py-connector",
      contributionId: "mail",
      onPush: (push) => pushes.push(push),
      subscribe: harness.subscribe,
    })

    // Wrong plugin, wrong kind, wrong contribution, missing channel — all dropped.
    harness.emit({
      pluginId: "other",
      kind: "emit",
      data: { contributionId: "mail", channel: "inbound", payload: 1 },
    })
    harness.emit({
      pluginId: "py-connector",
      kind: "chunk",
      data: { contributionId: "mail", channel: "inbound", payload: 2 },
    })
    harness.emit({
      pluginId: "py-connector",
      kind: "emit",
      data: { contributionId: "sms", channel: "inbound", payload: 3 },
    })
    harness.emit({
      pluginId: "py-connector",
      kind: "emit",
      data: { contributionId: "mail", payload: 4 },
    })
    harness.emit({ pluginId: "py-connector", kind: "emit", data: null })
    harness.emit({
      pluginId: "py-connector",
      kind: "emit",
      data: { contributionId: "mail", channel: "inbound", payload: { id: 5 } },
    })

    expect(pushes).toEqual([{ channel: "inbound", payload: { id: 5 } }])

    unsubscribe()
    harness.emit({
      pluginId: "py-connector",
      kind: "emit",
      data: { contributionId: "mail", channel: "inbound", payload: 6 },
    })
    expect(pushes).toHaveLength(1)
  })
})
