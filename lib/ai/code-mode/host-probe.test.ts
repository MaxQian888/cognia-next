const mockCanUseTauriInvoke = jest.fn(() => true)
jest.mock("@/lib/native/utils", () => ({
  canUseTauriInvoke: () => mockCanUseTauriInvoke(),
}))

import { hostToolPresentations, probeCodeSandboxHost } from "./host-probe"

beforeEach(() => mockCanUseTauriInvoke.mockReturnValue(true))

describe("probeCodeSandboxHost", () => {
  it("reads the host-process capability from the platform check", () => {
    expect(probeCodeSandboxHost().canSpawnProcess).toBe(true)
    mockCanUseTauriInvoke.mockReturnValue(false)
    expect(probeCodeSandboxHost().canSpawnProcess).toBe(false)
  })

  // The default that keeps Code off until the sidecar actually answers.
  it("reports strictSandbox false when nothing has been reported", () => {
    expect(probeCodeSandboxHost().strictSandbox).toBe(false)
  })

  it("only accepts an explicit true as a reported strict sandbox", () => {
    expect(probeCodeSandboxHost({ strictSandboxReported: true }).strictSandbox).toBe(true)
    expect(probeCodeSandboxHost({ strictSandboxReported: false }).strictSandbox).toBe(false)
    expect(probeCodeSandboxHost({ strictSandboxReported: undefined }).strictSandbox).toBe(false)
  })

  it("lets a test inject the host-process answer", () => {
    mockCanUseTauriInvoke.mockReturnValue(true)
    expect(probeCodeSandboxHost({ hasHostProcess: false }).canSpawnProcess).toBe(false)
  })
})

describe("hostToolPresentations", () => {
  it("offers native only on a host with no reported sandbox", () => {
    expect(hostToolPresentations()).toEqual(["native"])
  })

  it("offers native only in a browser host", () => {
    mockCanUseTauriInvoke.mockReturnValue(false)
    expect(hostToolPresentations({ strictSandboxReported: true })).toEqual(["native"])
  })

  it("offers the sandboxed presentations once both signals are true", () => {
    expect(hostToolPresentations({ hasHostProcess: true, strictSandboxReported: true })).toEqual(
      expect.arrayContaining(["native", "code", "both"])
    )
  })
})
