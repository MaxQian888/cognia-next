/**
 * @jest-environment jsdom
 */

jest.mock("@/lib/db/characters", () => ({
  listCharacters: jest.fn(),
}))
jest.mock("@/lib/db/twins", () => ({
  listTwins: jest.fn(),
}))
jest.mock("@/lib/db/skills", () => ({
  listSkills: jest.fn(),
}))
jest.mock("@/lib/db/adapter-instances", () => ({
  listAdapterInstances: jest.fn(),
}))
jest.mock("@/lib/db/mcp-servers", () => ({
  listMcpServers: jest.fn(),
}))
jest.mock("@/lib/db/plugins", () => ({
  listPlugins: jest.fn(),
}))

import { listCharacters } from "@/lib/db/characters"
import { listTwins } from "@/lib/db/twins"
import { listSkills } from "@/lib/db/skills"
import { listAdapterInstances } from "@/lib/db/adapter-instances"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listPlugins } from "@/lib/db/plugins"
import type { PluginTool, PluginToolContext } from "@/types/plugin"
import { buildResourceTools } from "./resource-tools"

const EMPTY_CTX: PluginToolContext = { config: {} }

const mList = {
  characters: listCharacters as jest.Mock,
  twins: listTwins as jest.Mock,
  skills: listSkills as jest.Mock,
  connectors: listAdapterInstances as jest.Mock,
  mcp: listMcpServers as jest.Mock,
  plugins: listPlugins as jest.Mock,
}

function findTool(tools: PluginTool[], name: string): PluginTool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`Tool not found: ${name}`)
  return t
}

beforeEach(() => {
  for (const m of Object.values(mList)) m.mockReset()
})

