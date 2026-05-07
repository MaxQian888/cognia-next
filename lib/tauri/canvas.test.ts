import { transport } from "@/lib/tauri"
import { runPython, type PythonExecResult } from "./canvas"

describe("lib/tauri/canvas", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("rejects with the WebStub error in web mode (no spy)", async () => {
    // Module-scope transport selected at first import in jsdom is WebStubTransport.
    await expect(runPython("print(1)")).rejects.toThrow(
      "tauri-only command from web mode: canvas_run_python"
    )
  })

  it("delegates to transport.call with code + timeoutMs", async () => {
    const fakeResult: PythonExecResult = {
      stdout: "hi",
      stderr: "",
      exit_code: 0,
      duration_ms: 12,
    }
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce(fakeResult)
    const result = await runPython("print('hi')", 5000)
    expect(callSpy).toHaveBeenCalledWith("canvas_run_python", {
      code: "print('hi')",
      timeoutMs: 5000,
    })
    expect(result).toEqual(fakeResult)
  })

  it("forwards undefined timeout when omitted", async () => {
    const fakeResult: PythonExecResult = {
      stdout: "",
      stderr: "",
      exit_code: 0,
      duration_ms: 1,
    }
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce(fakeResult)
    await runPython("1+1")
    expect(callSpy).toHaveBeenCalledWith("canvas_run_python", {
      code: "1+1",
      timeoutMs: undefined,
    })
  })

  it("propagates rejection from transport.call", async () => {
    jest.spyOn(transport, "call").mockRejectedValueOnce(new Error("python boom"))
    await expect(runPython("oops")).rejects.toThrow("python boom")
  })
})
