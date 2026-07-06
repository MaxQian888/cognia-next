import {
  __resetDynamicSessionSourcesForTesting,
  detectSourceForFiles,
  getSessionSource,
  getSessionSources,
  registerSessionSource,
  unregisterSessionSourcesByPlugin,
} from "./registry"
import type { AgentSessionSourceAdapter } from "./types"

function fakeSource(
  id: string,
  detect: AgentSessionSourceAdapter["detect"]
): AgentSessionSourceAdapter {
  return {
    id,
    displayName: id,
    labelKey: id,
    acceptedExtensions: [".jsonl"],
    scanRoots: () => [],
    detect,
    listSessions: async () => [],
    parseSession: async () => ({
      session: { id, title: "", createdAt: 0, updatedAt: 0 } as never,
      messages: [],
    }),
  }
}

afterEach(() => __resetDynamicSessionSourcesForTesting())

describe("session-source registry", () => {
  it("ships the three first-party sources", () => {
    const ids = getSessionSources().map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining(["claude-code", "codex", "opencode"]))
  })

  it("registers a plugin source namespaced by pluginId and disposes it", () => {
    const dispose = registerSessionSource(
      fakeSource("mine", () => "no"),
      { pluginId: "p1" }
    )
    expect(getSessionSource("p1:mine")).toBeDefined()
    dispose()
    expect(getSessionSource("p1:mine")).toBeUndefined()
  })

  it("refuses to shadow a built-in id", () => {
    registerSessionSource(fakeSource("codex", () => "match"))
    // Still only one codex, and it is the static one (scanRoots non-empty).
    const all = getSessionSources().filter((s) => s.id === "codex")
    expect(all).toHaveLength(1)
    expect(all[0].scanRoots("/home")).not.toHaveLength(0)
  })

  it("removes all sources for a plugin", () => {
    registerSessionSource(
      fakeSource("a", () => "no"),
      { pluginId: "p2" }
    )
    registerSessionSource(
      fakeSource("b", () => "no"),
      { pluginId: "p2" }
    )
    expect(unregisterSessionSourcesByPlugin("p2")).toBe(2)
    expect(getSessionSource("p2:a")).toBeUndefined()
  })

  it("detects the source of picked files (first match wins over maybe)", () => {
    registerSessionSource(fakeSource("m", () => "maybe"))
    registerSessionSource(fakeSource("x", () => "match"))
    expect(detectSourceForFiles([{ name: "f", path: "f", content: "" }])).toBe("x")
  })

  it("returns null when no source claims the files", () => {
    __resetDynamicSessionSourcesForTesting()
    expect(detectSourceForFiles([{ name: "z.txt", path: "/z.txt", content: "nope" }])).toBeNull()
  })
})
