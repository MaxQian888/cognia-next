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
