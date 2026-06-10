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
