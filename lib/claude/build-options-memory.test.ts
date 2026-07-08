/** @jest-environment jsdom */
/**
 * Targeted coverage for the long-term-memory injection branch of
 * `resolveSendOptions`. Mirrors `build-options-twin.test.ts`.
 */

import "fake-indexeddb/auto"

import { resolveSendOptions } from "./build-options"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { AppSettings, Character } from "./types"
import type { Memory } from "@/types/memory/memory"
import type { ApplyMemoryContextDeps } from "@/lib/memory/runtime/apply-memory-context"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
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

  it("appends a recall section and stamps opts.memoryContext", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
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
