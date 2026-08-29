import { collectCandidates, staticHeadCandidates, type CompletionSources } from "./providers"
import type { ShellIntelligenceRequest } from "./types"

const sources = (over: Partial<CompletionSources> = {}): CompletionSources => ({
  listPathExecutables: async () => [],
  completePaths: async () => [],
  ...over,
})

const request = (line: string, over: Partial<ShellIntelligenceRequest> = {}) => ({
  line,
  cursor: line.length,
  cwd: "/work",
  shell: { path: "/bin/zsh", kind: "zsh" as const, source: "setting" as const },
  availability: "full" as const,
  ...over,
})

const collect = (line: string, s = sources(), over: Partial<ShellIntelligenceRequest> = {}) =>
  collectCandidates(request(line, over), s, new AbortController().signal)

describe("staticHeadCandidates", () => {
  it("offers shell builtins for a prefix", () => {
    expect(staticHeadCandidates("ec", "zsh")).toContainEqual({ name: "echo", kind: "builtin" })
  })

  it("offers known CLI names, which is what makes `kub` answer offline", () => {
    expect(staticHeadCandidates("kub", "zsh").map((c) => c.name)).toContain("kubectl")
  })

  it("offers nothing for an empty prefix", () => {
    expect(staticHeadCandidates("", "zsh")).toEqual([])
  })

  it("uses the shell's own builtin list", () => {
    expect(staticHeadCandidates("Get-", "pwsh").length).toBeGreaterThan(0)
    expect(staticHeadCandidates("Get-", "zsh")).toEqual([])
  })
})

describe("collectCandidates — head position", () => {
  it("merges host $PATH executables with the static lists", async () => {
    const out = await collect("kub", sources({ listPathExecutables: async () => ["kubectx"] }))
    const names = out.map((c) => c.insertText)
    expect(names).toContain("kubectl")
    expect(names).toContain("kubectx")
  })

  it("replaces exactly the typed head token", async () => {
    const out = await collect("kub")
    expect(out[0]).toMatchObject({ from: 0, to: 3 })
  })

  it("completes the head after a pipe, not the first command's arguments", async () => {
    const listPathExecutables = jest.fn().mockResolvedValue(["grep"])
    const out = await collect("cat foo | gre", sources({ listPathExecutables }))
    expect(listPathExecutables).toHaveBeenCalledWith(expect.objectContaining({ prefix: "gre" }))
    expect(out.map((c) => c.insertText)).toContain("grep")
    expect(out[0]).toMatchObject({ from: 10, to: 13 })
  })

  it("completes the head inside a substitution", async () => {
    const listPathExecutables = jest.fn().mockResolvedValue(["grep"])
    await collect("echo $(gre", sources({ listPathExecutables }))
    expect(listPathExecutables).toHaveBeenCalledWith(expect.objectContaining({ prefix: "gre" }))
  })

  it("completes a path-like head as a path, not a command name", async () => {
    const completePaths = jest.fn().mockResolvedValue([{ name: "script.sh", isDir: false }])
    const listPathExecutables = jest.fn().mockResolvedValue([])
    await collect("./scr", sources({ completePaths, listPathExecutables }))
    expect(completePaths).toHaveBeenCalled()
    expect(listPathExecutables).not.toHaveBeenCalled()
  })

  it("keeps the static lists but skips the host with no host", async () => {
    const listPathExecutables = jest.fn()
    const out = await collect("kub", sources({ listPathExecutables }), {
      availability: "static-only",
    })
    expect(listPathExecutables).not.toHaveBeenCalled()
    expect(out.map((c) => c.insertText)).toContain("kubectl")
  })
})

describe("collectCandidates — argument position", () => {
  it("completes a directory with a trailing separator and asks to continue", async () => {
    const out = await collect(
      "cat ./sr",
      sources({ completePaths: async () => [{ name: "src", isDir: true }] })
    )
    expect(out[0]).toMatchObject({
      insertText: "./src/",
      kind: "directory",
      continues: true,
      from: 4,
      to: 8,
    })
  })

  it("does not mark a file as continuing", async () => {
    const out = await collect(
      "cat RE",
      sources({ completePaths: async () => [{ name: "README.md", isDir: false }] })
    )
    expect(out[0]).toMatchObject({ kind: "path", insertText: "README.md" })
    expect(out[0].continues).toBeUndefined()
  })

  it("passes the typed fragment through to the host", async () => {
    const completePaths = jest.fn().mockResolvedValue([])
    await collect("cat ./sr", sources({ completePaths }))
    expect(completePaths).toHaveBeenCalledWith(expect.objectContaining({ fragment: "./sr" }))
  })

  it("offers the head command's spec subcommands", async () => {
    const out = await collect("git rem")
    expect(out.map((c) => c.insertText)).toContain("remote")
    expect(out.find((c) => c.insertText === "remote")).toMatchObject({ kind: "argument" })
  })

  it("offers spec options for a flag token", async () => {
    const out = await collect("git commit --me")
    expect(out.map((c) => c.insertText)).toContain("--message")
  })

  it("walks prior arguments to the right subcommand node", async () => {
    const out = await collect("git remote ad")
    expect(out.map((c) => c.insertText)).toContain("add")
  })

  it("uses the SECOND command's spec after a pipe", async () => {
    const out = await collect("ls | git rem")
    expect(out.map((c) => c.insertText)).toContain("remote")
  })

  it("keeps spec completion working with no host", async () => {
    const completePaths = jest.fn()
    const out = await collect("git rem", sources({ completePaths }), {
      availability: "static-only",
    })
    expect(completePaths).not.toHaveBeenCalled()
    expect(out.map((c) => c.insertText)).toContain("remote")
  })
})

describe("collectCandidates — refusals", () => {
  it("completes a redirect target as a path and never as a command", async () => {
    const listPathExecutables = jest.fn()
    const completePaths = jest.fn().mockResolvedValue([{ name: "out.txt", isDir: false }])
    const out = await collect("cmd > ou", sources({ listPathExecutables, completePaths }))
    expect(listPathExecutables).not.toHaveBeenCalled()
    expect(out.map((c) => c.insertText)).toContain("out.txt")
  })

  it("returns nothing when a source throws", async () => {
    const out = await collect(
      "cat ./sr",
      sources({
        completePaths: async () => {
          throw new Error("host gone")
        },
      })
    )
    expect(out).toEqual([])
  })

  it("returns nothing once the signal is aborted", async () => {
    const controller = new AbortController()
    const promise = collectCandidates(
      request("cat ./sr"),
      sources({
        completePaths: async () => {
          controller.abort()
          return [{ name: "src", isDir: true }]
        },
      }),
      controller.signal
    )
    expect(await promise).toEqual([])
  })

  it("returns nothing for a cursor inside an operator", async () => {
    expect(
      await collectCandidates(
        request("a | b", { cursor: 2 }),
        sources(),
        new AbortController().signal
      )
    ).toEqual([])
  })
})