describe("resource tools — happy path", () => {
  it("wf_list_characters strips systemPrompt and exposes hasSkills", async () => {
    mList.characters.mockResolvedValueOnce([
      {
        id: "c1",
        name: "Atlas",
        description: "researcher",
        avatarColor: "#000",
        systemPrompt: "SECRET PROMPT",
        model: "claude-opus-4-7",
        skillIds: ["s1"],
        twinId: "t1",
      },
      {
        id: "c2",
        name: "Bee",
        avatarColor: "#fff",
        systemPrompt: "DO NOT LEAK",
        skillIds: [],
      },
    ])
    const tool = findTool(buildResourceTools(), "wf_list_characters")
    const result = (await tool.execute({}, EMPTY_CTX)) as {
      ok: true
      characters: Array<{ id: string; name: string; hasSkills: boolean }>
    }
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain("SECRET")
    expect(JSON.stringify(result)).not.toContain("DO NOT LEAK")
    expect(result.characters).toEqual([
      expect.objectContaining({
        id: "c1",
        name: "Atlas",
        model: "claude-opus-4-7",
        hasSkills: true,
        twinId: "t1",
      }),
      expect.objectContaining({ id: "c2", name: "Bee", hasSkills: false }),
    ])
  })

  it("wf_list_twins filters archived by default and honours includeArchived", async () => {
    mList.twins.mockImplementation(async (opts?: { includeArchived?: boolean }) => {
      const all = [
        { id: "t1", name: "Active", createdAt: 0, updatedAt: 1 },
        { id: "t2", name: "Old", archived: true, createdAt: 0, updatedAt: 0 },
      ]
      return opts?.includeArchived ? all : all.filter((t) => !t.archived)
    })
    const tool = findTool(buildResourceTools(), "wf_list_twins")
    const withoutArchived = (await tool.execute({}, EMPTY_CTX)) as {
      ok: true
      twins: Array<{ id: string }>
    }
    expect(withoutArchived.twins.map((t) => t.id)).toEqual(["t1"])
    const withArchived = (await tool.execute({ includeArchived: true }, EMPTY_CTX)) as {
      ok: true
      twins: Array<{ id: string }>
    }
    expect(withArchived.twins.map((t) => t.id)).toEqual(["t1", "t2"])
  })

  it("wf_list_skills exposes id/name/description/tags but not body content", async () => {
    mList.skills.mockResolvedValueOnce([
      {
        id: "s1",
        name: "PR Review",
        description: "review pull requests",
        content: "MARKDOWN BODY",
        tags: ["github"],
      },
    ])
    const tool = findTool(buildResourceTools(), "wf_list_skills")
    const result = (await tool.execute({}, EMPTY_CTX)) as {
      ok: true
      skills: Array<{ id: string; name: string; tags: string[] }>
    }
    expect(result.skills[0]).toMatchObject({ id: "s1", name: "PR Review", tags: ["github"] })
    expect(JSON.stringify(result)).not.toContain("MARKDOWN BODY")
  })

  it("wf_list_connectors strips credentialsRef and settings", async () => {
    mList.connectors.mockResolvedValueOnce([
      {
        id: "cn1",
        type: "telegram",
        displayName: "Main bot",
        enabled: true,
        transportMode: "longpoll",
        settings: { botToken: "SECRET", custom: "x" },
        credentialsRef: { keyringService: "cognia", accounts: ["botToken"] },
      },
    ])
    const tool = findTool(buildResourceTools(), "wf_list_connectors")
    const result = (await tool.execute({}, EMPTY_CTX)) as {
      ok: true
      connectors: Array<{ id: string; type: string }>
    }
    expect(result.connectors).toEqual([
      {
        id: "cn1",
        type: "telegram",
        displayName: "Main bot",
        enabled: true,
        transportMode: "longpoll",
      },
    ])
    expect(JSON.stringify(result)).not.toContain("SECRET")
    expect(JSON.stringify(result)).not.toContain("keyringService")
  })

  it("wf_list_mcp_servers does not expose config", async () => {
    mList.mcp.mockResolvedValueOnce([
      {
        id: "m1",
        name: "filesystem",
        transport: "stdio",
        enabled: true,
        config: { command: "node", args: ["--secret"] },
      },
    ])
    const tool = findTool(buildResourceTools(), "wf_list_mcp_servers")
    const result = (await tool.execute({}, EMPTY_CTX)) as {
      ok: true
      mcpServers: Array<{ id: string }>
    }
    expect(result.mcpServers[0]).toEqual({
      id: "m1",
      name: "filesystem",
      transport: "stdio",
      enabled: true,
    })
    expect(JSON.stringify(result)).not.toContain("--secret")
  })

  it("wf_list_plugins surfaces capabilities and enabled state", async () => {
    mList.plugins.mockResolvedValueOnce([
      {
        id: "p1",
        name: "GitHub Delivery",
        version: "1.0.0",
        status: "enabled",
        source: "builtin",
        type: "frontend",
        enabled: true,
        capabilities: ["tools", "skills"],
        path: "/builtin/p1",
        manifest: { id: "p1" },
        createdAt: 0,
        updatedAt: 0,
      },
    ])
    const tool = findTool(buildResourceTools(), "wf_list_plugins")
    const result = (await tool.execute({}, EMPTY_CTX)) as {
      ok: true
      plugins: Array<{ id: string; capabilities: string[] }>
    }
    expect(result.plugins[0]).toMatchObject({
      id: "p1",
      capabilities: ["tools", "skills"],
      enabled: true,
    })
    expect(JSON.stringify(result)).not.toContain("manifest")
  })
})

describe("resource tools — empty + error", () => {
  it("returns empty arrays without throwing", async () => {
    mList.characters.mockResolvedValueOnce([])
    const tool = findTool(buildResourceTools(), "wf_list_characters")
    const result = (await tool.execute({}, EMPTY_CTX)) as { ok: true; characters: unknown[] }
    expect(result).toEqual({ ok: true, characters: [] })
  })

  it("formats thrown DB errors as ok:false payloads", async () => {
    mList.skills.mockRejectedValueOnce(new Error("db offline"))
    const tool = findTool(buildResourceTools(), "wf_list_skills")
    const result = (await tool.execute({}, EMPTY_CTX)) as {
      ok: false
      error: { code: string; message: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe("tool-execution-failed")
    expect(result.error.message).toContain("db offline")
  })
})
