import { parseArgs, runConvertCli, runMain, type ConvertIo } from "./cli"

const MCP_CONFIG = JSON.stringify({
  mcpServers: {
    playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
    github: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "ghp_live_secret" },
    },
  },
})

const SKILL_MD = `---
name: Code Review
description: Review a diff.
---

Read the diff, report findings.
`

/** In-memory ConvertIo. Directories are implied by file paths. */
function makeIo(
  seed: Record<string, string> = {},
  dirs: string[] = []
): ConvertIo & {
  files: Map<string, string>
  copies: Array<[string, string]>
} {
  const files = new Map<string, string>(Object.entries(seed))
  const explicitDirs = new Set(dirs)
  const copies: Array<[string, string]> = []

  const isDir = (path: string): boolean => {
    if (explicitDirs.has(path)) return true
    const prefix = `${path}/`
    for (const key of files.keys()) if (key.startsWith(prefix)) return true
    return false
  }

  return {
    files,
    copies,
    readFile: (path) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`ENOENT ${path}`)
      return value
    },
    writeFile: (path, contents) => {
      files.set(path, contents)
    },
    copyFile: (from, to) => {
      copies.push([from, to])
      files.set(to, files.get(from) ?? "")
    },
    mkdirp: (path) => {
      explicitDirs.add(path)
    },
    exists: (path) => files.has(path) || isDir(path),
    isDirectory: isDir,
    readDir: (path) => {
      const prefix = `${path}/`
      const names = new Set<string>()
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0])
      }
      return [...names]
    },
    listFiles: (path) => {
      const prefix = `${path}/`
      return [...files.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
    },
    join: (...segments) =>
      segments
        .filter(Boolean)
        .join("/")
        .replace(/\/{2,}/g, "/"),
    basename: (path) => path.split("/").filter(Boolean).pop() ?? path,
    resolve: (path) => (path.startsWith("/") ? path : `/work/${path}`),
    gitAuthor: () => "Ada",
  }
}

describe("parseArgs", () => {
  it("parses the required flags", () => {
    const args = parseArgs(["--from", "mcp", "--input", "/a/mcp.json", "--pick", "github"])
    expect(args).toMatchObject({ from: "mcp", input: "/a/mcp.json", pick: "github", list: false })
  })

  it("collects identity overrides", () => {
    const args = parseArgs([
      "--from",
      "cli",
      "--input",
      "rg",
      "--id",
      "my.id",
      "--plugin-version",
      "2.0.0",
      "--author-email",
      "a@b.c",
    ])
    expect(args.identity).toMatchObject({
      id: "my.id",
      version: "2.0.0",
      authorEmail: "a@b.c",
    })
  })

  it("recognises --list as a boolean", () => {
    expect(parseArgs(["--from", "mcp", "--input", "/a", "--list"]).list).toBe(true)
  })

  it.each([
    [["--input", "/a"], /--from is required/],
    [["--from", "mcp"], /--input is required/],
    [["--from", "nope", "--input", "/a"], /--from must be one of/],
    [["--from", "mcp", "--input", "/a", "--bogus", "x"], /unknown option: --bogus/],
    [["--from", "mcp", "--input"], /missing value for --input/],
    [["--from", "mcp", "--input", "--pick"], /missing value for --input/],
  ])("rejects %j", (argv, pattern) => {
    expect(() => parseArgs(argv as string[])).toThrow(pattern as RegExp)
  })
})

describe("runConvertCli — listing", () => {
  it("lists MCP candidates without writing anything", () => {
    const io = makeIo({ "/a/mcp.json": MCP_CONFIG })
    const out = runConvertCli(["--from", "mcp", "--input", "/a/mcp.json", "--list"], io)
    expect(out).toEqual({
      ok: true,
      mode: "list",
      candidates: [
        { id: "playwright", label: "playwright", detail: "stdio · npx" },
        { id: "github", label: "github", detail: "stdio · npx" },
      ],
    })
    expect(io.files.size).toBe(1)
  })
})

