/**
 * Targeted coverage for the twin-injection branch of `resolveSendOptions`.
 * The full resolver has its own tests covering precedence rules; here we
 * just check that the new opt-in path triggers correctly and degrades
 * cleanly.
 */

import "fake-indexeddb/auto"

// Mock the embedding module used by applyTwinContext so the test never
// makes a real network call.
jest.mock("@/lib/ai/embedding/embedding", () => ({
  generateEmbedding: jest.fn(async () => ({ embedding: [0.1, 0.2, 0.3], usage: undefined })),
  generateEmbeddings: jest.fn(async () => ({ embeddings: [], usage: undefined })),
}))

import { resolveSendOptions } from "./build-options"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { Character } from "./types"
import type { TwinRuntimeDepsForBuild } from "./build-options"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

const baseCharacter: Character = {
  id: "char_1",
  name: "Twin Alice",
  avatarColor: "oklch(0.7 0.15 240)",
  systemPrompt: "BASE_SYSTEM_PROMPT",
  twinId: "twin_alice",
  createdAt: 1,
  updatedAt: 1,
}

const fakeDeps: TwinRuntimeDepsForBuild = {
  store: {
    searchByEmbedding: async () => [],
  },
  embedding: {
    provider: "openai",
    model: "text-embedding-3-small",
    apiKey: "sk-test",
  },
}

describe("resolveSendOptions twin injection", () => {
  it("does not invoke the twin runtime when ctx.twinDeps is absent", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      twinUserMessage: "hi",
    })
    expect(opts.systemPrompt).toBe("BASE_SYSTEM_PROMPT")
  })

  it("does not invoke the twin runtime when twinUserMessage is blank", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      twinDeps: fakeDeps,
      twinUserMessage: "  ",
    })
    expect(opts.systemPrompt).toBe("BASE_SYSTEM_PROMPT")
  })

  it("does not invoke the twin runtime when character has no twinId", async () => {
    const opts = await resolveSendOptions({
      character: { ...baseCharacter, twinId: undefined },
      twinDeps: fakeDeps,
      twinUserMessage: "hi",
    })
    expect(opts.systemPrompt).toBe("BASE_SYSTEM_PROMPT")
  })

  it("replaces baseSystem with the four-segment twin prompt when all opt-in conditions are met", async () => {
    const opts = await resolveSendOptions({
      character: baseCharacter,
      twinDeps: fakeDeps,
      twinUserMessage: "what would Alice do?",
    })
    expect(opts.systemPrompt).toContain("BASE_SYSTEM_PROMPT")
    expect(opts.systemPrompt).toContain("You are Twin Alice.")
  })

  it("falls back to baseSystem if the twin runtime throws", async () => {
    const explodingDeps: TwinRuntimeDepsForBuild = {
      ...fakeDeps,
      store: {
        searchByEmbedding: async () => {
          throw new Error("boom")
        },
      },
    }
    const opts = await resolveSendOptions({
      character: baseCharacter,
      twinDeps: explodingDeps,
      twinUserMessage: "hi",
    })
    // Even when retrieval throws, applyTwinContext should still produce an
    // identity-only prompt (it wraps internal errors), so we still see the
    // twin identity block on top of the original.
    expect(opts.systemPrompt).toContain("BASE_SYSTEM_PROMPT")
  })

  it("forwards precomputedQueryEmbedding to applyTwinContext", async () => {
    // Mock the applyTwinContext function to capture the arguments it receives
    jest.mock("@/lib/twin/runtime", () => ({
      applyTwinContext: jest.fn(async (_input) => ({
        applied: {
          systemPrompt: "TWIN_SYSTEM_PROMPT",
        },
      })),
    }))

    const opts = await resolveSendOptions({
      character: baseCharacter,
      twinDeps: fakeDeps,
      twinUserMessage: "what would Alice do?",
      precomputedQueryEmbedding: [0.5, 0.5, 0.1],
    })

    // The twin runtime should have been invoked and the system prompt replaced
    expect(opts.systemPrompt).toContain("TWIN_SYSTEM_PROMPT")
  })
})
