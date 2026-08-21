import {
  __resetDynamicSessionSourcesForTesting,
  detectSourceForFiles,
  detectSourcesForFiles,
  detectSourceForPath,
  getAcceptedPickerExtensions,
  getPickerOnlySources,
  getSessionSource,
  getSessionSources,
  registerSessionSource,
  unregisterSessionSourcesByPlugin,
} from "./registry"
import type { AgentSessionSourceAdapter } from "./types"

function fakeSource(
  id: string,
  detect: AgentSessionSourceAdapter["detect"],
  scanRoots: AgentSessionSourceAdapter["scanRoots"] = () => []
): AgentSessionSourceAdapter {
  return {
    id,
    displayName: id,
    labelKey: id,
    acceptedExtensions: [".jsonl"],
    scanRoots,
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

  describe("getAcceptedPickerExtensions", () => {
    it("covers every shipping source, including the non-JSONL ones", () => {
      const exts = getAcceptedPickerExtensions()
      // The picker used to hard-code ["jsonl","json"], which made Aider (.md)
      // and OpenCode (.db) impossible to select even though both ship.
      expect(exts).toEqual(expect.arrayContaining(["jsonl", "json", "md"]))
    })

    it("strips the leading dot the adapters declare", () => {
      expect(getAcceptedPickerExtensions().every((e) => !e.startsWith("."))).toBe(true)
    })

    it("de-dupes extensions shared by several sources", () => {
      const exts = getAcceptedPickerExtensions()
      expect(new Set(exts).size).toBe(exts.length)
    })

    it("picks up a plugin source's extension as soon as it registers", () => {
      expect(getAcceptedPickerExtensions()).not.toContain("sqlite3")
      registerSessionSource(
        { ...fakeSource("weird", () => "no"), acceptedExtensions: [".SQLite3"] },
        { pluginId: "p" }
      )
      // Also proves the normalisation lower-cases.
      expect(getAcceptedPickerExtensions()).toContain("sqlite3")
    })
  })

  describe("detectSourceForPath", () => {
    it("maps a changed file to the source whose root contains it", () => {
      expect(detectSourceForPath("/home/u/.claude/projects/enc/a.jsonl", "/home/u")?.id).toBe(
        "claude-code"
      )
      expect(detectSourceForPath("/home/u/.codex/sessions/2025/r.jsonl", "/home/u")?.id).toBe(
        "codex"
      )
    })

    it("returns undefined for a path under no scan root", () => {
      expect(detectSourceForPath("/tmp/random.jsonl", "/home/u")).toBeUndefined()
      // A sibling that merely shares a prefix segment must NOT match.
      expect(detectSourceForPath("/home/u/.claude-backup/x.jsonl", "/home/u")).toBeUndefined()
    })

    it("normalizes separators so Windows paths match", () => {
      registerSessionSource(
        fakeSource(
          "win",
          () => "no",
          () => ["C:/Users/x/.win/sessions"]
        ),
        {
          pluginId: "p",
        }
      )
      expect(detectSourceForPath("C:\\Users\\x\\.win\\sessions\\a.jsonl", "")?.id).toBe("p:win")
    })
  })
})

describe("multi-source picks and declared dormancy", () => {
  afterEach(() => __resetDynamicSessionSourcesForTesting())

  const files = [{ name: "a.jsonl", path: "/p/a.jsonl", content: "{}" }]

  function claiming(id: string, verdict: "match" | "maybe" | "no"): AgentSessionSourceAdapter {
    return {
      id,
      displayName: id,
      labelKey: id,
      acceptedExtensions: [".jsonl"],
      scanRoots: () => [],
      detect: () => verdict,
      listSessions: async () => [],
      parseSession: async () => ({ session: {} as never, messages: [] }),
    }
  }

  it("returns every claiming source, matches before maybes", () => {
    registerSessionSource(claiming("guess", "maybe"), { pluginId: "p1" })
    registerSessionSource(claiming("sure", "match"), { pluginId: "p2" })
    const ids = detectSourcesForFiles(files)
    // A mixed pick used to import only the single winner and drop the rest.
    expect(ids).toContain("p1:guess")
    expect(ids).toContain("p2:sure")
    expect(ids.indexOf("p2:sure")).toBeLessThan(ids.indexOf("p1:guess"))
  })

  it("returns an empty list when nothing claims the files", () => {
    expect(detectSourcesForFiles([{ name: "x.bin", path: "/x.bin", content: "" }])).toEqual([])
  })

  it("names Aider as picker-only, and picker-only sources scan nothing", () => {
    const pickerOnly = getPickerOnlySources()
    expect(pickerOnly.map((s) => s.id)).toContain("aider")
    // The contract the flag carries: declaring it means there is no scan root.
    for (const source of pickerOnly) {
      expect(source.scanRoots("/home/u", undefined)).toEqual([])
    }
  })

  it("no other built-in claims picker-only dormancy", () => {
    expect(getPickerOnlySources().map((s) => s.id)).toEqual(["aider"])
  })
})
