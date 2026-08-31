jest.mock("@/lib/sandbox/microvm-bridge", () => ({
  getMicrovmExec: jest.fn(),
  setMicrovmExec: jest.fn(),
}))

jest.mock("@/lib/sandbox/session-runtime", () => ({
  HOST_FALLBACK_RUNTIME_REF: "sandbox-runtime:host-default",
  sandboxSessionRuntime: {
    activeRefForSession: jest.fn(() => "sandbox-runtime:session"),
    decorateComputerUseContext: jest.fn(async (_ref: string, base: object) => ({ ...base })),
    executeSandbox: jest.fn(async () => ({ exit_code: 0 })),
    clampRequest: jest.fn((_ref: string, request: object) => request),
    assertWritablePath: jest.fn(),
  },
}))

import { getMicrovmExec, setMicrovmExec } from "@/lib/sandbox/microvm-bridge"
import { sandboxSessionRuntime } from "@/lib/sandbox/session-runtime"
import type { MicrovmExecAdapter, MicrovmExecPayload } from "@cognia/plugin-sdk/api/sandbox"

import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security/permission-guard"

import { createSandboxAPI } from "./sandbox-api"

const adapter = { execute: jest.fn() } as unknown as MicrovmExecAdapter
const PLUGIN_ID = "test-plugin"

describe("createSandboxAPI", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetPermissionGuard()
    getPermissionGuard().registerPlugin(PLUGIN_ID, [
      "native:process",
      "native:filesystem",
      "native:input",
      "session:read",
    ])
  })

  it("registers and disposes only the adapter it owns", () => {
    const api = createSandboxAPI(PLUGIN_ID)
    const dispose = api.registerMicrovmAdapter(adapter)

    expect(setMicrovmExec).toHaveBeenCalledWith(adapter)
    ;(getMicrovmExec as jest.Mock).mockReturnValue(adapter)
    dispose()
    expect(setMicrovmExec).toHaveBeenLastCalledWith(null)

    ;(setMicrovmExec as jest.Mock).mockClear()
    ;(getMicrovmExec as jest.Mock).mockReturnValue({ execute: jest.fn() })
    dispose()
    expect(setMicrovmExec).not.toHaveBeenCalled()
  })

  it("delegates runtime operations through the host singleton", async () => {
    const api = createSandboxAPI(PLUGIN_ID)
    const request = {
      writable: [],
      readable: [],
      targetFiles: [],
      maxCpuSeconds: 1,
      maxMemoryMb: 32,
      network: "off" as const,
      networkHosts: [],
    }
    const payload = { tool: "bash", command: {}, request } as unknown as MicrovmExecPayload

    expect(api.hostFallbackRuntimeRef).toBe("sandbox-runtime:host-default")
    expect(api.activeRefForSession("session-1")).toBe("sandbox-runtime:session")
    await api.decorateComputerUseContext("runtime-1", { surface: "computerUse" })
    await api.execute("runtime-1", payload)
    expect(api.clampRequest("runtime-1", request)).toBe(request)
    api.assertWritablePath("runtime-1", "/workspace/file", "file")

    expect(sandboxSessionRuntime.executeSandbox).toHaveBeenCalledWith("runtime-1", payload)
    expect(sandboxSessionRuntime.assertWritablePath).toHaveBeenCalledWith(
      "runtime-1",
      "/workspace/file",
      "file"
    )
  })
})
