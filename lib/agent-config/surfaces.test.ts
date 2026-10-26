/** @jest-environment jsdom */

import { instructionFileKey } from "@/lib/prompts/adapters/instruction-files"
import { useProjectStore } from "@/stores/project/project-store"
import {
  agentFileKey,
  codeSlotTarget,
  codeSlotVersion,
  listAgentConfigSurfaces,
  parseAgentFileKey,
  parseCodeSlotVersion,
  readAgentConfigSurface,
} from "./surfaces"

const mockReadVersioned = jest.fn()
jest.mock("@/lib/files/workspace-fs", () => ({
  readWorkspaceFileVersioned: (...args: unknown[]) => mockReadVersioned(...args),
}))

const mockReadPromptSlot = jest.fn()
jest.mock("@/lib/prompts/service", () => ({
  readPromptSlot: (...args: unknown[]) => mockReadPromptSlot(...args),
}))

const mockGetDefinition = jest.fn()
jest.mock("@/lib/prompts/catalog", () => ({
  getPromptDefinition: (id: string) => mockGetDefinition(id),
}))

const mockAdapterRead = jest.fn()
jest.mock("@/lib/prompts/adapters", () => ({
  listPromptResources: jest.fn(),
  ownerAdapterFor: (key: string) =>
    key.startsWith("skill:") || key.startsWith("instruction-file:") || key.startsWith("character:")
      ? { read: (...args: unknown[]) => mockAdapterRead(...args) }
      : undefined,
}))

const mockGetSkill = jest.fn()
jest.mock("@/lib/db/skills", () => ({ getSkill: (id: string) => mockGetSkill(id) }))

const ROOT_KEY = instructionFileKey({ root: "/repo", name: "CLAUDE.md" })
const GLOBAL_KEY = instructionFileKey({ root: "/home/.cognia", name: "AGENTS.md" })
const NEW_KEY = instructionFileKey({ root: "/repo", name: "AGENTS.md" })

beforeEach(() => {
  jest.clearAllMocks()
  useProjectStore.setState({
    activeProjectId: "ws-1",
    projects: [{ id: "ws-1", name: "Repo", roots: [{ id: "r", path: "/repo", isPrimary: true }] }],
  } as never)
})

describe("agent file keys", () => {
  it("round-trips a directory and a name with separators", () => {
    const ref = { dir: "C:\\work|x\\.cognia\\agents", name: "re:view.md" }
    expect(parseAgentFileKey(agentFileKey(ref))).toEqual(ref)
    expect(() => parseAgentFileKey("skill:x")).toThrow("not an agent file key")
  })
})

describe("code slot versions", () => {
  it("round-trips the slot and its revision", () => {
    const target = { scope: "workspace" as const, targetId: "ws:1" }
    expect(parseCodeSlotVersion(codeSlotVersion(target, 4))).toEqual({ target, rev: 4 })
    expect(() => parseCodeSlotVersion("agent:x:1")).toThrow("not a code slot version")
  })

  it("lands in the workspace only when the slot allows it", () => {
    const workspace = { id: "ws-1", roots: ["/repo"], promptContext: {} }
    expect(codeSlotTarget(["account", "workspace"], workspace)).toEqual({
      scope: "workspace",
      targetId: "ws-1",
    })
    expect(codeSlotTarget(["account"], workspace)).toEqual({ scope: "account", targetId: "" })
    expect(codeSlotTarget(["workspace"], { ...workspace, id: null })).toEqual({
      scope: "account",
      targetId: "",
    })
  })
})

