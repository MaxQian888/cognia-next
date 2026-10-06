import type { AgentProcessHost } from "@cognia/agent-contracts/host"
import { OPENCODE_V2_EXECUTION_SEMANTICS } from "@cognia/agent-opencode/manifest"
import { openCodeServerExtension } from "@cognia/agent-opencode/client"
import { OpenCodeV2ClientAdapter, openCodeV2Extension } from "@cognia/agent-opencode/v2-client"

const mockSidecarDiscover = jest.fn()
jest.mock("@/lib/claude/feature-call", () => ({
  discoverOpenCodeV2ViaSidecar: (...args: unknown[]) => mockSidecarDiscover(...args),
}))
const mockIsCliHost = jest.fn(() => false)
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isCliHost: () => mockIsCliHost(),
}))
const mockInProcess = jest.fn()
jest.mock("@cognia/agent-opencode/discovery", () => ({
  ...jest.requireActual("@cognia/agent-opencode/discovery"),
  discoverOpenCodeV2InProcess: (...args: unknown[]) => mockInProcess(...args),
}))

import {
  __resetSpawnPlacementsForTests,
  registerSpawnPlacement,
} from "@/lib/sandbox/spawn-placement-registry"
import type { SandboxPlacement } from "@/types/sandbox/environment-spec"
import {
  appOpenCodeV2Placement,
  canProjectOpenCodeV2McpOnThisHost,
  createOpenCodeV2Adapter,
  createOpenCodeV2AdapterFactory,
  discoverOpenCodeV2Service,
} from "./opencode"

const processHost: AgentProcessHost = {
  available: false,
  spawn: jest.fn(),
  send: jest.fn(),
  kill: jest.fn(),
  commandExists: jest.fn(),
  onStdoutLine: jest.fn(),
  onStdoutRaw: jest.fn(),
  onStderr: jest.fn(),
  onExit: jest.fn(),
}

describe("OpenCode host wiring", () => {
  afterEach(() => {
    __resetSpawnPlacementsForTests()
    jest.clearAllMocks()
  })

  it("builds the opencode-v2 adapter with turn-scoped cancel semantics", () => {
    const adapter = createOpenCodeV2AdapterFactory(processHost)()
    expect(adapter).toBeInstanceOf(OpenCodeV2ClientAdapter)
    expect(adapter.protocol).toBe("opencode-v2")
    expect(adapter.semantics).toBe(OPENCODE_V2_EXECUTION_SEMANTICS)
  })

  it("reads sandbox placement from the app's registry", () => {
    const config = { id: "oc", protocol: "opencode-v2", process: { command: "opencode" } } as never
    expect(appOpenCodeV2Placement.hasSelectedSandbox("oc")).toBe(false)
    registerSpawnPlacement("oc", { kind: "container" } as SandboxPlacement)
    expect(appOpenCodeV2Placement.hasSelectedSandbox("oc")).toBe(true)
    expect(canProjectOpenCodeV2McpOnThisHost(config)).toBe(false)
  })

  it("discovers through the sidecar on the desktop and in-process on the CLI", async () => {
    const signal = new AbortController().signal
    mockSidecarDiscover.mockResolvedValueOnce({
      endpoint: "http://a",
      version: "2.0.0",
      headers: {},
    })
    await discoverOpenCodeV2Service(signal)
    expect(mockSidecarDiscover).toHaveBeenCalledWith(signal)
    expect(mockInProcess).not.toHaveBeenCalled()
    mockIsCliHost.mockReturnValueOnce(true)
    mockInProcess.mockResolvedValueOnce({ endpoint: "http://b", version: "2.0.0", headers: {} })
    await discoverOpenCodeV2Service(signal)
    expect(mockInProcess).toHaveBeenCalledWith(expect.any(Function), signal)
  })

  it("answers the V2 service extension and not the legacy server one", () => {
    const adapter = createOpenCodeV2AdapterFactory(processHost)()
    expect(openCodeV2Extension.resolve(adapter)).toBe(adapter)
    expect(openCodeServerExtension.resolve(adapter)).toBeUndefined()
    expect(openCodeV2Extension.resolve({ protocol: "opencode-v2" } as never)).toBeUndefined()
  })

  it("creates an independent adapter per configuration", () => {
    expect(createOpenCodeV2Adapter(processHost)).not.toBe(createOpenCodeV2Adapter(processHost))
  })
})
