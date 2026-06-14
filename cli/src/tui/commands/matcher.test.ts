/**
 * @jest-environment node
 */
import { matchSlash, parseSlash, resolveCommand, slashQuery } from "./matcher"

describe("parseSlash", () => {
  it("splits the command and args", () => {
    expect(parseSlash("/model claude-x")).toEqual({ command: "model", args: "claude-x" })
    expect(parseSlash("  /clear  ")).toEqual({ command: "clear", args: "" })
  })
  it("returns null for non-slash lines", () => {
    expect(parseSlash("hello")).toBeNull()
  })
})

describe("resolveCommand", () => {
  it("resolves by name and alias", () => {
    expect(resolveCommand("clear")?.name).toBe("clear")
    expect(resolveCommand("new")?.name).toBe("clear")
    expect(resolveCommand("quit")?.name).toBe("exit")
  })
  it("returns undefined for unknown commands", () => {
    expect(resolveCommand("frob")).toBeUndefined()
  })
})

describe("matchSlash", () => {
  it("returns all commands for an empty query", () => {
    expect(matchSlash("").length).toBeGreaterThan(4)
  })
  it("filters by name prefix", () => {
    expect(matchSlash("mo").map((c) => c.name)).toEqual(["model", "mode"])
  })
  it("matches an alias prefix", () => {
    expect(matchSlash("ne").map((c) => c.name)).toContain("clear")
  })

  it("boosts the most recently used command to the top for an empty query", () => {
    const names = matchSlash("", { history: ["/model", "/mode"] }).map((c) => c.name)
    expect(names[0]).toBe("mode")
    expect(names[1]).toBe("model")
  })

  it("boosts recently used commands within a prefix filter", () => {
    expect(matchSlash("mo", { history: ["/model", "/mode"] }).map((c) => c.name)).toEqual([
      "mode",
      "model",
    ])
  })

  it("falls back to registration order when history is absent", () => {
    expect(matchSlash("mo", { history: [] }).map((c) => c.name)).toEqual(["model", "mode"])
  })

  it("resolves aliases to canonical command names for recency", () => {
    const names = matchSlash("", { history: ["/new"] }).map((c) => c.name)
    expect(names[0]).toBe("clear")
  })

  it("ignores non-slash history entries when scoring", () => {
    expect(matchSlash("mo", { history: ["hello", "/mode", "world"] }).map((c) => c.name)).toEqual([
      "mode",
      "model",
    ])
  })

  it("falls back to a fuzzy subsequence match when no prefix matches", () => {
    // `ext` is not a prefix of any command but is a subsequence of `exit`.
    const names = matchSlash("ext").map((c) => c.name)
    expect(names).toContain("exit")
    // a prefix query is unaffected by the fuzzy tier (no mascot from "mo")
    expect(matchSlash("mo").map((c) => c.name)).toEqual(["model", "mode"])
  })

  it("falls back to a description keyword match when name/alias find nothing", () => {
    // no command name/alias contains the subsequence "zzz"; nothing matches.
    expect(matchSlash("zzzqqq")).toEqual([])
    // a real description word surfaces commands that mention it
    const names = matchSlash("reasoning").map((c) => c.name)
    expect(names).toContain("think")
  })
})

describe("slashQuery", () => {
  it("returns the query for a bare slash token", () => {
    expect(slashQuery("/mod")).toBe("mod")
    expect(slashQuery("/")).toBe("")
  })
  it("returns null once a space is typed or with no slash", () => {
    expect(slashQuery("/model x")).toBeNull()
    expect(slashQuery("hello")).toBeNull()
  })
})
