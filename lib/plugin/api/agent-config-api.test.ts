/** @jest-environment jsdom */

import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"
import {
  AGENT_CONFIG_SUMMARY_MAX,
  AgentConfigConsentDeniedError,
  createAgentConfigAPI,
  type AgentConfigAPIDeps,
} from "./agent-config-api"

const mockList = jest.fn()
const mockRead = jest.fn()
jest.mock("@/lib/agent-config/surfaces", () => ({
  listAgentConfigSurfaces: (...args: unknown[]) => mockList(...args),
  readAgentConfigSurface: (...args: unknown[]) => mockRead(...args),
}))
const mockFacts = jest.fn()
jest.mock("@/lib/agent-config/facts", () => ({
  readAgentConfigFacts: (...args: unknown[]) => mockFacts(...args),
}))
const mockRefs = jest.fn()
jest.mock("@/lib/agent-config/references", () => ({
  checkAgentConfigReferences: (...args: unknown[]) => mockRefs(...args),
}))
const mockProvenance = jest.fn()
jest.mock("@/lib/agent-config/provenance", () => ({
  readAgentConfigProvenance: (...args: unknown[]) => mockProvenance(...args),
}))
const mockApply = jest.fn()
jest.mock("@/lib/agent-config/apply", () => ({
  applyAgentConfigEdit: (...args: unknown[]) => mockApply(...args),
}))

const PLUGIN = "governance-test"

function apiWith(permissions: string[], deps: AgentConfigAPIDeps = {}) {
  getPermissionGuard().registerPlugin(PLUGIN, permissions as never)
  return createAgentConfigAPI(PLUGIN, deps)
}

/** The guard refuses synchronously; fold that into the promise the caller awaits. */
function attempt<T>(call: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(call)
}

beforeEach(() => {
  jest.clearAllMocks()
  resetPermissionGuard()
})

describe("ctx.agentConfig reads", () => {
  it("passes the workspace scope through and maps a missing surface to null", async () => {
    mockList.mockResolvedValue({ workspaceId: "ws", surfaces: [], failed: [] })
    mockRead.mockResolvedValue(undefined)
    mockFacts.mockResolvedValue({ hooks: [] })
    mockRefs.mockResolvedValue({ paths: [], scripts: [] })
    mockProvenance.mockResolvedValue(null)
    const api = apiWith(["agent-config:read"])
    await api.listSurfaces({ workspaceId: "ws" })
    expect(mockList).toHaveBeenCalledWith("ws")
    expect(await api.readSurface("skill:s1", { workspaceId: null })).toBeNull()
    expect(mockRead).toHaveBeenCalledWith("skill:s1", null)
    await api.readFacts()
    expect(mockFacts).toHaveBeenCalledWith(undefined)
    await api.checkReferences({ paths: ["a"] })
    expect(mockRefs).toHaveBeenCalledWith({ paths: ["a"] })
    expect(await api.readProvenance("instruction-file:x|y")).toBeNull()
  })

  it("refuses every read without agent-config:read", async () => {
    const api = apiWith([])
    await expect(attempt(() => api.listSurfaces())).rejects.toBeInstanceOf(PermissionError)
    await expect(attempt(() => api.readFacts())).rejects.toBeInstanceOf(PermissionError)
    expect(mockList).not.toHaveBeenCalled()
  })

  it("rejects malformed keys before reaching the host", async () => {
    const api = apiWith(["agent-config:read"])
    await expect(api.readSurface("nokey")).rejects.toThrow("surface key")
    expect(mockRead).not.toHaveBeenCalled()
  })

  it("redacts for a model without a permission and keeps line count", () => {
    const api = apiWith([])
    const out = api.redactForModel("a\nmail me@example.com\nc")
    expect(out?.split("\n")).toHaveLength(3)
    expect(out).not.toContain("me@example.com")
  })
})

describe("ctx.agentConfig.applyEdit", () => {
  const edit = { key: "skill:s1", text: "new", version: "v1", summary: "  Remove a dated rule  " }

  it("asks the user per surface, then writes through the owner", async () => {
    const requestConsent = jest.fn(async () => true)
    mockApply.mockResolvedValue({ key: "skill:s1", version: "v2" })
    const api = apiWith(["agent-config:read", "agent-config:write"], { requestConsent })
    expect(await api.applyEdit(edit)).toEqual({ key: "skill:s1", version: "v2" })
    expect(requestConsent).toHaveBeenCalledWith({
      pluginId: PLUGIN,
      key: "skill:s1",
      reason: "Remove a dated rule\nskill:s1",
    })
    expect(mockApply).toHaveBeenCalledWith({ ...edit, summary: "Remove a dated rule" })
  })

  it("writes nothing when the user declines", async () => {
    const api = apiWith(["agent-config:read", "agent-config:write"], {
      requestConsent: async () => false,
    })
    await expect(api.applyEdit(edit)).rejects.toBeInstanceOf(AgentConfigConsentDeniedError)
    expect(mockApply).not.toHaveBeenCalled()
  })

  it("needs the write permission and a summary, and clips long summaries", async () => {
    const requestConsent = jest.fn(async () => true)
    const readOnly = apiWith(["agent-config:read"], { requestConsent })
    await expect(attempt(() => readOnly.applyEdit(edit))).rejects.toBeInstanceOf(PermissionError)
    expect(requestConsent).not.toHaveBeenCalled()

    const api = apiWith(["agent-config:read", "agent-config:write"], { requestConsent })
    await expect(api.applyEdit({ ...edit, summary: "   " })).rejects.toThrow("summary")
    mockApply.mockResolvedValue({ key: "skill:s1" })
    await api.applyEdit({ ...edit, summary: "x".repeat(AGENT_CONFIG_SUMMARY_MAX + 50) })
    expect(mockApply.mock.calls[0]?.[0].summary).toHaveLength(AGENT_CONFIG_SUMMARY_MAX)
  })
})
