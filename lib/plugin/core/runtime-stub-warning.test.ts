const getPluginMock = jest.fn()
const updatePluginMock = jest.fn()
const debugMock = jest.fn()

jest.mock("@/lib/db/plugins", () => ({
  getPlugin: (id: string) => getPluginMock(id),
  updatePlugin: (id: string, patch: unknown) => updatePluginMock(id, patch),
}))
jest.mock("@cognia/logging", () => ({
  loggers: { plugin: { debug: (...args: unknown[]) => debugMock(...args) } },
}))

import { persistRuntimeStubWarning, RUNTIME_STUB_WARNINGS } from "./runtime-stub-warning"

beforeEach(() => {
  getPluginMock.mockReset()
  updatePluginMock.mockReset().mockResolvedValue(undefined)
  debugMock.mockReset()
})

describe("persistRuntimeStubWarning", () => {
  it("names one code per stubbed runtime", () => {
    expect(RUNTIME_STUB_WARNINGS).toEqual({
      python: "python-runtime-unavailable",
      wasm: "wasm-runtime-unavailable",
      vscode: "vscode-runtime-unavailable",
    })
  })

  it("appends the marker to the row's manifest", async () => {
    getPluginMock.mockResolvedValue({ id: "p1", manifest: { id: "p1" } })
    await persistRuntimeStubWarning("p1", RUNTIME_STUB_WARNINGS.wasm)
    expect(updatePluginMock).toHaveBeenCalledWith("p1", {
      manifest: { id: "p1", _cogniaWarnings: ["wasm-runtime-unavailable"] },
    })
  })

  it("keeps markers left by other runtimes", async () => {
    getPluginMock.mockResolvedValue({
      manifest: { id: "p1", _cogniaWarnings: ["python-runtime-unavailable"] },
    })
    await persistRuntimeStubWarning("p1", RUNTIME_STUB_WARNINGS.vscode)
    expect(updatePluginMock).toHaveBeenCalledWith("p1", {
      manifest: {
        id: "p1",
        _cogniaWarnings: ["python-runtime-unavailable", "vscode-runtime-unavailable"],
      },
    })
  })

  // Activation can run repeatedly (enable, disable, enable). A marker per
  // attempt would grow the manifest without bound.
  it("is idempotent", async () => {
    getPluginMock.mockResolvedValue({
      manifest: { id: "p1", _cogniaWarnings: ["wasm-runtime-unavailable"] },
    })
    await persistRuntimeStubWarning("p1", RUNTIME_STUB_WARNINGS.wasm)
    expect(updatePluginMock).not.toHaveBeenCalled()
  })

  it("does nothing when the row is gone", async () => {
    getPluginMock.mockResolvedValue(undefined)
    await persistRuntimeStubWarning("p1", RUNTIME_STUB_WARNINGS.wasm)
    expect(updatePluginMock).not.toHaveBeenCalled()
  })

  // Called detached from activate, so a write failure must never propagate.
  it("swallows a write failure and logs it", async () => {
    getPluginMock.mockRejectedValue(new Error("db closed"))
    await expect(
      persistRuntimeStubWarning("p1", RUNTIME_STUB_WARNINGS.wasm)
    ).resolves.toBeUndefined()
    expect(debugMock).toHaveBeenCalled()
  })
})
