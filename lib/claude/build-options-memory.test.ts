/**
 * Targeted coverage for the long-term-memory injection branch of
 * `resolveSendOptions`. Mirrors `build-options-twin.test.ts`.
 */

import { resolveSendOptions } from "./build-options"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { AppSettings, Character } from "@cognia/agent-config-types"
import type { Memory } from "@/types/memory/memory"
import type { ApplyMemoryContextDeps } from "@/lib/memory/runtime/apply-memory-context"
import { __resetMemoryBm25Cache } from "@/lib/memory/retrieve/retriever"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  __resetMemoryBm25Cache()
  await dbFixture.restore()
})

const baseCharacter: Character = {
  id: "char_1",
  name: "Alice",
  avatarColor: "oklch(0.7 0.15 240)",
  systemPrompt: "BASE_SYSTEM_PROMPT",
  createdAt: 1,
  updatedAt: 1,
}

function mem(text: string, over: Partial<Memory> = {}): Memory {
  const now = 1_700_000_000_000
  return {
    id: over.id ?? "m1",
    scope: "global",
    type: "semantic",
    text,
    tags: [],
    importance: 5,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

function deps(over: Partial<ApplyMemoryContextDeps> = {}): ApplyMemoryContextDeps {
  return { loadCandidates: async () => [], loadProcedural: async () => [], ...over }
}

afterAll(dbFixture.dispose)

describe("resolveSendOptions memory injection", () => {
  it("does not inject when memoryDeps is absent", async () => {
    const opts = await resolveSendOptions({ character: baseCharacter, memoryUserMessage: "pnpm" })
    expect(opts.systemPrompt).toBe("BASE_SYSTEM_PROMPT")
    expect(opts.memoryContext).toBeUndefined()
  })

  it("does not inject when memoryUserMessage is blank", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      memoryDeps: deps({ loadCandidates: async () => [mem("pnpm")] }),
      memoryUserMessage: "   ",
    })
    expect(opts.systemPrompt).toBe("BASE_SYSTEM_PROMPT")
  })

  it("does not inject when memory is disabled in settings", async () => {
    const appSettings = { memory: { enabled: false } } as unknown as AppSettings
    const opts = await resolveSendOptions({
      character: baseCharacter,
      appSettings,
      memoryDeps: deps({ loadCandidates: async () => [mem("pnpm fact")] }),
      memoryUserMessage: "pnpm",
    })
    expect(opts.systemPrompt).toBe("BASE_SYSTEM_PROMPT")
    expect(opts.memoryContext).toBeUndefined()
  })

  it("does not inject in temporary mode", async () => {
    const appSettings = { memory: { temporary: true } } as unknown as AppSettings
    const opts = await resolveSendOptions({
      character: baseCharacter,
      appSettings,
      memoryDeps: deps({ loadCandidates: async () => [mem("pnpm fact")] }),
      memoryUserMessage: "pnpm",
    })
    expect(opts.systemPrompt).toBe("BASE_SYSTEM_PROMPT")
  })

  it("honors per-chat recall disable independently from learning", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      session: { id: "s1", memoryUse: false, memoryLearn: true } as never,
      memoryDeps: deps({ loadCandidates: async () => [mem("pnpm fact")] }),
      memoryUserMessage: "pnpm",
    })
    expect(opts.systemPrompt).toBe("BASE_SYSTEM_PROMPT")
    expect(opts.memoryContext).toBeUndefined()
  })

  it("enforces Agent recall permission and readable scopes", async () => {
    const policyCharacter: Character = {
      ...baseCharacter,
      memoryPolicy: {
        operations: { recall: true, create: true, update: true, forget: true },
        readableScopes: ["character"],
        writableScopes: ["character"],
        autoLearn: true,
      },
    }
    const opts = await resolveSendOptions({
      character: policyCharacter,
      appSettings: { memory: {}, cacheOptimizationEnabled: false } as unknown as AppSettings,
      memoryDeps: deps({
        loadCandidates: async () => [
          mem("global pnpm preference", { id: "global", scope: "global" }),
          mem("character pnpm preference", {
            id: "character",
            scope: "character",
            characterId: "char_1",
          }),
        ],
      }),
      memoryUserMessage: "pnpm",
    })
    expect(opts.systemPrompt).not.toContain("global pnpm preference")
    expect(opts.systemPrompt).toContain("character pnpm preference")
  })

  it("lets a session recall override beat the Agent default but not the global master switch", async () => {
    const character = {
      ...baseCharacter,
      memoryPolicy: {
        operations: { recall: false, create: true, update: true, forget: true },
        readableScopes: ["global"],
        writableScopes: ["global"],
        autoLearn: true,
      },
    } satisfies Character
    const common = {
      character,
      appSettings: { memory: {}, cacheOptimizationEnabled: false } as unknown as AppSettings,
      session: { id: "s1", memoryUse: true } as never,
      memoryDeps: deps({ loadCandidates: async () => [mem("pnpm fact")] }),
      memoryUserMessage: "pnpm",
    }
    expect((await resolveSendOptions(common)).systemPrompt).toContain("pnpm fact")
    expect(
      (
        await resolveSendOptions({
          ...common,
          appSettings: { memory: { enabled: false } } as unknown as AppSettings,
        })
      ).systemPrompt
    ).not.toContain("pnpm fact")
  })

  it("passes workspace, character, agent, branch, and path reader context to retrieval", async () => {
    const loadCandidates = jest.fn(async () => [mem("pnpm fact")])
    await resolveSendOptions({
      character: baseCharacter,
      session: { id: "s1", projectId: "project-a" } as never,
      targetAgentId: "agent-a",
      memoryBranch: "main",
      memoryPath: "src/memory",
      memoryDeps: deps({ loadCandidates }),
      memoryUserMessage: "pnpm",
    })
    expect(loadCandidates).toHaveBeenCalledWith({
      characterId: "char_1",
      projectId: "project-a",
      agentId: "agent-a",
      branch: "main",
      path: "src/memory",
    })
  })

  it("recalls from the shared Twin namespace when there is no external delegation target", async () => {
    const loadCandidates = jest.fn(async () => [])
    await resolveSendOptions({
      character: { ...baseCharacter, twinId: "alice" },
      memoryDeps: deps({ loadCandidates }),
      memoryUserMessage: "queue",
    })
    expect(loadCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: "char_1", agentId: "twin:alice" })
    )
  })

  it("appends a recall section and stamps opts.memoryContext", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      appSettings: { memory: {}, cacheOptimizationEnabled: false } as unknown as AppSettings,
      memoryDeps: deps({
        loadCandidates: async () => [mem("The user prefers pnpm", { id: "hit" })],
      }),
      memoryUserMessage: "pnpm",
    })
    expect(opts.systemPrompt).toContain("BASE_SYSTEM_PROMPT")
    expect(opts.systemPrompt).toContain("What you remember about the user")
    expect(opts.systemPrompt).toContain("The user prefers pnpm")
    expect(opts.memoryContext?.retrievedMemories.map((m) => m.id)).toEqual(["hit"])
    expect(opts.memoryContext?.degraded).toBe(false)
  })

  it("injects the procedural block", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      appSettings: { memory: {}, cacheOptimizationEnabled: false } as unknown as AppSettings,
      memoryDeps: deps({
        loadProcedural: async () => [mem("Reply in Chinese", { type: "procedural" })],
      }),
      memoryUserMessage: "anything",
    })
    expect(opts.systemPrompt).toContain("Working preferences you've learned")
    expect(opts.memoryContext?.proceduralCount).toBe(1)
  })

  it("degrades cleanly (memoryContext.degraded) when the runtime throws", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      appSettings: { memory: {}, cacheOptimizationEnabled: false } as unknown as AppSettings,
      memoryDeps: deps({
        loadProcedural: async () => {
          throw new Error("db down")
        },
      }),
      memoryUserMessage: "pnpm",
    })
    expect(opts.systemPrompt).toBe("BASE_SYSTEM_PROMPT")
    expect(opts.memoryContext?.degraded).toBe(true)
  })
})

