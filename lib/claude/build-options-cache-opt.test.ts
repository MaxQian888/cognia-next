/**
 * Targeted coverage for the cache-friendly prompt assembly branch of
 * `resolveSendOptions` (`AppSettings.cacheOptimizationEnabled`). The flag
 * must be a strict opt-in: OFF keeps the legacy assembly byte-identical,
 * ON moves every per-turn dynamic section (memory recall, twin retrieved
 * chunks + style few-shot) to the END of `appendSystemPrompt` so the
 * leading prompt prefix stays stable across turns.
 */

import "fake-indexeddb/auto"

// Memory runtime is dynamically imported by resolveSendOptions — mock it so
// the test controls the recalled section without a vector store.
const mApplyMemoryContext = jest.fn()
jest.mock("@/lib/memory/runtime/apply-memory-context", () => ({
  applyMemoryContext: (...args: unknown[]) => mApplyMemoryContext(...args),
}))

// Twin runtime mock — returns a template with explicit stable/dynamic
// cacheSegments so the split path is observable.
const mApplyTwinContext = jest.fn()
jest.mock("@/lib/twin/runtime", () => ({
  applyTwinContext: (...args: unknown[]) => mApplyTwinContext(...args),
}))

import { resolveSendOptions } from "./build-options"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { AppSettings, Character, ChatSession } from "./types"

const MEMORY_SECTION = "## Memory\n\nRECALLED_FACT_FOR_THIS_TURN"

beforeEach(async () => {
  jest.clearAllMocks()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  mApplyMemoryContext.mockResolvedValue({
    systemPromptSection: MEMORY_SECTION,
    retrievedMemories: [],
    proceduralCount: 0,
    degraded: false,
  })
})

const character: Character = {
  id: "char_1",
  name: "Char",
  avatarColor: "oklch(0.7 0 0)",
  systemPrompt: "BASE_SYSTEM_PROMPT",
  createdAt: 1,
  updatedAt: 1,
}

const memoryCtx = {
  memoryDeps: {} as never,
  memoryUserMessage: "what did I say about caching?",
}

describe("cacheOptimizationEnabled = OFF (legacy assembly)", () => {
  it("keeps the memory section inside systemPrompt and out of appendSystemPrompt", async () => {
    const opts = await resolveSendOptions({ character, ...memoryCtx })
    expect(opts.systemPrompt).toContain(MEMORY_SECTION)
    expect(opts.appendSystemPrompt ?? "").not.toContain(MEMORY_SECTION)
  })

  it("keeps the full twin prompt (incl. dynamic segments) as baseSystem", async () => {
    mApplyTwinContext.mockResolvedValue({
      applied: {
        systemPrompt: "STABLE_TWIN\n\n---\n\nDYNAMIC_CHUNKS",
        cacheSegments: { stable: "STABLE_TWIN", dynamic: "DYNAMIC_CHUNKS" },
        metadata: { twinName: "T", retrievedChunkIds: [], styleSampleIds: [] },
      },
      degraded: false,
      retrievedChunks: [],
      selectedStyleSamples: [],
    })
    const opts = await resolveSendOptions({
      character: { ...character, twinId: "twin_1" },
      twinDeps: {} as never,
      twinUserMessage: "hello twin",
    })
    expect(opts.systemPrompt).toContain("DYNAMIC_CHUNKS")
    expect(opts.appendSystemPrompt ?? "").not.toContain("DYNAMIC_CHUNKS")
  })
})

