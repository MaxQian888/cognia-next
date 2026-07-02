import path from "node:path"
import os from "node:os"
import nodeFs from "node:fs/promises"
import {
  loadCustomCommandDescriptors,
  registerCustomCommands,
  __resetCustomCommandsForTesting,
  type CommandFs,
} from "./custom-commands"
import type { CommandContext } from "./types"

const CWD = path.join(path.sep, "proj")
const HOME = path.join(path.sep, "home")
const claudeDir = (root: string) => path.join(root, ".claude", "commands")

/** Build an in-memory {@link CommandFs} from an absolute-path → content map. */
function memFs(files: Record<string, string>): CommandFs {
  const filePaths = new Set(Object.keys(files))
  const dirs = new Set<string>()
  for (const f of filePaths) {
    let d = path.dirname(f)
    while (d && !dirs.has(d)) {
      dirs.add(d)
      const parent = path.dirname(d)
      if (parent === d) break
      d = parent
    }
  }
  return {
    async exists(p) {
      return filePaths.has(p) || dirs.has(p)
    },
    async isDirectory(p) {
      return dirs.has(p)
    },
    async readDir(p) {
      const children = new Set<string>()
      for (const f of [...filePaths, ...dirs]) {
        if (path.dirname(f) === p) children.add(path.basename(f))
      }
      return [...children]
    },
    async readText(p) {
      if (!filePaths.has(p)) throw new Error(`no file: ${p}`)
      return files[p]
    },
  }
}

const ctx = (args: string): CommandContext => ({
  state: {} as CommandContext["state"],
  config: {} as CommandContext["config"],
  version: "0",
  args,
})

