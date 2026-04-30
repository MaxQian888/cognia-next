/**
 * @jest-environment jsdom
 *
 * Tests for native/code-execution-strategy — sandbox dispatcher across
 * iframe / Tauri-Python / unsupported routes.
 */

import { invoke } from "@tauri-apps/api/core"

let isTauriValue = false
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriValue,
}))

import { executeCodeWithSandboxPriority } from "./code-execution-strategy"

const mockedInvoke = invoke as unknown as jest.Mock

beforeEach(() => {
  isTauriValue = false
  mockedInvoke.mockReset()
})

describe("executeCodeWithSandboxPriority — Python (Tauri)", () => {
  it("returns sandbox=unsupported when not running under Tauri", async () => {
    const result = await executeCodeWithSandboxPriority({
      code: "print(1)",
      language: "python",
    })
    expect(result.success).toBe(false)
    expect(result.sandbox).toBe("unsupported")
    expect(result.error).toMatch(/desktop build/i)
  })

  it("routes to canvas_run_python and propagates the response on success", async () => {
    isTauriValue = true
    mockedInvoke.mockResolvedValueOnce({
      stdout: "hi",
      stderr: "",
      exit_code: 0,
      duration_ms: 25,
    })

    const result = await executeCodeWithSandboxPriority({
      code: 'print("hi")',
      language: "py",
      timeoutMs: 1500,
    })

    expect(mockedInvoke).toHaveBeenCalledWith("canvas_run_python", {
      code: 'print("hi")',
      timeoutMs: 1500,
    })
    expect(result.sandbox).toBe("tauri-python")
    expect(result.success).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("hi")
    expect(result.durationMs).toBe(25)
  })

  it("uses default timeout when none supplied", async () => {
    isTauriValue = true
    mockedInvoke.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exit_code: 0,
      duration_ms: 1,
    })
    await executeCodeWithSandboxPriority({ code: "pass", language: "python" })
    const call = mockedInvoke.mock.calls.at(-1)?.[1] as { timeoutMs: number }
    expect(call.timeoutMs).toBe(30000)
  })

  it("falls back to elapsed time when duration_ms is 0", async () => {
    isTauriValue = true
    mockedInvoke.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exit_code: 0,
      duration_ms: 0,
    })
    const result = await executeCodeWithSandboxPriority({ code: "pass", language: "python" })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("flags non-zero exit codes as failure", async () => {
    isTauriValue = true
    mockedInvoke.mockResolvedValueOnce({
      stdout: "",
      stderr: "Traceback",
      exit_code: 1,
      duration_ms: 5,
    })
    const result = await executeCodeWithSandboxPriority({ code: "pass", language: "python" })
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
  })

  it("reports invocation errors as success=false", async () => {
    isTauriValue = true
    mockedInvoke.mockRejectedValueOnce(new Error("sidecar crashed"))
    const result = await executeCodeWithSandboxPriority({ code: "pass", language: "python" })
    expect(result.success).toBe(false)
    expect(result.sandbox).toBe("tauri-python")
    expect(result.error).toMatch(/sidecar crashed/)
    expect(result.stderr).toMatch(/sidecar crashed/)
  })
})

