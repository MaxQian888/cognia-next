/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const executeMock = jest.fn()
const availabilityMock = jest.fn(
  (..._args: unknown[]) =>
    ({ available: true, reason: null }) as { available: boolean; reason: string | null }
)
jest.mock("@/lib/native/code-execution-strategy", () => ({
  executeCodeWithSandboxPriority: (args: unknown) => executeMock(args),
  codeExecutionAvailability: (...args: unknown[]) => availabilityMock(...args),
}))

// Settings, Canvas, Execution. Every field here had a control and no reader
// until the hook started reading them.
const executionRef = {
  current: { maxExecutionTime: 30000, showOutput: true, clearOutputOnRun: false },
}
jest.mock("@/stores/canvas/canvas-settings-store", () => ({
  useCanvasSettingsStore: <T>(
    selector: (s: { settings: { execution: typeof executionRef.current } }) => T
  ): T => selector({ settings: { execution: executionRef.current } }),
}))

const isDesktopRef = { current: false }
jest.mock("@/stores", () => ({
  useNativeStore: <T>(selector: (s: { isDesktop: boolean }) => T): T =>
    selector({ isDesktop: isDesktopRef.current }),
}))

const canvasSandboxRef: { current: boolean | undefined } = { current: true }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T>(
    selector: (s: { settings: { canvasCodeSandboxEnabled: boolean | undefined } }) => T
  ): T => selector({ settings: { canvasCodeSandboxEnabled: canvasSandboxRef.current } }),
}))

jest.mock("@cognia/logging", () => ({
  loggers: { canvas: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } },
}))

import { useCodeExecution } from "./use-code-execution"

beforeEach(() => {
  executeMock.mockReset()
  isDesktopRef.current = false
  // Canvas code is confined by DEFAULT (ADR-0028).
  canvasSandboxRef.current = true
})

describe("useCodeExecution", () => {
  it("executes successfully and stores the result", async () => {
    const ok = {
      success: true,
      sandbox: "browser",
      stdout: "out",
      stderr: "",
      exitCode: 0,
      durationMs: 10,
      executionTime: 10,
      language: "ts",
    }
    executeMock.mockResolvedValueOnce(ok)
    const { result } = renderHook(() => useCodeExecution())
    let res: unknown
    await act(async () => {
      res = await result.current.execute("code", "ts")
    })
    expect(res).toEqual(ok)
    expect(result.current.result).toEqual(ok)
    expect(result.current.error).toBeNull()
  })

  it("captures Error and returns an unsupported result", async () => {
    executeMock.mockRejectedValueOnce(new Error("no runtime"))
    const { result } = renderHook(() => useCodeExecution())
    let res: { success: boolean; stderr: string } | undefined
    await act(async () => {
      res = (await result.current.execute("code", "ts")) as never
    })
    expect(res?.success).toBe(false)
    expect(res?.stderr).toBe("no runtime")
    expect(result.current.error).toBe("no runtime")
  })

  it("uses errorMessageFallback for non-Error throws", async () => {
    executeMock.mockRejectedValueOnce("string failure")
    const { result } = renderHook(() => useCodeExecution())
    let res: { stderr: string } | undefined
    await act(async () => {
      res = (await result.current.execute("code", "ts", {
        errorMessageFallback: "fallback msg",
      })) as never
    })
    expect(res?.stderr).toBe("fallback msg")
  })

  it("non-Error throw without fallback uses 'Execution failed'", async () => {
    executeMock.mockRejectedValueOnce("oops")
    const { result } = renderHook(() => useCodeExecution())
    let res: { stderr: string } | undefined
    await act(async () => {
      res = (await result.current.execute("code", "ts")) as never
    })
    expect(res?.stderr).toBe("Execution failed")
  })

  it("cancel sets isExecuting to false and prevents result update", async () => {
    let resolveRun: (v: unknown) => void = () => undefined
    executeMock.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveRun = (v) => r(v)
        })
    )
    const { result } = renderHook(() => useCodeExecution())
    let promise!: Promise<unknown>
    act(() => {
      promise = result.current.execute("code", "ts")
    })
    act(() => {
      result.current.cancel()
    })
    expect(result.current.isExecuting).toBe(false)
    await act(async () => {
      resolveRun({
        success: true,
        sandbox: "browser",
        stdout: "x",
        stderr: "",
        exitCode: 0,
        durationMs: 5,
        executionTime: 5,
        language: "ts",
      })
      await promise
    })
    expect(result.current.result).toBeNull()
  })

  it("clear resets result and error", async () => {
    executeMock.mockRejectedValueOnce(new Error("x"))
    const { result } = renderHook(() => useCodeExecution())
    await act(async () => {
      await result.current.execute("code", "ts")
    })
    expect(result.current.error).toBe("x")
    act(() => result.current.clear())
    expect(result.current.error).toBeNull()
    expect(result.current.result).toBeNull()
  })

  it("forwards isDesktop and the opt-out to the strategy", async () => {
    isDesktopRef.current = true
    // Explicit opt-out → Canvas code runs unconfined.
    canvasSandboxRef.current = false
    executeMock.mockResolvedValueOnce({
      success: true,
      sandbox: "desktop",
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      executionTime: 0,
      language: "ts",
    })
    const { result } = renderHook(() => useCodeExecution())
    await act(async () => {
      await result.current.execute("code", "ts", { stdin: "in" })
    })
    expect(executeMock).toHaveBeenCalledWith({
      code: "code",
      language: "ts",
      isDesktop: true,
      stdin: "in",
      // The settings value is the default now, not the strategy's hardcoded 30s.
      timeoutMs: 30000,
      signal: expect.anything(),
      sandboxed: false,
      // Without an id, Stop only detaches the renderer and the interpreter
      // runs on to its timeout.
      runId: expect.any(String),
    })
  })

  it("forwards the requested timeout and aborts the active iframe run on cancel", async () => {
    let capturedSignal: AbortSignal | undefined
    executeMock.mockImplementationOnce(
      (args: unknown) =>
        new Promise((resolve) => {
          capturedSignal = (args as { signal: AbortSignal }).signal
          capturedSignal.addEventListener("abort", () =>
            resolve({
              success: false,
              sandbox: "iframe",
              stdout: "",
              stderr: "",
              durationMs: 0,
              error: "aborted",
            })
          )
        })
    )
    const { result } = renderHook(() => useCodeExecution())
    let run!: Promise<unknown>
    act(() => {
      run = result.current.execute("while(true){}", "js", { timeout: 1234 })
    })

    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 1234, signal: expect.any(AbortSignal) })
    )
    act(() => result.current.cancel())
    expect(capturedSignal?.aborted).toBe(true)
    await act(async () => {
      await run
    })
  })

  it("confines Canvas code by default (ADR-0028)", async () => {
    // canvasSandboxRef defaults to true in beforeEach — no opt-in needed.
    executeMock.mockResolvedValueOnce({
      success: true,
      sandbox: "tauri-python",
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      executionTime: 0,
      language: "python",
    })
    const { result } = renderHook(() => useCodeExecution())
    await act(async () => {
      await result.current.execute("print(1)", "python")
    })
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({ language: "python", sandboxed: true })
    )
  })

  it("defaults to confined when the setting is unset", async () => {
    // Setting absent → `?? true` fallback ⇒ confined.
    canvasSandboxRef.current = undefined
    executeMock.mockResolvedValueOnce({
      success: true,
      sandbox: "tauri-python",
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      executionTime: 0,
      language: "python",
    })
    const { result } = renderHook(() => useCodeExecution())
    await act(async () => {
      await result.current.execute("print(1)", "python")
    })
    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({ sandboxed: true }))
  })
})

