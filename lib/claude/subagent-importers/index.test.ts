import { SUBAGENT_SOURCE_ADAPTERS, detectSource, getSubagentAdapter } from "./index"
import type { ImportFile, SubagentSourceId } from "./types"

function file(path: string, content = "body"): ImportFile {
  const filename = path.split("/").pop() ?? path
  return { filename, sourcePath: path, content }
}

describe("SUBAGENT_SOURCE_ADAPTERS", () => {
  it("contains every adapter in priority order, generic last", () => {
    const ids: SubagentSourceId[] = SUBAGENT_SOURCE_ADAPTERS.map((a) => a.id)
    expect(ids).toEqual([
      "claude-code",
      "codex-cli",
      "opencode",
      "cursor",
      "cline",
      "pi",
      "generic-md",
    ])
  })

  it("each adapter has stable metadata fields", () => {
    for (const a of SUBAGENT_SOURCE_ADAPTERS) {
      expect(a.id).toBeTruthy()
      expect(a.displayName).toBeTruthy()
      expect(a.labelKey).toBeTruthy()
      expect(a.acceptedExtensions.length).toBeGreaterThan(0)
      expect(typeof a.detect).toBe("function")
      expect(typeof a.parse).toBe("function")
    }
  })
})

describe("getSubagentAdapter", () => {
  it("returns the adapter by id", () => {
    expect(getSubagentAdapter("claude-code").id).toBe("claude-code")
    expect(getSubagentAdapter("generic-md").id).toBe("generic-md")
  })

  it("throws on unknown id", () => {
    expect(() => getSubagentAdapter("nope" as SubagentSourceId)).toThrow(/Unknown subagent source/)
  })
})

describe("detectSource", () => {
  it("picks claude-code when path matches", () => {
    expect(detectSource({ files: [file(".claude/agents/a.md")] })).toBe("claude-code")
  })

  it("picks codex-cli when path matches", () => {
    expect(detectSource({ files: [file(".codex/agents/a.md")] })).toBe("codex-cli")
  })

  it("picks opencode when path matches", () => {
    expect(detectSource({ files: [file(".config/opencode/agent/a.md")] })).toBe("opencode")
    expect(detectSource({ files: [file(".opencode/agent/a.md")] })).toBe("opencode")
  })

  it("picks cursor when path matches", () => {
    expect(detectSource({ files: [file(".cursor/rules/a.mdc")] })).toBe("cursor")
  })

  it("picks cline when path matches", () => {
    expect(detectSource({ files: [file(".clinerules/a.md")] })).toBe("cline")
  })

  it("falls back to generic-md when no adapter is sure", () => {
    expect(detectSource({ files: [file("docs/foo.md")] })).toBe("generic-md")
  })

  it("returns null on empty input", () => {
    expect(detectSource({ files: [] })).toBeNull()
  })

  it("returns null when no adapter accepts any file", () => {
    expect(detectSource({ files: [file("x.txt")] })).toBeNull()
  })

  it("first 'match' wins over later 'maybe'", () => {
    // Mix of claude-code path + generic .md → claude-code wins
    expect(
      detectSource({
        files: [file(".claude/agents/a.md"), file("docs/foo.md")],
      })
    ).toBe("claude-code")
  })
})