describe("loadCustomCommandDescriptors", () => {
  it("parses frontmatter (description, argument-hint) and the body template", async () => {
    const fs = memFs({
      [path.join(claudeDir(CWD), "review.md")]:
        "---\ndescription: Review code\nargument-hint: <file>\n---\nReview $1 carefully",
    })
    const [d] = await loadCustomCommandDescriptors({ cwd: CWD, osHome: HOME, fs })
    expect(d.name).toBe("review")
    expect(d.description).toBe("Review code")
    expect(d.argumentHint).toBe("<file>")
    expect(d.category).toBe("custom")
    expect(d.handler!(ctx("auth.ts"))).toEqual({ kind: "send", prompt: "Review auth.ts carefully" })
  })

  it("handles a body-only file with a default description and $ARGUMENTS", async () => {
    const fs = memFs({ [path.join(claudeDir(CWD), "note.md")]: "Take a note: $ARGUMENTS" })
    const [d] = await loadCustomCommandDescriptors({ cwd: CWD, osHome: HOME, fs })
    expect(d.description).toBe("(custom command)")
    expect(d.handler!(ctx("buy milk"))).toEqual({ kind: "send", prompt: "Take a note: buy milk" })
  })

  it("derives a slash-joined name from a nested path", async () => {
    const fs = memFs({
      [path.join(claudeDir(CWD), "frontend", "refactor.md")]: "refactor it",
    })
    const [d] = await loadCustomCommandDescriptors({ cwd: CWD, osHome: HOME, fs })
    expect(d.name).toBe("frontend/refactor")
  })

  it("hides commands flagged user-invocable:false or disable-model-invocation:true", async () => {
    const fs = memFs({
      [path.join(claudeDir(CWD), "hidden1.md")]: "---\nuser-invocable: false\n---\nx",
      [path.join(claudeDir(CWD), "hidden2.md")]: "---\ndisable-model-invocation: true\n---\ny",
      [path.join(claudeDir(CWD), "shown.md")]: "z",
    })
    const map = new Map(
      (await loadCustomCommandDescriptors({ cwd: CWD, osHome: HOME, fs })).map((d) => [d.name, d])
    )
    expect(map.get("hidden1")?.hidden).toBe(true)
    expect(map.get("hidden2")?.hidden).toBe(true)
    expect(map.get("shown")?.hidden).toBeUndefined()
  })

  it("prefers the project command over a user command of the same name", async () => {
    const fs = memFs({
      [path.join(claudeDir(CWD), "dup.md")]: "project body",
      [path.join(claudeDir(HOME), "dup.md")]: "user body",
    })
    const found = await loadCustomCommandDescriptors({ cwd: CWD, osHome: HOME, fs })
    const dup = found.filter((d) => d.name === "dup")
    expect(dup).toHaveLength(1)
    expect(dup[0].handler!(ctx("")).kind).toBe("send")
    expect((dup[0].handler!(ctx("")) as { prompt: string }).prompt).toBe("project body")
  })

  it("skips a file with malformed frontmatter without throwing", async () => {
    const fs = memFs({
      [path.join(claudeDir(CWD), "broken.md")]: "---\n: : not: valid: yaml\n  - [\n---\nbody",
      [path.join(claudeDir(CWD), "good.md")]: "ok",
    })
    const names = (await loadCustomCommandDescriptors({ cwd: CWD, osHome: HOME, fs })).map(
      (d) => d.name
    )
    expect(names).toContain("good")
  })

  it("skips an unreadable file without throwing", async () => {
    const base = memFs({
      [path.join(claudeDir(CWD), "reads.md")]: "ok",
      [path.join(claudeDir(CWD), "unreadable.md")]: "x",
    })
    const fs: CommandFs = {
      ...base,
      readText: async (p) => {
        if (p.endsWith("unreadable.md")) throw new Error("EACCES")
        return base.readText(p)
      },
    }
    const names = (await loadCustomCommandDescriptors({ cwd: CWD, osHome: HOME, fs })).map(
      (d) => d.name
    )
    expect(names).toEqual(["reads"])
  })

  it("discovers commands from disk with the default Node fs adapter", async () => {
    const root = await nodeFs.mkdtemp(path.join(os.tmpdir(), "cog-cmds-"))
    try {
      const dir = path.join(root, ".claude", "commands", "nested")
      await nodeFs.mkdir(dir, { recursive: true })
      await nodeFs.writeFile(
        path.join(dir, "hi.md"),
        "---\ndescription: Say hi\n---\nHello $1",
        "utf8"
      )
      const found = await loadCustomCommandDescriptors({
        cwd: root,
        osHome: path.join(root, "no-home"),
      })
      const cmd = found.find((d) => d.name === "nested/hi")!
      expect(cmd.description).toBe("Say hi")
      expect(cmd.handler!({ args: "there" } as CommandContext)).toEqual({
        kind: "send",
        prompt: "Hello there",
      })
    } finally {
      await nodeFs.rm(root, { recursive: true, force: true })
    }
  })
})

describe("registerCustomCommands", () => {
  beforeEach(() => __resetCustomCommandsForTesting())

  it("registers discovered commands and returns them", async () => {
    const fs = memFs({ [path.join(claudeDir(CWD), "hello.md")]: "hi" })
    const registered: string[] = []
    const added = await registerCustomCommands({
      cwd: CWD,
      osHome: HOME,
      fs,
      isTaken: () => false,
    })
    registered.push(...added.map((d) => d.name))
    // NOTE: registerCommand mutates the real registry; assert on the returned list.
    expect(registered).toContain("hello")
  })

  it("skips a command whose name collides with a built-in (never throws)", async () => {
    const fs = memFs({ [path.join(claudeDir(CWD), "goal.md")]: "hijack" })
    const added = await registerCustomCommands({
      cwd: CWD,
      osHome: HOME,
      fs,
      isTaken: (name) => name === "goal",
    })
    expect(added).toHaveLength(0)
  })

  it("is idempotent — a second call registers nothing", async () => {
    const fs = memFs({ [path.join(claudeDir(CWD), "once.md")]: "x" })
    await registerCustomCommands({ cwd: CWD, osHome: HOME, fs, isTaken: () => false })
    const second = await registerCustomCommands({
      cwd: CWD,
      osHome: HOME,
      fs,
      isTaken: () => false,
    })
    expect(second).toEqual([])
  })
})