describe("runConvertCli — greenfield", () => {
  it("writes a complete project under the derived plugin id", () => {
    const io = makeIo({ "/a/mcp.json": MCP_CONFIG })
    const out = runConvertCli(["--from", "mcp", "--input", "/a/mcp.json", "--pick", "github"], io)
    expect(out.ok).toBe(true)
    expect(out.pluginId).toBe("github-mcp")
    expect(out.dir).toBe("/work/github-mcp")
    expect(out.files).toEqual([
      ".gitignore",
      "README.md",
      "dist/index.js",
      "package.json",
      "plugin.json",
      "src/index.ts",
      "tsconfig.json",
    ])
    expect(io.files.get("/work/github-mcp/plugin.json")).toContain('"mcpServerPresets"')
    expect(out.buildTarget).toBe("dist/index.js")
  })

  it("uses the git author when the manifest does not override it", () => {
    const io = makeIo({ "/a/mcp.json": MCP_CONFIG })
    runConvertCli(["--from", "mcp", "--input", "/a/mcp.json", "--pick", "github"], io)
    expect(io.files.get("/work/github-mcp/plugin.json")).toContain('"Ada"')
  })

  it("honours --dir", () => {
    const io = makeIo({ "/a/mcp.json": MCP_CONFIG })
    const out = runConvertCli(
      ["--from", "mcp", "--input", "/a/mcp.json", "--pick", "github", "--dir", "/out/here"],
      io
    )
    expect(out.dir).toBe("/out/here")
    expect(io.files.has("/out/here/plugin.json")).toBe(true)
  })

  it("refuses to write into a directory that already holds files", () => {
    const io = makeIo({ "/a/mcp.json": MCP_CONFIG, "/work/github-mcp/README.md": "mine" })
    expect(() =>
      runConvertCli(["--from", "mcp", "--input", "/a/mcp.json", "--pick", "github"], io)
    ).toThrow(/is not empty/)
  })

  it("does not require --pick when the input holds exactly one candidate", () => {
    const io = makeIo({ "/skills/cr/SKILL.md": SKILL_MD })
    const out = runConvertCli(["--from", "skill", "--input", "/skills/cr"], io)
    expect(out.pluginId).toBe("code-review-skill")
  })

  it("still requires --pick when the input holds several", () => {
    const io = makeIo({ "/a/mcp.json": MCP_CONFIG })
    expect(() => runConvertCli(["--from", "mcp", "--input", "/a/mcp.json"], io)).toThrow(
      /--pick is required/
    )
  })
})

describe("runConvertCli — skill inputs", () => {
  it("accepts the SKILL.md file directly", () => {
    const io = makeIo({ "/skills/cr/SKILL.md": SKILL_MD })
    const out = runConvertCli(["--from", "skill", "--input", "/skills/cr/SKILL.md"], io)
    expect(out.pluginId).toBe("code-review-skill")
  })

  it("copies sibling resources into the plugin and reports them", () => {
    const io = makeIo({
      "/skills/cr/SKILL.md": SKILL_MD,
      "/skills/cr/references/checklist.md": "- check",
    })
    const out = runConvertCli(["--from", "skill", "--input", "/skills/cr"], io)
    expect(io.copies).toEqual([
      ["/skills/cr/SKILL.md", "/work/code-review-skill/skills/code-review/SKILL.md"],
      [
        "/skills/cr/references/checklist.md",
        "/work/code-review-skill/skills/code-review/references/checklist.md",
      ],
    ])
    expect(out.files).toContain("skills/code-review/references/checklist.md")
  })

  it("reports a folder with no SKILL.md instead of guessing", () => {
    const io = makeIo({ "/skills/cr/notes.txt": "x" })
    expect(() => runConvertCli(["--from", "skill", "--input", "/skills/cr"], io)).toThrow(
      /no SKILL\.md in/
    )
  })
})

