import {
  pruneToolsSemantica,
  __setSemanticToolRouterDepsForTesting,
  __resetSemanticVectorCacheForTesting,
} from "./semantic-tool-router"
import type { ToolRouteRecord, SemanticToolRoutingSettings } from "./routing-types"

/**
 * Deterministic fake embedding: maps known texts to fixed unit vectors so
 * cosine similarity is exact. Unknown texts get an orthogonal vector.
 */
const VECTORS: Record<string, number[]> = {
  "search the codebase for a pattern": [1, 0, 0],
  "find text in files": [0.95, 0.05, 0],
  "ripgrep search": [0.9, 0.1, 0],
  "take a screenshot": [0, 1, 0],
  "capture the screen": [0, 0.98, 0.02],
  "convert a video": [0, 0, 1],
  "weather lookup": [0.1, 0.1, 0.1],
}

function fakeEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(texts.map((t) => VECTORS[t] ?? [0.001, 0.001, 0.001]))
}

const SETTINGS: SemanticToolRoutingSettings = {
  enabled: true,
  activationToolCount: 2,
  topK: 2,
  threshold: 0.5,
  pinnedTools: [],
}

const CANDIDATES = [
  { name: "rg_search", description: "find text in files", pluginId: "ripgrep-tools" },
  { name: "screenshot", description: "capture the screen", pluginId: "screenshot" },
  { name: "video_convert", description: "convert a video", pluginId: "ffmpeg-tools" },
  { name: "weather", description: "weather lookup", pluginId: "weather" },
]

function installDeps(routes: ToolRouteRecord[] = [], cacheSpy = jest.fn()) {
  __setSemanticToolRouterDepsForTesting({
    listRoutes: async () => routes,
    embed: (texts) => fakeEmbed(texts),
    cacheRouteEmbeddings: cacheSpy,
  })
  return cacheSpy
}

afterEach(() => {
  __setSemanticToolRouterDepsForTesting(null)
  __resetSemanticVectorCacheForTesting()
})

describe("pruneToolsSemantica", () => {
  it("keeps the topK tools most similar to the query (derived utterances)", async () => {
    installDeps()
    const result = await pruneToolsSemantica({
      query: "search the codebase for a pattern",
      candidates: CANDIDATES,
      settings: SETTINGS,
    })
    expect(result).not.toBeNull()
    const names = result!.kept.map((c) => c.name)
    expect(names).toContain("rg_search")
    expect(names).not.toContain("video_convert")
    expect(result!.prunedCount).toBeGreaterThan(0)
    expect(result!.scores.rg_search).toBeGreaterThan(result!.scores.video_convert)
  })

  it("persisted tool routes beat derived utterances and write back vectors", async () => {
    const routes: ToolRouteRecord[] = [
      {
        id: "user:tool:video_convert",
        kind: "tool",
        refId: "video_convert",
        utterances: ["search the codebase for a pattern"], // deliberately remapped
        enabled: true,
        source: "user",
        updatedAt: 1,
      },
    ]
    const cacheSpy = installDeps(routes)
    const result = await pruneToolsSemantica({
      query: "search the codebase for a pattern",
      candidates: CANDIDATES,
      settings: SETTINGS,
    })
    // The route's utterance matches the query exactly → video_convert wins.
    expect(result!.kept.map((c) => c.name)).toContain("video_convert")
    // Fresh vectors were written back onto the persisted route.
    expect(cacheSpy).toHaveBeenCalledWith(
      "user:tool:video_convert",
      expect.any(Array),
      expect.any(String)
    )
  })

  it("pinned tools always survive; pins don't consume topK slots", async () => {
    installDeps()
    const result = await pruneToolsSemantica({
      query: "search the codebase for a pattern",
      candidates: CANDIDATES,
      settings: { ...SETTINGS, topK: 1, pinnedTools: ["weather"] },
    })
    const names = result!.kept.map((c) => c.name)
    expect(names).toContain("weather")
    expect(names).toContain("rg_search")
  })

  it("returns null when pruning should be skipped", async () => {
    installDeps()
    // Empty query.
    expect(
      await pruneToolsSemantica({ query: "  ", candidates: CANDIDATES, settings: SETTINGS })
    ).toBeNull()
    // Fewer candidates than topK.
    expect(
      await pruneToolsSemantica({
        query: "search",
        candidates: CANDIDATES.slice(0, 2),
        settings: { ...SETTINGS, topK: 5 },
      })
    ).toBeNull()
  })

  it("returns null on embedding failure (never blocks a send)", async () => {
    __setSemanticToolRouterDepsForTesting({
      listRoutes: async () => [],
      embed: async () => {
        throw new Error("engine offline")
      },
      cacheRouteEmbeddings: jest.fn(),
    })
    expect(
      await pruneToolsSemantica({
        query: "search the codebase for a pattern",
        candidates: CANDIDATES,
        settings: SETTINGS,
      })
    ).toBeNull()
  })

  it("keeps a small safety floor when nothing passes the threshold", async () => {
    installDeps()
    const result = await pruneToolsSemantica({
      query: "search the codebase for a pattern",
      candidates: CANDIDATES,
      settings: { ...SETTINGS, threshold: 0.999 },
    })
    expect(result).not.toBeNull()
    expect(result!.kept.length).toBeGreaterThan(0)
    expect(result!.kept.length).toBeLessThan(CANDIDATES.length)
  })

  it("plugin-level routes apply to all of a plugin's tools", async () => {
    const routes: ToolRouteRecord[] = [
      {
        id: "user:plugin:weather",
        kind: "plugin",
        refId: "weather",
        utterances: ["search the codebase for a pattern"],
        enabled: true,
        source: "user",
        updatedAt: 1,
      },
    ]
    installDeps(routes)
    const result = await pruneToolsSemantica({
      query: "search the codebase for a pattern",
      candidates: CANDIDATES,
      settings: SETTINGS,
    })
    expect(result!.kept.map((c) => c.name)).toContain("weather")
  })
})
