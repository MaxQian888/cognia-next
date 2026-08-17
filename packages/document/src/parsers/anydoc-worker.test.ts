import type {
  AnyDocRuntimeLoader,
  AnyDocWorkerRequest,
  AnyDocWorkerResponse,
} from "./anydoc-worker"
import { handleAnyDocWorkerRequest, registerAnyDocWorker } from "./anydoc-worker"

function request(overrides: Partial<AnyDocWorkerRequest> = {}): AnyDocWorkerRequest {
  return {
    type: "parse",
    requestId: "request-1",
    bytes: new ArrayBuffer(4),
    format: "doc",
    ...overrides,
  }
}

function runtimeLoader(
  detectedFormat: "doc" | "docx" | "ppt" | "pptx" | null = "doc",
  markdown: string | Error = "# Parsed"
): AnyDocRuntimeLoader {
  const resolvedFormat = detectedFormat ?? undefined
  return async () => ({
    default: jest.fn(),
    formatFromBytes: jest.fn(() => resolvedFormat),
    toMarkdownBytes: jest.fn(() => {
      if (markdown instanceof Error) throw markdown
      return markdown
    }),
  })
}

describe("AnyDoc worker protocol", () => {
  it("detects the content signature before returning Markdown", async () => {
    await expect(handleAnyDocWorkerRequest(request(), runtimeLoader())).resolves.toEqual({
      type: "success",
      requestId: "request-1",
      markdown: "# Parsed",
      detectedFormat: "doc",
    })
  })

  it("rejects extension and signature mismatches with the detected format", async () => {
    await expect(
      handleAnyDocWorkerRequest(request(), runtimeLoader("docx"))
    ).resolves.toMatchObject({
      type: "failure",
      requestId: "request-1",
      engineCode: "formatMismatch",
      detectedFormat: "docx",
      message: expect.stringContaining("docx"),
    })

    const unknown = await handleAnyDocWorkerRequest(request(), runtimeLoader(null))
    expect(unknown).toMatchObject({
      type: "failure",
      engineCode: "formatMismatch",
    })
    expect(unknown).not.toHaveProperty("detectedFormat")
  })

  it("normalizes initialization and conversion errors into clone-safe envelopes", async () => {
    await expect(
      handleAnyDocWorkerRequest(request(), async () => {
        throw new Error("WASM unavailable")
      })
    ).resolves.toEqual({
      type: "failure",
      requestId: "request-1",
      engineCode: "initFailed",
      message: "WASM unavailable",
    })

    const encrypted = Object.assign(new Error("Password required"), { code: "encrypted" })
    await expect(
      handleAnyDocWorkerRequest(request(), runtimeLoader("doc", encrypted))
    ).resolves.toMatchObject({
      type: "failure",
      engineCode: "encrypted",
      message: "Password required",
    })

    await expect(
      handleAnyDocWorkerRequest(request(), runtimeLoader("doc", new Error("unexpected")))
    ).resolves.toMatchObject({
      type: "failure",
      engineCode: "workerCrashed",
      message: "unexpected",
    })

    await expect(
      handleAnyDocWorkerRequest(request(), async () => ({
        default: jest.fn(),
        formatFromBytes: jest.fn(() => "doc"),
        toMarkdownBytes: jest.fn(() => {
          throw "not-an-error"
        }),
      }))
    ).resolves.toMatchObject({
      type: "failure",
      engineCode: "workerCrashed",
      message: "not-an-error",
    })

    const unknownCode = Object.assign(new Error("unknown code"), { code: "not-real" })
    await expect(
      handleAnyDocWorkerRequest(request(), runtimeLoader("doc", unknownCode))
    ).resolves.toMatchObject({
      type: "failure",
      engineCode: "workerCrashed",
      message: "unknown code",
    })
  })

  it("uses the production runtime loader when no test loader is supplied", async () => {
    await expect(handleAnyDocWorkerRequest(request())).resolves.toMatchObject({
      type: "failure",
      requestId: "request-1",
    })
  })

  it("classifies a missing WebAssembly runtime as initialization failure", async () => {
    const previousWebAssembly = globalThis.WebAssembly
    Object.defineProperty(globalThis, "WebAssembly", { configurable: true, value: undefined })
    try {
      await expect(handleAnyDocWorkerRequest(request())).resolves.toMatchObject({
        type: "failure",
        requestId: "request-1",
        engineCode: "initFailed",
      })
    } finally {
      Object.defineProperty(globalThis, "WebAssembly", {
        configurable: true,
        value: previousWebAssembly,
      })
    }
  })

  it("rejects malformed messages before loading WASM", async () => {
    const loadRuntime = jest.fn(runtimeLoader())
    const invalid = { ...request(), bytes: "not bytes" } as unknown as AnyDocWorkerRequest

    await expect(handleAnyDocWorkerRequest(invalid, loadRuntime)).resolves.toMatchObject({
      type: "failure",
      engineCode: "malformed",
    })
    expect(loadRuntime).not.toHaveBeenCalled()

    await expect(
      handleAnyDocWorkerRequest(undefined as unknown as AnyDocWorkerRequest, loadRuntime)
    ).resolves.toMatchObject({
      type: "failure",
      requestId: "",
      engineCode: "malformed",
    })
    expect(loadRuntime).not.toHaveBeenCalled()
  })

  it("registers one message handler and posts its serialized response", async () => {
    let listener: ((event: MessageEvent<AnyDocWorkerRequest>) => void | Promise<void>) | undefined
    const responses: AnyDocWorkerResponse[] = []
    const scope = {
      addEventListener: jest.fn(
        (
          _type: "message",
          next: (event: MessageEvent<AnyDocWorkerRequest>) => void | Promise<void>
        ) => {
          listener = next
        }
      ),
      postMessage: jest.fn((response: AnyDocWorkerResponse) => responses.push(response)),
    }

    registerAnyDocWorker(scope, runtimeLoader("ppt", "# Slides"))
    await listener?.({ data: request({ format: "ppt" }) } as MessageEvent<AnyDocWorkerRequest>)

    expect(scope.addEventListener).toHaveBeenCalledWith("message", expect.any(Function))
    expect(responses).toEqual([
      {
        type: "success",
        requestId: "request-1",
        markdown: "# Slides",
        detectedFormat: "ppt",
      },
    ])
  })
})
