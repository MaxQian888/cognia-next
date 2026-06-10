/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

const executeMock = jest.fn()
jest.mock("@/lib/native/code-execution-strategy", () => ({
  executeCodeWithSandboxPriority: (args: unknown) => executeMock(args),
}))

const isDesktopRef = { current: false }
jest.mock("@/stores", () => ({
  useNativeStore: <T>(selector: (s: { isDesktop: boolean }) => T): T =>
    selector({ isDesktop: isDesktopRef.current }),
}))

const sandboxDefaultRef = { current: false }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T>(selector: (s: { settings: { sandboxDefaultEnabled: boolean } }) => T): T =>
    selector({ settings: { sandboxDefaultEnabled: sandboxDefaultRef.current } }),
}))

jest.mock("@/lib/logging", () => ({
  loggers: { canvas: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } },
}))

import { useCodeExecution } from "./use-code-execution"

beforeEach(() => {
  executeMock.mockReset()
  isDesktopRef.current = false
  sandboxDefaultRef.current = false
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

  it("forwards isDesktop to the strategy", async () => {
    isDesktopRef.current = true
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
      sandboxed: false,
    })
  })

  it("forwards the global sandbox toggle to the strategy (ADR-0028 Phase 3)", async () => {
    sandboxDefaultRef.current = true
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
})
