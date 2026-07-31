import {
  assertBinaryName,
  buildCliSkeleton,
  CLI_EXECUTE_PERMISSION,
  listCliCandidates,
} from "./cli-source"

describe("assertBinaryName", () => {
  it.each(["rg", "fd", "gh", "ffmpeg", "node-22", "a.out"])("accepts %s", (name) => {
    expect(assertBinaryName(name)).toBe(name)
  })

  it("trims surrounding whitespace", () => {
    expect(assertBinaryName("  rg  ")).toBe("rg")
  })

  it.each(["/usr/bin/rg", "rg --json", "rg;rm -rf /", "$(rg)", "-rg"])("rejects %s", (value) => {
    expect(() => assertBinaryName(value)).toThrow(/bare binary name/)
  })

  it("explains what --input means when it is empty", () => {
    expect(() => assertBinaryName("")).toThrow(/--input is required/)
  })
})

describe("listCliCandidates", () => {
  it("offers the binary itself", () => {
    expect(listCliCandidates("rg")).toEqual([
      { id: "rg", label: "rg", detail: "external binary resolved on PATH" },
    ])
  })
})

describe("buildCliSkeleton", () => {
  const built = buildCliSkeleton("rg")

  it("records the binary as a requirement rather than a path", () => {
    expect(built.binary).toEqual({ name: "rg" })
  })

  it("ships NO tool definitions — a guessed argv mapping would lint green and misbehave", () => {
    expect(built.cliTools).toEqual([])
  })

  it("tells the author the empty table is what lint will flag", () => {
    expect(built.todos.join(" ")).toContain("manifest.capability.field_missing")
    expect(built.todos.join(" ")).toContain("ripgrep-tools")
  })
})

describe("CLI_EXECUTE_PERMISSION", () => {
  it("is the host's gate for declarative CLI tools", () => {
    expect(CLI_EXECUTE_PERMISSION).toBe("cli:execute")
  })
})