describe("useCodeExecution — settings that used to do nothing", () => {
  it("clears the previous output when the setting asks for it", async () => {
    executionRef.current = { ...executionRef.current, clearOutputOnRun: true }
    executeMock.mockResolvedValue({
      success: true,
      sandbox: "iframe",
      stdout: "second",
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      executionTime: 0,
      language: "javascript",
    })
    const { result } = renderHook(() => useCodeExecution())

    await act(async () => {
      await result.current.execute("a", "javascript")
    })
    expect(result.current.result?.stdout).toBe("second")
  })

  it("uses the configured timeout, and an explicit one still wins", async () => {
    executionRef.current = { ...executionRef.current, maxExecutionTime: 5000 }
    executeMock.mockResolvedValue({
      success: true,
      sandbox: "iframe",
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      executionTime: 0,
      language: "javascript",
    })
    const { result } = renderHook(() => useCodeExecution())

    await act(async () => {
      await result.current.execute("a", "javascript")
    })
    expect(executeMock.mock.calls.at(-1)?.[0].timeoutMs).toBe(5000)

    await act(async () => {
      await result.current.execute("a", "javascript", { timeout: 1234 })
    })
    expect(executeMock.mock.calls.at(-1)?.[0].timeoutMs).toBe(1234)
  })

  it("reports whether the output pane should render at all", () => {
    executionRef.current = { ...executionRef.current, showOutput: false }
    const { result } = renderHook(() => useCodeExecution())
    expect(result.current.showOutput).toBe(false)
  })

  it("answers availability before the click, from the host", () => {
    // The panel used to offer Run for every document and answer with
    // `sandbox: "unsupported"` after it was pressed.
    isDesktopRef.current = true
    availabilityMock.mockReturnValue({ available: false, reason: "desktop-only" })
    const { result } = renderHook(() => useCodeExecution())

    expect(result.current.availabilityFor("python")).toEqual({
      available: false,
      reason: "desktop-only",
    })
    expect(availabilityMock).toHaveBeenCalledWith("python", true)
  })

  it("gives every run its own id so the host can kill the right one", async () => {
    executeMock.mockResolvedValue({
      success: true,
      sandbox: "iframe",
      stdout: "",
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      executionTime: 0,
      language: "javascript",
    })
    const { result } = renderHook(() => useCodeExecution())

    await act(async () => {
      await result.current.execute("a", "javascript")
    })
    await act(async () => {
      await result.current.execute("b", "javascript")
    })

    const ids = executeMock.mock.calls.slice(-2).map((call) => call[0].runId)
    expect(ids[0]).toBeTruthy()
    expect(ids[0]).not.toBe(ids[1])
  })
})
