const mockNative = {
  acpTerminalCreate: jest.fn(async () => "t1"),
  acpTerminalOutput: jest.fn(async () => ({
    output: "out",
    truncated: false,
    exitStatus: { exitCode: 0, signal: null },
  })),
  acpTerminalWrite: jest.fn(async () => undefined),
  acpTerminalKill: jest.fn(async () => undefined),
  acpTerminalRelease: jest.fn(async () => undefined),
  acpTerminalWaitForExit: jest.fn(async () => ({ exitStatus: { exitCode: 0, signal: null } })),
  cleanupSessionTerminals: jest.fn(async () => undefined),
}
jest.mock("@/lib/native/external-agent", () => ({
  acpTerminalCreate: (...a: unknown[]) => mockNative.acpTerminalCreate(...(a as [])),
  acpTerminalOutput: (...a: unknown[]) => mockNative.acpTerminalOutput(...(a as [])),
  acpTerminalWrite: (...a: unknown[]) => mockNative.acpTerminalWrite(...(a as [])),
  acpTerminalKill: (...a: unknown[]) => mockNative.acpTerminalKill(...(a as [])),
  acpTerminalRelease: (...a: unknown[]) => mockNative.acpTerminalRelease(...(a as [])),
  acpTerminalWaitForExit: (...a: unknown[]) => mockNative.acpTerminalWaitForExit(...(a as [])),
  cleanupSessionTerminals: (...a: unknown[]) => mockNative.cleanupSessionTerminals(...(a as [])),
}))
const mockSupportsTerminal = jest.fn(() => true)
jest.mock("../agent-transport", () => ({
  supportsAgentTerminal: () => mockSupportsTerminal(),
}))

import { createNativeTerminalHost } from "./terminal-host"

describe("createNativeTerminalHost", () => {
  it("reads availability from the transport on every access", () => {
    const host = createNativeTerminalHost()
    expect(host.available).toBe(true)
    mockSupportsTerminal.mockReturnValueOnce(false)
    expect(host.available).toBe(false)
  })

  it("maps the typed port onto the native terminal commands", async () => {
    const host = createNativeTerminalHost()
    await expect(
      host.create({ sessionId: "s", command: "ls", cwd: "/w", env: { A: "1" }, outputByteLimit: 9 })
    ).resolves.toBe("t1")
    expect(mockNative.acpTerminalCreate).toHaveBeenCalledWith("s", "ls", [], "/w", { A: "1" }, 9)
    await host.output("t1", 5)
    await host.write("t1", "x")
    await host.kill("t1")
    await host.release("t1")
    await host.waitForExit("t1", 100)
    await host.closeSession("s")
    expect(mockNative.acpTerminalOutput).toHaveBeenCalledWith("t1", 5)
    expect(mockNative.acpTerminalWrite).toHaveBeenCalledWith("t1", "x")
    expect(mockNative.acpTerminalKill).toHaveBeenCalledWith("t1")
    expect(mockNative.acpTerminalRelease).toHaveBeenCalledWith("t1")
    expect(mockNative.acpTerminalWaitForExit).toHaveBeenCalledWith("t1", 100)
    expect(mockNative.cleanupSessionTerminals).toHaveBeenCalledWith("s")
  })
})
