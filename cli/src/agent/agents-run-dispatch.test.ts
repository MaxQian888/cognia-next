/**
 * @jest-environment node
 */
import { buildAgentsRunDispatch } from "./agents-run-dispatch"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import { runCliSubagent } from "./subagent-runner"
import { loadMcpServers } from "../mcp/load-mcp-config"
import { applyDisabled, readDisabled, readDisabledTools } from "../mcp/mcp-state"
import { readToolApprovals } from "./tool-approvals"

jest.mock("./subagent-runner", () => ({ runCliSubagent: jest.fn() }))
jest.mock("../mcp/load-mcp-config", () => ({ loadMcpServers: jest.fn(() => []) }))
jest.mock("../mcp/mcp-state", () => ({
  applyDisabled: jest.fn((servers) => servers),
  readDisabled: jest.fn(() => new Set()),
  readDisabledTools: jest.fn(() => new Set(["mcp__s__off"])),
}))
jest.mock("./tool-approvals", () => ({ readToolApprovals: jest.fn(() => new Set(["always"])) }))

const mockRun = runCliSubagent as jest.MockedFunction<typeof runCliSubagent>

function cfg(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
    cwd: "/work",
    ...overrides,
  }
}

const def: PluginSubagentDef = { id: "reviewer", name: "reviewer", description: "d", prompt: "p" }

beforeEach(() => jest.clearAllMocks())

describe("buildAgentsRunDispatch", () => {
  it("runs the subagent over the live sidecar with file-resolved deps + a config gate", async () => {
    mockRun.mockResolvedValue({
      text: "looks good",
      usage: { inputTokens: 8, outputTokens: 2 },
      finishReason: "success",
    })
    const dispatch = buildAgentsRunDispatch({
      config: cfg({ permissionMode: "bypassPermissions" }),
      home: "/home/.cognia",
      sessionId: "s1",
    })
    const out = await dispatch(def, "review the diff", {})

    expect(loadMcpServers).toHaveBeenCalledWith(["/work", "/home/.cognia"])
    expect(applyDisabled).toHaveBeenCalled()
    expect(readDisabled).toHaveBeenCalledWith("/home/.cognia")
    expect(readToolApprovals).toHaveBeenCalledWith("/home/.cognia")
    expect(readDisabledTools).toHaveBeenCalledWith("/home/.cognia")

    const [passedDef, prompt, parentId, deps] = mockRun.mock.calls[0]
    expect(passedDef).toBe(def)
    expect(prompt).toBe("review the diff")
    expect(parentId).toBe("s1")
    expect(deps.cwd).toBe("/work")
    expect(deps.disabledMcpTools).toEqual(new Set(["mcp__s__off"]))
    // bypass mode → the gate allows asked tools.
    await expect(deps.gate({ toolName: "bash" } as never)).resolves.toEqual({ decision: "allow" })

    // Usage is remapped to the controller's `{ totalTokens }` shape.
    expect(out).toEqual({ text: "looks good", usage: { totalTokens: 10 }, finishReason: "success" })
  })

  it("denies ask-tier tools when not in bypass mode, and honours the per-call cwd/signal", async () => {
    mockRun.mockResolvedValue({ text: "done" })
    const signal = new AbortController().signal
    const dispatch = buildAgentsRunDispatch({
      config: cfg({ permissionMode: "default" }),
      home: "/h",
      sessionId: "s2",
    })
    await dispatch(def, "go", { cwd: "/other", abortSignal: signal })

    const deps = mockRun.mock.calls[0][3]
    expect(deps.cwd).toBe("/other")
    expect(deps.signal).toBe(signal)
    const decision = await deps.gate({ toolName: "bash" } as never)
    expect(decision.decision).toBe("deny")
  })

  it("omits usage when the run reported no tokens", async () => {
    mockRun.mockResolvedValue({ text: "bare" })
    const dispatch = buildAgentsRunDispatch({ config: cfg(), home: "/h", sessionId: "s3" })
    const out = await dispatch(def, "go", {})
    expect(out).toEqual({ text: "bare" })
  })
})
