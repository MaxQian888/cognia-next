import { invoke } from "@tauri-apps/api/core"
import { runPython, type PythonExecResult } from "./canvas"

const mockedInvoke = invoke as unknown as jest.Mock

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

describe("lib/tauri/canvas", () => {
  beforeEach(() => {
    mockedInvoke.mockReset()
    setTauri(false)
  })

  afterEach(() => {
    setTauri(false)
  })

  it("throws outside Tauri runtime", async () => {
    await expect(runPython("print(1)")).rejects.toThrow(
      "canvas_run_python requires the Tauri desktop runtime"
    )
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it("invokes canvas_run_python with code and timeout when in Tauri", async () => {
    setTauri(true)
    const fakeResult: PythonExecResult = {
      stdout: "hi",
      stderr: "",
      exit_code: 0,
      duration_ms: 12,
    }
    mockedInvoke.mockResolvedValue(fakeResult)
    const result = await runPython("print('hi')", 5000)
    expect(mockedInvoke).toHaveBeenCalledWith("canvas_run_python", {
      code: "print('hi')",
      timeoutMs: 5000,
    })
    expect(result).toEqual(fakeResult)
  })

  it("forwards undefined timeout when omitted", async () => {
    setTauri(true)
    const fakeResult: PythonExecResult = {
      stdout: "",
      stderr: "",
      exit_code: 0,
      duration_ms: 1,
    }
    mockedInvoke.mockResolvedValue(fakeResult)
    await runPython("1+1")
    expect(mockedInvoke).toHaveBeenCalledWith("canvas_run_python", {
      code: "1+1",
      timeoutMs: undefined,
    })
  })

  it("propagates rejection from invoke", async () => {
    setTauri(true)
    mockedInvoke.mockRejectedValue(new Error("python boom"))
    await expect(runPython("oops")).rejects.toThrow("python boom")
  })
})