describe("listAgentConfigSurfaces", () => {
  it("adds load order and layer to instruction files, skips the creation placeholder, appends agent files", async () => {
    const listResources = jest.fn(async () => ({
      resources: [
        {
          key: GLOBAL_KEY,
          source: "instruction-file" as const,
          kind: "project-rule" as const,
          operation: "append-rules" as const,
          name: "~/.cognia/AGENTS.md",
          builtIn: false,
          modified: true,
          edit: "source" as const,
          detail: "global",
        },
        {
          key: ROOT_KEY,
          source: "instruction-file" as const,
          kind: "project-rule" as const,
          operation: "append-rules" as const,
          name: "CLAUDE.md",
          builtIn: false,
          modified: true,
          edit: "source" as const,
          detail: "project",
        },
        {
          key: NEW_KEY,
          source: "instruction-file" as const,
          kind: "project-rule" as const,
          operation: "append-rules" as const,
          name: "AGENTS.md",
          builtIn: false,
          modified: false,
          edit: "source" as const,
        },
        {
          key: "skill:s1",
          source: "skill" as const,
          kind: "procedure" as const,
          operation: "activate-procedure" as const,
          name: "Review",
          builtIn: false,
          modified: false,
          edit: "source" as const,
          detail: "Review diffs",
        },
      ],
      failed: ["preset" as const],
    }))
    const discoverAgentFiles = jest.fn(async () => [
      {
        id: "reviewer",
        dir: "/repo/.cognia/agents",
        name: "reviewer.md",
        absPath: "/repo/.cognia/agents/reviewer.md",
      },
    ])
    const listing = await listAgentConfigSurfaces(undefined, { listResources, discoverAgentFiles })
    expect(listing.workspaceId).toBe("ws-1")
    expect(listing.failed).toEqual(["preset"])
    expect(
      listing.surfaces.map((surface) => [surface.key, surface.loadOrder, surface.layer])
    ).toEqual([
      [GLOBAL_KEY, 0, "global"],
      [ROOT_KEY, 1, "project"],
      ["skill:s1", undefined, undefined],
      [agentFileKey({ dir: "/repo/.cognia/agents", name: "reviewer.md" }), 0, "agent-dir"],
    ])
    expect(listing.surfaces[1]).toMatchObject({ path: "/repo/CLAUDE.md", name: "CLAUDE.md" })
    expect(listing.surfaces[3]).toMatchObject({
      source: "agent-file",
      kind: "agent-definition",
      name: "reviewer",
      edit: "source",
      path: "/repo/.cognia/agents/reviewer.md",
    })
    expect(discoverAgentFiles).toHaveBeenCalledWith(expect.objectContaining({ roots: ["/repo"] }))
  })

  it("reports agent files as failed instead of dropping them silently", async () => {
    const listing = await listAgentConfigSurfaces(undefined, {
      listResources: async () => ({ resources: [], failed: [] }),
      discoverAgentFiles: async () => {
        throw new Error("fs down")
      },
    })
    expect(listing.failed).toEqual(["agent-file"])
  })

  it("does not look for agent files without a workspace", async () => {
    const discoverAgentFiles = jest.fn()
    const listing = await listAgentConfigSurfaces(null, {
      listResources: async () => ({ resources: [], failed: [] }),
      discoverAgentFiles,
    })
    expect(listing.workspaceId).toBeNull()
    expect(discoverAgentFiles).not.toHaveBeenCalled()
  })
})

describe("readAgentConfigSurface", () => {
  it("reads an agent file with its hash as the version", async () => {
    mockReadVersioned.mockResolvedValue({ content: "---\nname: r\n---\nbody", sha256: "abc" })
    const key = agentFileKey({ dir: "/repo/.cognia/agents", name: "r.md" })
    expect(await readAgentConfigSurface(key, undefined)).toEqual({
      key,
      text: "---\nname: r\n---\nbody",
      version: "abc",
    })
    expect(mockReadVersioned).toHaveBeenCalledWith("/repo/.cognia/agents", "r.md")
  })

  it("reads a code slot at its workspace scope, inheriting the account override", async () => {
    mockGetDefinition.mockReturnValue({
      id: "chat.title",
      scopes: ["account", "workspace"],
      defaultBody: "Shipped",
      operation: "replace-template",
    })
    mockReadPromptSlot.mockImplementation(async (_id: string, target: { scope: string }) =>
      target.scope === "workspace"
        ? { binding: { rev: 2 } }
        : { binding: { rev: 1 }, active: { body: "Account text" } }
    )
    expect(await readAgentConfigSurface("code:chat.title", undefined)).toEqual({
      key: "code:chat.title",
      text: "Account text",
      version: "workspace:ws-1:2",
      baseText: "Shipped",
    })
  })

  it("returns the shipped body with no base when nothing overrides it", async () => {
    mockGetDefinition.mockReturnValue({
      id: "judge",
      scopes: ["account"],
      defaultBody: "Shipped",
      operation: "inspect-only",
    })
    mockReadPromptSlot.mockResolvedValue({})
    expect(await readAgentConfigSurface("code:judge", undefined)).toEqual({
      key: "code:judge",
      text: "Shipped",
      version: "account::0",
      readOnlyReason: "immutable",
    })
  })

  it("reads an owner resource and attaches a Skill's facts", async () => {
    mockAdapterRead.mockResolvedValue({ key: "skill:s1", text: "# Review" })
    mockGetSkill.mockResolvedValue({
      id: "s1",
      description: "Review diffs",
      status: "enabled",
      source: "imported",
      usageCount: 3,
      lastUsedAt: 50,
      allowedTools: ["Read"],
      validationErrors: [{ code: "name-format" }],
    })
    expect(await readAgentConfigSurface("skill:s1", undefined)).toEqual({
      key: "skill:s1",
      text: "# Review",
      skill: {
        description: "Review diffs",
        status: "enabled",
        origin: "imported",
        usageCount: 3,
        lastUsedAt: 50,
        allowedTools: ["Read"],
        validationErrorCount: 1,
      },
    })
  })

  it("treats an instruction file that does not exist yet as no surface", async () => {
    mockAdapterRead.mockResolvedValue({ key: NEW_KEY, text: "", version: "absent" })
    expect(await readAgentConfigSurface(NEW_KEY, undefined)).toBeUndefined()
  })

  it("returns undefined for an unknown owner", async () => {
    expect(await readAgentConfigSurface("nobody:x", undefined)).toBeUndefined()
  })
})