describe("resolveSendOptions project-claim injection", () => {
  function claim(text: string, over: Partial<Memory> = {}): Memory {
    return mem(text, {
      id: "claim1",
      scope: "workspace",
      projectId: "p1",
      projectMemoryKind: "constraint",
      ...over,
    })
  }

  // `cacheOptimizationEnabled: false` so the section lands in `systemPrompt`
  // rather than the dynamic tail — same reason the personal recall test does it.
  const ON = {
    memory: { enableProjectContinuity: true },
    cacheOptimizationEnabled: false,
  } as unknown as AppSettings

  it("stays silent until the user turns the section on", async () => {
    // Mining defaults ON and injection defaults OFF: learning is reversible and
    // reviewable, telling the model is what the user opts into.
    const opts = await resolveSendOptions({
      character: baseCharacter,
      session: { id: "s1", projectId: "p1" } as never,
      memoryDeps: deps({ loadCandidates: async () => [claim("the repo pins rust to 1.77.2")] }),
      memoryUserMessage: "rust pins repo",
    })
    expect(opts.projectContinuityContext).toBeUndefined()
    expect(opts.systemPrompt).not.toContain("Project context")
  })

  it("injects claims under a heading that frames them as data", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      appSettings: ON,
      session: { id: "s1", projectId: "p1" } as never,
      memoryDeps: deps({ loadCandidates: async () => [claim("the repo pins rust to 1.77.2")] }),
      memoryUserMessage: "rust pins repo",
    })
    expect(opts.systemPrompt).toContain("not instructions")
    expect(opts.projectContinuityContext?.claims.map((c) => c.id)).toEqual(["claim1"])
  })

  it("never lets a claim render under the personal heading", async () => {
    // The one failure this whole partition exists to prevent, asserted end to
    // end rather than only at the retriever.
    const opts = await resolveSendOptions({
      character: baseCharacter,
      appSettings: ON,
      session: { id: "s1", projectId: "p1" } as never,
      memoryDeps: deps({
        loadCandidates: async () => [
          claim("the repo pins rust to 1.77.2"),
          mem("the user pins rust builds", { id: "personal1" }),
        ],
      }),
      memoryUserMessage: "rust pins repo",
    })
    const prompt = opts.systemPrompt ?? ""
    const personalIdx = prompt.indexOf("What you remember about the user")
    const projectIdx = prompt.indexOf("Project context")
    expect(projectIdx).toBeGreaterThan(-1)
    const personalBlock =
      personalIdx >= 0
        ? prompt.slice(personalIdx, projectIdx > personalIdx ? projectIdx : undefined)
        : ""
    expect(personalBlock).not.toContain("the repo pins rust to 1.77.2")
  })

  it("does not inject for a chat with no workspace", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      appSettings: ON,
      memoryDeps: deps({ loadCandidates: async () => [claim("the repo pins rust to 1.77.2")] }),
      memoryUserMessage: "rust pins repo",
    })
    expect(opts.projectContinuityContext).toBeUndefined()
  })

  it("respects an Agent that may not read the workspace scope", async () => {
    const scoped: Character = {
      ...baseCharacter,
      memoryPolicy: { canRecall: true, readableScopes: ["global"] },
    } as Character
    const opts = await resolveSendOptions({
      character: scoped,
      appSettings: ON,
      session: { id: "s1", projectId: "p1" } as never,
      memoryDeps: deps({ loadCandidates: async () => [claim("the repo pins rust to 1.77.2")] }),
      memoryUserMessage: "rust pins repo",
    })
    expect(opts.projectContinuityContext).toBeUndefined()
  })

  it("carries the source anchor so the chip can jump to the turn", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      appSettings: ON,
      session: { id: "s1", projectId: "p1" } as never,
      memoryDeps: deps({
        loadCandidates: async () => [
          claim("the repo pins rust to 1.77.2", {
            sourceSessionId: "s7",
            sourceMessageId: "m3",
          }),
        ],
      }),
      memoryUserMessage: "rust pins repo",
    })
    expect(opts.projectContinuityContext?.claims[0]).toMatchObject({
      sourceSessionId: "s7",
      sourceMessageId: "m3",
    })
  })
})

