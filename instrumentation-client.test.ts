/** @jest-environment jsdom */

const mockInstallConsoleBridge = jest.fn()

jest.mock("@cognia/logging/console-bridge", () => ({
  installConsoleBridge: () => mockInstallConsoleBridge(),
}))

describe("client instrumentation", () => {
  beforeEach(() => {
    jest.resetModules()
    mockInstallConsoleBridge.mockReset()
  })

  it("registers vector capabilities synchronously before consumers", () => {
    const { getVectorRuntimeAdapters } = jest.requireActual<
      typeof import("@cognia/vector/runtime-adapters")
    >("@cognia/vector/runtime-adapters")
    expect(() => getVectorRuntimeAdapters()).toThrow(
      "Vector runtime adapters have not been installed"
    )
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./instrumentation-client")
    expect(getVectorRuntimeAdapters().isTauri()).toBe(false)
  })

  it("installs the lightweight console bridge before hydration", async () => {
    await import("./instrumentation-client")

    expect(mockInstallConsoleBridge).toHaveBeenCalledTimes(1)
  })

  it("fails open when a restricted WebView rejects console replacement", async () => {
    mockInstallConsoleBridge.mockImplementationOnce(() => {
      throw new Error("console is read-only")
    })

    await expect(import("./instrumentation-client")).resolves.toBeDefined()
  })
})
