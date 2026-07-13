/** @jest-environment jsdom */
/**
 * Coverage for the project-instruction-file + markdown-subagent wiring in
 * `resolveSendOptions`. The on-disk loader is mocked — the pure loader itself
 * is covered by `lib/claude/instructions/*.test.ts`.
 */

import "fake-indexeddb/auto"

const loadProjectInstructions = jest.fn()
jest.mock("@/lib/claude/instructions/load", () => ({
  loadProjectInstructions: (...args: unknown[]) => loadProjectInstructions(...args),
}))

import { resolveSendOptions } from "./build-options"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { Character, ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  loadProjectInstructions.mockReset()
  loadProjectInstructions.mockResolvedValue({
    section: "",
    files: [],
    markdownAgentFiles: [],
    warnings: [],
  })
})

const baseCharacter: Character = {
  id: "char_1",
  name: "Alice",
  avatarColor: "oklch(0.7 0.15 240)",
  systemPrompt: "BASE_SYSTEM_PROMPT",
  createdAt: 1,
  updatedAt: 1,
}

const project = {
  id: "proj_1",
  name: "Demo",
  roots: [{ id: "r1", path: "/proj", isPrimary: true }],
} as unknown as Project

describe("resolveSendOptions — project instructions", () => {
  it("injects the discovered instruction section into the system prompt", async () => {
    loadProjectInstructions.mockResolvedValue({
      section: "PROJECT_INSTRUCTIONS_BLOCK",
      files: [],
      markdownAgentFiles: [],
      warnings: [],
    })
    const opts = await resolveSendOptions({ character: baseCharacter, activeProject: project })
    expect(opts.systemPrompt).toContain("BASE_SYSTEM_PROMPT")
    expect(opts.systemPrompt).toContain("PROJECT_INSTRUCTIONS_BLOCK")
    // loader keyed off the workspace roots
    expect(loadProjectInstructions).toHaveBeenCalledWith(
      expect.objectContaining({ roots: ["/proj"] })
    )
  })

  it("merges .cognia/agents markdown subagents into opts.agents (project wins)", async () => {
    loadProjectInstructions.mockResolvedValue({
      section: "",
      files: [],
      markdownAgentFiles: [
        { id: "reviewer", content: `---\ndescription: reviews code\n---\nbody` },
      ],
      warnings: [],
    })
    const opts = await resolveSendOptions({ character: baseCharacter, activeProject: project })
    expect(opts.agents?.reviewer).toMatchObject({ description: "reviews code" })
  })

  it("skips discovery in bare mode", async () => {
    const session = { id: "s1", bareMode: true } as unknown as ChatSession
    await resolveSendOptions({ character: baseCharacter, activeProject: project, session })
    expect(loadProjectInstructions).not.toHaveBeenCalled()
  })

  it("skips discovery for workflow-editor sessions", async () => {
    const session = { id: "workflow:1", kind: "workflow-editor" } as unknown as ChatSession
    await resolveSendOptions({ character: baseCharacter, activeProject: project, session })
    expect(loadProjectInstructions).not.toHaveBeenCalled()
  })

  it("passes empty roots when there is no active project", async () => {
    await resolveSendOptions({ character: baseCharacter })
    expect(loadProjectInstructions).toHaveBeenCalledWith(expect.objectContaining({ roots: [] }))
  })

  it("degrades cleanly when the loader throws", async () => {
    loadProjectInstructions.mockRejectedValue(new Error("fs blew up"))
    const opts = await resolveSendOptions({ character: baseCharacter, activeProject: project })
    expect(opts.systemPrompt).toBe("BASE_SYSTEM_PROMPT")
  })
})
