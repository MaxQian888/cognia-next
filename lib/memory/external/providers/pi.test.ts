import { discoverPi, piAgentDir } from "./pi"
import type { DiscoverCtx, ExternalFs } from "../types"

function fsWith(present: string[]): ExternalFs {
  return {
    exists: async (p: string) => present.includes(p),
    stat: async (p: string) => {
      if (!present.includes(p)) throw new Error("ENOENT")
      return { size: 128 }
    },
    readTextFile: async () => "",
    writeTextFile: async () => {},
  } as unknown as ExternalFs
}

const ctx = (overrides: Partial<DiscoverCtx> = {}): DiscoverCtx =>
  ({
    home: "/home/u",
    roots: [],
    cwd: undefined,
    platform: "linux",
    fs: fsWith([]),
    ...overrides,
  }) as DiscoverCtx

describe("piAgentDir", () => {
  it("prefers the resolved root over the home-relative default", () => {
    expect(
      piAgentDir({ home: "/home/u", vendorRoots: { piAgentDir: "/custom/pi" } as never })
    ).toBe("/custom/pi")
  })

  it("falls back to <home>/.pi/agent — the agent subdir, not ~/.pi", () => {
    expect(piAgentDir({ home: "/home/u", vendorRoots: undefined })).toBe("/home/u/.pi/agent")
  })

  it("is blank with no home and no resolved root", () => {
    expect(piAgentDir({ home: "", vendorRoots: undefined })).toBe("")
  })
})

describe("discoverPi", () => {
  it("surfaces both global prompt files even when absent, so they can be created", async () => {
    const files = await discoverPi(ctx())
    expect(files.map((f) => f.absPath)).toEqual([
      "/home/u/.pi/agent/SYSTEM.md",
      "/home/u/.pi/agent/APPEND_SYSTEM.md",
    ])
    expect(files.every((f) => f.exists === false)).toBe(true)
    expect(files.every((f) => f.agent === "pi")).toBe(true)
    expect(files.every((f) => f.scope === "global")).toBe(true)
  })

  it("reports size for a global file that exists", async () => {
    const files = await discoverPi(ctx({ fs: fsWith(["/home/u/.pi/agent/SYSTEM.md"]) }))
    const system = files.find((f) => f.absPath.endsWith("SYSTEM.md"))!
    expect(system.exists).toBe(true)
    expect(system.bytes).toBe(128)
  })

  it("distinguishes the replacing prompt from the appending one in its label", async () => {
    const files = await discoverPi(ctx())
    expect(files[0].label).toContain("system prompt")
    expect(files[1].label).toContain("suffix")
  })

  it("finds project prompt files under <root>/.pi, not the root itself", async () => {
    const files = await discoverPi(
      ctx({
        roots: ["/work/repo"],
        fs: fsWith(["/work/repo/.pi/SYSTEM.md"]),
      })
    )
    const project = files.filter((f) => f.scope === "project")
    expect(project).toHaveLength(1)
    expect(project[0].absPath).toBe("/work/repo/.pi/SYSTEM.md")
  })

  it("omits project files that do not exist", async () => {
    const files = await discoverPi(ctx({ roots: ["/work/repo"], fs: fsWith([]) }))
    expect(files.some((f) => f.scope === "project")).toBe(false)
  })

  it("does not emit the same path twice across overlapping roots", async () => {
    const files = await discoverPi(
      ctx({ roots: ["/work/repo", "/work/repo"], fs: fsWith(["/work/repo/.pi/SYSTEM.md"]) })
    )
    expect(files.filter((f) => f.absPath === "/work/repo/.pi/SYSTEM.md")).toHaveLength(1)
  })

  /**
   * Pi reads AGENTS.md and CLAUDE.md too, but the claude-code and codex
   * providers already own those paths. Emitting them here would only produce
   * duplicate rows attributed to a second agent.
   */
  it("never claims AGENTS.md or CLAUDE.md", async () => {
    const files = await discoverPi(
      ctx({
        roots: ["/work/repo"],
        fs: fsWith(["/work/repo/AGENTS.md", "/work/repo/CLAUDE.md"]),
      })
    )
    expect(files.some((f) => /AGENTS\.md|CLAUDE\.md/.test(f.absPath))).toBe(false)
  })

  it("emits nothing global when the agent dir cannot be resolved", async () => {
    const files = await discoverPi(ctx({ home: "" }))
    expect(files.some((f) => f.scope === "global")).toBe(false)
  })

  it("marks every file editable — Pi has no agent-managed memory store", async () => {
    const files = await discoverPi(ctx({ roots: ["/w"], fs: fsWith(["/w/.pi/SYSTEM.md"]) }))
    expect(files.every((f) => f.editable)).toBe(true)
  })
})
