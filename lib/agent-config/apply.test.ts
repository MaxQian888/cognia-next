/** @jest-environment jsdom */

import { useProjectStore } from "@/stores/project/project-store"
import { AgentConfigEditError, applyAgentConfigEdit } from "./apply"
import { agentFileKey } from "./surfaces"

const mockWriteChecked = jest.fn()
jest.mock("@/lib/files/workspace-fs", () => ({
  writeWorkspaceFileChecked: (...args: unknown[]) => mockWriteChecked(...args),
}))

const mockClearCache = jest.fn()
jest.mock("@/lib/claude/instructions/load", () => ({
  clearInstructionCache: () => mockClearCache(),
}))

const mockPublish = jest.fn()
jest.mock("@/lib/prompts/service", () => ({
  publishPromptBody: (...args: unknown[]) => mockPublish(...args),
}))

const DEF = { id: "chat.title", scopes: ["account", "workspace"] }
jest.mock("@/lib/prompts/catalog", () => ({
  getPromptDefinition: (id: string) => (id === "chat.title" ? DEF : undefined),
}))

const adapters: Record<string, Record<string, jest.Mock | undefined>> = {}
jest.mock("@/lib/prompts/adapters", () => ({
  ownerAdapterFor: (key: string) => adapters[key.slice(0, key.indexOf(":"))],
}))

beforeEach(() => {
  jest.clearAllMocks()
  for (const key of Object.keys(adapters)) delete adapters[key]
  useProjectStore.setState({
    activeProjectId: "ws-1",
    projects: [{ id: "ws-1", name: "Repo", roots: [{ id: "r", path: "/repo", isPrimary: true }] }],
  } as never)
})

describe("applyAgentConfigEdit", () => {
  it("writes an agent file against the hash it was read at and drops the instruction cache", async () => {
    mockWriteChecked.mockResolvedValue({ sha256: "new", size: 1, mtimeMs: null })
    const key = agentFileKey({ dir: "/repo/.cognia/agents", name: "r.md" })
    expect(await applyAgentConfigEdit({ key, text: "body", version: "old", summary: "s" })).toEqual(
      {
        key,
        version: "new",
      }
    )
    expect(mockWriteChecked).toHaveBeenCalledWith("/repo/.cognia/agents", "r.md", "body", {
      expectedSha256: "old",
    })
    expect(mockClearCache).toHaveBeenCalled()
    await expect(applyAgentConfigEdit({ key, text: "b", summary: "s" })).rejects.toMatchObject({
      code: "agent_config_version_required",
    })
  })

  it("publishes a code slot at the scope and revision the read saw, as a plugin revision", async () => {
    mockPublish.mockResolvedValue({ rev: 3 })
    const result = await applyAgentConfigEdit({
      key: "code:chat.title",
      text: "Shorter",
      version: "workspace:ws-1:2",
      summary: "s",
    })
    expect(mockPublish).toHaveBeenCalledWith({
      def: DEF,
      target: { scope: "workspace", targetId: "ws-1" },
      body: "Shorter",
      expectedRev: 2,
      origin: "plugin",
    })
    expect(result).toEqual({ key: "code:chat.title", version: "workspace:ws-1:3" })
    await expect(
      applyAgentConfigEdit({ key: "code:gone", text: "x", version: "account::0", summary: "s" })
    ).rejects.toMatchObject({ code: "agent_config_not_found" })
  })

  it("saves an owner in place against its version", async () => {
    const save = jest.fn(async () => ({ key: "skill:s1", text: "new", version: "v2" }))
    adapters.skill = {
      read: jest.fn(async () => ({ key: "skill:s1", text: "old", version: "v1" })),
      save,
    }
    expect(
      await applyAgentConfigEdit({ key: "skill:s1", text: "new", version: "v1", summary: "s" })
    ).toEqual({ key: "skill:s1", version: "v2" })
    expect(save).toHaveBeenCalledWith(
      "skill:s1",
      "new",
      "v1",
      expect.objectContaining({ workspace: expect.anything() })
    )
  })

  it("refuses a stale version instead of overwriting", async () => {
    const save = jest.fn()
    adapters.skill = {
      read: jest.fn(async () => ({ key: "skill:s1", text: "x", version: "v9" })),
      save,
    }
    await expect(
      applyAgentConfigEdit({ key: "skill:s1", text: "new", version: "v1", summary: "s" })
    ).rejects.toBeInstanceOf(AgentConfigEditError)
    expect(save).not.toHaveBeenCalled()
  })

  it("creates the owner's custom copy for a built-in", async () => {
    const saveCustom = jest.fn(async () => "character:copy-1")
    adapters.character = {
      read: jest.fn(async () => ({ key: "character:b", text: "x", readOnlyReason: "built-in" })),
      saveCustom,
      save: jest.fn(),
    }
    expect(await applyAgentConfigEdit({ key: "character:b", text: "y", summary: "s" })).toEqual({
      key: "character:copy-1",
    })
    expect(adapters.character.save).not.toHaveBeenCalled()
  })

  it("refuses owners that are only edited on their own screen", async () => {
    adapters["composer-template"] = {
      read: jest.fn(async () => ({ key: "composer-template:t", text: "x" })),
    }
    await expect(
      applyAgentConfigEdit({ key: "composer-template:t", text: "y", summary: "s" })
    ).rejects.toMatchObject({ code: "agent_config_not_editable" })
    adapters.skill = {
      read: jest.fn(async () => ({ key: "skill:b", text: "x", readOnlyReason: "plugin" })),
    }
    await expect(
      applyAgentConfigEdit({ key: "skill:b", text: "y", summary: "s" })
    ).rejects.toMatchObject({
      code: "agent_config_not_editable",
    })
    await expect(
      applyAgentConfigEdit({ key: "nobody:x", text: "y", summary: "s" })
    ).rejects.toMatchObject({
      code: "agent_config_not_found",
    })
  })
})