describe("resolveSendOptions project_history_search offering", () => {
  const ON = { memory: { enableProjectContinuity: true } } as unknown as AppSettings

  function offered(opts: Awaited<ReturnType<typeof resolveSendOptions>>): boolean {
    return (opts.pluginTools ?? []).some((entry) => entry.name === "project_history_search")
  }

  it("is withheld until the user turns project continuity on", async () => {
    // A tool that can read every conversation in the workspace is part of the
    // same opt-in as the injected claims, not a separate always-on capability.
    const opts = await resolveSendOptions({
      character: baseCharacter,
      session: { id: "s1", projectId: "p1" } as never,
    })
    expect(offered(opts)).toBe(false)
  })

  it("is offered for a workspace-bound chat once continuity is on", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      appSettings: ON,
      session: { id: "s1", projectId: "p1" } as never,
    })
    expect(offered(opts)).toBe(true)
  })

  it("is withheld from a chat with no workspace, because the scope IS the isolation", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      appSettings: ON,
      session: { id: "s1" } as never,
    })
    expect(offered(opts)).toBe(false)
  })

  it("is withheld from a temporary chat", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      appSettings: {
        memory: { enableProjectContinuity: true, temporary: true },
      } as unknown as AppSettings,
      session: { id: "s1", projectId: "p1" } as never,
    })
    expect(offered(opts)).toBe(false)
  })
})