describe("cacheOptimizationEnabled = ON (cache-friendly assembly)", () => {
  const appSettings = { cacheOptimizationEnabled: true } as AppSettings

  it("forwards the flag to SendOptions for the sidecar (and omits it when off)", async () => {
    const on = await resolveSendOptions({ character, appSettings })
    expect(on.cacheOptimizationEnabled).toBe(true)
    const off = await resolveSendOptions({ character })
    expect(off.cacheOptimizationEnabled).toBeUndefined()
  })

  it("moves the memory section to the END of appendSystemPrompt", async () => {
    const session = { id: "s1", title: "t", kind: "direct", briefMode: true } as ChatSession
    const opts = await resolveSendOptions({ character, session, appSettings, ...memoryCtx })
    expect(opts.systemPrompt).not.toContain(MEMORY_SECTION)
    const append = opts.appendSystemPrompt ?? ""
    expect(append).toContain(MEMORY_SECTION)
    // Dynamic tail lands AFTER session-stable sections (brief-mode snippet).
    expect(append.trimEnd().endsWith("RECALLED_FACT_FOR_THIS_TURN")).toBe(true)
  })

  it("keeps the stable twin segments in systemPrompt and moves dynamic ones to the tail", async () => {
    mApplyTwinContext.mockResolvedValue({
      applied: {
        systemPrompt: "STABLE_TWIN\n\n---\n\nDYNAMIC_CHUNKS",
        cacheSegments: { stable: "STABLE_TWIN", dynamic: "DYNAMIC_CHUNKS" },
        metadata: { twinName: "T", retrievedChunkIds: [], styleSampleIds: [] },
      },
      degraded: false,
      retrievedChunks: [],
      selectedStyleSamples: [],
    })
    const opts = await resolveSendOptions({
      character: { ...character, twinId: "twin_1" },
      appSettings,
      twinDeps: {} as never,
      twinUserMessage: "hello twin",
    })
    expect(opts.systemPrompt).toContain("STABLE_TWIN")
    expect(opts.systemPrompt).not.toContain("DYNAMIC_CHUNKS")
    expect(opts.appendSystemPrompt ?? "").toContain("DYNAMIC_CHUNKS")
  })

  it("falls back to the full twin prompt when cacheSegments has no dynamic part", async () => {
    mApplyTwinContext.mockResolvedValue({
      applied: {
        systemPrompt: "STABLE_ONLY",
        cacheSegments: { stable: "STABLE_ONLY", dynamic: "" },
        metadata: { twinName: "T", retrievedChunkIds: [], styleSampleIds: [] },
      },
      degraded: false,
      retrievedChunks: [],
      selectedStyleSamples: [],
    })
    const opts = await resolveSendOptions({
      character: { ...character, twinId: "twin_1" },
      appSettings,
      twinDeps: {} as never,
      twinUserMessage: "hello twin",
    })
    expect(opts.systemPrompt).toContain("STABLE_ONLY")
    expect(opts.appendSystemPrompt ?? "").toBe("")
  })

  it("orders memory recall AFTER the twin dynamic segment in the tail", async () => {
    mApplyTwinContext.mockResolvedValue({
      applied: {
        systemPrompt: "STABLE_TWIN\n\n---\n\nDYNAMIC_CHUNKS",
        cacheSegments: { stable: "STABLE_TWIN", dynamic: "DYNAMIC_CHUNKS" },
        metadata: { twinName: "T", retrievedChunkIds: [], styleSampleIds: [] },
      },
      degraded: false,
      retrievedChunks: [],
      selectedStyleSamples: [],
    })
    const opts = await resolveSendOptions({
      character: { ...character, twinId: "twin_1" },
      appSettings,
      twinDeps: {} as never,
      twinUserMessage: "hello twin",
      ...memoryCtx,
    })
    const append = opts.appendSystemPrompt ?? ""
    const twinIdx = append.indexOf("DYNAMIC_CHUNKS")
    const memIdx = append.indexOf(MEMORY_SECTION)
    expect(twinIdx).toBeGreaterThanOrEqual(0)
    expect(memIdx).toBeGreaterThan(twinIdx)
  })

  it("does not re-append the dynamic tail for workflow-editor sessions", async () => {
    const session = {
      id: "s1",
      title: "t",
      kind: "workflow-editor",
      workflowId: "wf_1",
      createdAt: 0,
      updatedAt: 0,
    } as ChatSession
    const opts = await resolveSendOptions({ character, session, appSettings, ...memoryCtx })
    // The copilot path replaces the prompt stack; the memory tail must not
    // leak back in after the replacement.
    expect(opts.appendSystemPrompt ?? "").not.toContain(MEMORY_SECTION)
  })
})