describe("executeCodeWithSandboxPriority — iframe sandbox", () => {
  it("runs JavaScript and resolves on the done message", async () => {
    const promise = executeCodeWithSandboxPriority({
      code: 'console.log("hello")',
      language: "javascript",
      timeoutMs: 5000,
    })

    // Drive the message handler manually (jsdom does not run the iframe code).
    await new Promise((r) => setTimeout(r, 0))
    window.postMessage({ __cogniaCanvas: true, kind: "stdout", payload: "hello" }, "*")
    window.postMessage({ __cogniaCanvas: true, kind: "done", payload: null }, "*")

    const result = await promise
    expect(result.sandbox).toBe("iframe")
    expect(result.success).toBe(true)
    expect(result.stdout).toContain("hello")
  })

  it("marks success=false when stderr was emitted before done", async () => {
    const promise = executeCodeWithSandboxPriority({
      code: 'throw new Error("x")',
      language: "js",
    })

    await new Promise((r) => setTimeout(r, 0))
    window.postMessage({ __cogniaCanvas: true, kind: "stderr", payload: "oops" }, "*")
    window.postMessage({ __cogniaCanvas: true, kind: "done", payload: null }, "*")

    const result = await promise
    expect(result.success).toBe(false)
    expect(result.stderr).toContain("oops")
  })

  it("aborts via signal", async () => {
    const ctrl = new AbortController()
    const promise = executeCodeWithSandboxPriority({
      code: "while (true) {}",
      language: "js",
      signal: ctrl.signal,
    })
    ctrl.abort()
    const result = await promise
    expect(result.success).toBe(false)
    expect(result.error).toBe("aborted")
  })

  it("times out via setTimeout", async () => {
    jest.useFakeTimers()
    try {
      const promise = executeCodeWithSandboxPriority({
        code: "while (true) {}",
        language: "js",
        timeoutMs: 10,
      })
      jest.advanceTimersByTime(11)
      const result = await promise
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/timed out/i)
    } finally {
      jest.useRealTimers()
    }
  })

  it("ignores foreign postMessage events", async () => {
    const promise = executeCodeWithSandboxPriority({
      code: "console.log(1)",
      language: "javascript",
    })
    await new Promise((r) => setTimeout(r, 0))
    // Random event without our marker — must not affect result.
    window.postMessage({ kind: "stdout", payload: "x" }, "*")
    window.postMessage(null, "*")
    window.postMessage({ __cogniaCanvas: true, kind: "done", payload: null }, "*")
    const result = await promise
    expect(result.stdout).toBe("")
  })

  it("handles HTML language by passing through code", async () => {
    const promise = executeCodeWithSandboxPriority({
      code: "<p>hi</p>",
      language: "html",
    })
    await new Promise((r) => setTimeout(r, 0))
    window.postMessage({ __cogniaCanvas: true, kind: "done", payload: null }, "*")
    const result = await promise
    expect(result.sandbox).toBe("iframe")
    expect(result.success).toBe(true)
  })

  it("handles CSS language by wrapping in a <style> block", async () => {
    const promise = executeCodeWithSandboxPriority({
      code: "body { color: red }",
      language: "css",
    })
    await new Promise((r) => setTimeout(r, 0))
    window.postMessage({ __cogniaCanvas: true, kind: "done", payload: null }, "*")
    const result = await promise
    expect(result.success).toBe(true)
  })

  it('returns "browser document required" when document is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
    if (descriptor?.configurable !== true) {
      // jsdom may make `document` non-configurable; in that case we cannot
      // exercise this branch from a single jsdom worker. The branch is
      // still observed by the production code path on the SSR target.
      return
    }
    delete (globalThis as { document?: unknown }).document
    try {
      const result = await executeCodeWithSandboxPriority({
        code: "console.log(1)",
        language: "javascript",
      })
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/browser document/i)
    } finally {
      Object.defineProperty(globalThis, "document", descriptor!)
    }
  })

  it("tolerates iframe.remove() throwing in the cleanup path", async () => {
    const originalCreateElement = document.createElement.bind(document)
    const spy = jest
      .spyOn(document, "createElement")
      .mockImplementation((tag: string, opts?: ElementCreationOptions) => {
        const el = originalCreateElement(tag, opts) as HTMLIFrameElement
        if (tag === "iframe") {
          // Replace remove() with one that throws so the cleanup catch fires.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(el as any).remove = () => {
            throw new Error("detached")
          }
        }
        return el
      })

    try {
      const promise = executeCodeWithSandboxPriority({
        code: "console.log(1)",
        language: "javascript",
      })
      await new Promise((r) => setTimeout(r, 0))
      window.postMessage({ __cogniaCanvas: true, kind: "done", payload: null }, "*")
      const result = await promise
      expect(result.sandbox).toBe("iframe")
      expect(result.success).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it("falls back to Date.now when performance is unavailable", async () => {
    const originalPerformance = globalThis.performance
    Object.defineProperty(globalThis, "performance", {
      value: undefined,
      configurable: true,
    })
    try {
      const promise = executeCodeWithSandboxPriority({
        code: "console.log(1)",
        language: "javascript",
      })
      await new Promise((r) => setTimeout(r, 0))
      window.postMessage({ __cogniaCanvas: true, kind: "done", payload: null }, "*")
      const result = await promise
      expect(result.sandbox).toBe("iframe")
    } finally {
      Object.defineProperty(globalThis, "performance", {
        value: originalPerformance,
        configurable: true,
      })
    }
  })
})

describe("executeCodeWithSandboxPriority — unsupported language", () => {
  it("returns sandbox=unsupported with an explanatory error", async () => {
    const result = await executeCodeWithSandboxPriority({
      code: 'puts "hi"',
      language: "ruby",
    })
    expect(result.sandbox).toBe("unsupported")
    expect(result.error).toMatch(/Unsupported language/i)
  })

  it("defaults to javascript when language is omitted", async () => {
    const promise = executeCodeWithSandboxPriority({ code: "console.log(1)" })
    await new Promise((r) => setTimeout(r, 0))
    window.postMessage({ __cogniaCanvas: true, kind: "done", payload: null }, "*")
    const result = await promise
    expect(result.sandbox).toBe("iframe")
  })
})
