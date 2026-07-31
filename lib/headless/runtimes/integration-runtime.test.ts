const registerHeadlessRuntime = jest.fn()
const startIntegrationRuntime = jest.fn()

jest.mock("../registry", () => ({
  registerHeadlessRuntime: (...args: unknown[]) => registerHeadlessRuntime(...args),
}))
jest.mock("@/lib/integrations/runtime", () => ({
  startIntegrationRuntime: (...args: unknown[]) => startIntegrationRuntime(...args),
}))

describe("Integration headless runtime", () => {
  beforeEach(() => {
    jest.resetModules()
    registerHeadlessRuntime.mockReset()
    startIntegrationRuntime.mockReset()
  })

  it("registers the same Integration control plane for the brain host", async () => {
    await import("./integration-runtime")
    expect(registerHeadlessRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "integration-runtime",
        hosts: ["brain"],
        start: expect.any(Function),
      })
    )
    const runtime = registerHeadlessRuntime.mock.calls[0][0]
    runtime.start()
    expect(startIntegrationRuntime).toHaveBeenCalledTimes(1)
  })
})