describe("runConvertCli — cli inputs", () => {
  it("never touches the filesystem for the binary", () => {
    const io = makeIo()
    const out = runConvertCli(["--from", "cli", "--input", "rg"], io)
    expect(out.pluginId).toBe("rg-tools")
    expect(io.files.has("/work/rg-tools/plugin.json")).toBe(true)
  })
})

describe("runConvertCli — --into", () => {
  const existing = JSON.stringify({
    id: "my-plugin",
    name: "My Plugin",
    version: "1.2.3",
    description: "Existing.",
    type: "frontend",
    capabilities: ["commands"],
    main: "dist/index.js",
  })

  it("rewrites only the target plugin.json", () => {
    const io = makeIo({
      "/a/mcp.json": MCP_CONFIG,
      "/plugins/mine/plugin.json": existing,
      "/plugins/mine/src/index.ts": "// untouched",
    })
    const out = runConvertCli(
      [
        "--from",
        "mcp",
        "--input",
        "/a/mcp.json",
        "--pick",
        "playwright",
        "--into",
        "/plugins/mine",
      ],
      io
    )
    expect(out.mode).toBe("merge")
    expect(out.pluginId).toBe("my-plugin")
    expect(out.files).toEqual(["plugin.json"])
    expect(io.files.get("/plugins/mine/src/index.ts")).toBe("// untouched")
    const manifest = JSON.parse(io.files.get("/plugins/mine/plugin.json")!)
    expect(manifest.version).toBe("1.2.3")
    expect(manifest.capabilities).toEqual(["commands", "mcp-server-preset"])
  })

  it("reports a target that is not a plugin directory", () => {
    const io = makeIo({ "/a/mcp.json": MCP_CONFIG }, ["/plugins/empty"])
    expect(() =>
      runConvertCli(
        [
          "--from",
          "mcp",
          "--input",
          "/a/mcp.json",
          "--pick",
          "playwright",
          "--into",
          "/plugins/empty",
        ],
        io
      )
    ).toThrow(/plugin\.json not found/)
  })

  it("copies a bundled skill's resources into the existing plugin", () => {
    const io = makeIo({
      "/skills/cr/SKILL.md": SKILL_MD,
      "/skills/cr/scripts/run.sh": "#!/bin/sh",
      "/plugins/mine/plugin.json": existing,
    })
    const out = runConvertCli(
      ["--from", "skill", "--input", "/skills/cr", "--into", "/plugins/mine"],
      io
    )
    expect(out.files).toEqual([
      "plugin.json",
      "skills/code-review/SKILL.md",
      "skills/code-review/scripts/run.sh",
    ])
  })
})

describe("runMain", () => {
  it("emits a single JSON object and exit code 0 on success", () => {
    const io = makeIo({ "/a/mcp.json": MCP_CONFIG })
    const { output, exitCode } = runMain(
      ["--from", "mcp", "--input", "/a/mcp.json", "--pick", "github"],
      io
    )
    expect(exitCode).toBe(0)
    expect(JSON.parse(output).ok).toBe(true)
  })

  it("reports failures in the same JSON shape with a non-zero exit", () => {
    const io = makeIo()
    const { output, exitCode } = runMain(["--from", "mcp", "--input", "/missing.json"], io)
    expect(exitCode).toBe(1)
    expect(JSON.parse(output)).toEqual({
      ok: false,
      error: expect.stringContaining("no such file or directory"),
    })
  })

  it("never writes prose to stdout, so the protocol cannot be corrupted", () => {
    const io = makeIo()
    const { output } = runMain(["--bogus"], io)
    expect(() => JSON.parse(output)).not.toThrow()
  })

  it("leaks no credential into the machine-readable output", () => {
    const io = makeIo({ "/a/mcp.json": MCP_CONFIG })
    const { output } = runMain(["--from", "mcp", "--input", "/a/mcp.json", "--pick", "github"], io)
    expect(output).not.toContain("ghp_live_secret")
  })
})
