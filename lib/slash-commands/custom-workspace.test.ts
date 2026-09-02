// `jest.spyOn` on a namespace import is refused (read-only ESM namespace), so
// the default-deps test uses a partial module mock instead.
jest.mock("@/lib/files/workspace-fs", () => ({
  ...jest.requireActual("@/lib/files/workspace-fs"),
  walkWorkspace: jest.fn(async () => ({ entries: [], truncated: false, skippedSensitive: 0 })),
  writeWorkspaceFile: jest.fn(async () => undefined),
  deleteWorkspaceEntry: jest.fn(async () => undefined),
}))

import { deleteWorkspaceEntry, walkWorkspace, writeWorkspaceFile } from "@/lib/files/workspace-fs"

import {
  DEFAULT_PROJECT_COMMAND_DIR,
  PROJECT_COMMAND_DIRS,
  WORKSPACE_COMMAND_MAX_BYTES,
  deleteWorkspaceCustomCommand,
  listWorkspaceCustomCommands,
  parseWorkspaceCommandFile,
  saveWorkspaceCustomCommand,
  workspaceCommandRelPath,
  type WorkspaceCommandDeps,
} from "./custom-workspace"

type Files = Record<string, string>

function depsFor(files: Files, overrides: Partial<WorkspaceCommandDeps> = {}) {
  const written: Array<{ root: string; relPath: string; content: string }> = []
  const deleted: Array<{ root: string; relPath: string }> = []
  const deps: WorkspaceCommandDeps = {
    walk: async (_root, relPath) => {
      const entries = Object.keys(files)
        .filter((path) => path.startsWith(`${relPath}/`))
        .map((path) => ({ relPath: path, isDir: false }))
      if (entries.length === 0) throw new Error("directory not found")
      return { entries }
    },
    readFile: async (_root, relPath) => {
      const raw = files[relPath]
      if (raw === undefined) throw new Error(`missing ${relPath}`)
      return raw
    },
    writeFile: async (root, relPath, content) => {
      written.push({ root, relPath, content })
      files[relPath] = content
    },
    deleteEntry: async (root, relPath) => {
      deleted.push({ root, relPath })
      delete files[relPath]
    },
    ...overrides,
  }
  return { deps, written, deleted }
}

describe("parseWorkspaceCommandFile", () => {
  it("reads the same front-matter keys the Rust scanner does", () => {
    const command = parseWorkspaceCommandFile({
      name: "deploy",
      dir: ".claude/commands",
      filePath: ".claude/commands/deploy.md",
      raw: [
        "---",
        "description: Deploy the app",
        "argument-hint: <env>",
        "allowed-tools: [Bash, Read]",
        "model: claude-sonnet-4-5",
        "paths: [/srv]",
        "---",
        "",
        "deploy to $1",
        "",
      ].join("\n"),
    })
    expect(command).toMatchObject({
      name: "deploy",
      description: "Deploy the app",
      scope: "project",
      argumentHint: "<env>",
      allowedTools: ["Bash", "Read"],
      model: "claude-sonnet-4-5",
      paths: ["/srv"],
      originDir: ".claude/commands",
      hiddenFromPicker: false,
    })
    // Leading whitespace only, exactly what `collect_command_files` does with
    // `trim_start`. A body's trailing newline is part of the prompt.
    expect(command.template).toBe("deploy to $1\n")
  })

  it("falls back to the placeholder description and omits absent fields", () => {
    const command = parseWorkspaceCommandFile({
      name: "bare",
      dir: ".cognia/commands",
      filePath: ".cognia/commands/bare.md",
      raw: "just a body\n",
    })
    expect(command.description).toBe("(custom command)")
    expect(command.argumentHint).toBeUndefined()
    expect(command.allowedTools).toBeUndefined()
    expect(command.model).toBeUndefined()
    expect(command.hiddenFromPicker).toBe(false)
  })

  it("collapses both hide flags into hiddenFromPicker", () => {
    const hiddenByUser = parseWorkspaceCommandFile({
      name: "a",
      dir: ".claude/commands",
      filePath: "a.md",
      raw: "---\nuser-invocable: false\n---\n\nbody\n",
    })
    const hiddenByModel = parseWorkspaceCommandFile({
      name: "b",
      dir: ".claude/commands",
      filePath: "b.md",
      raw: "---\ndisable-model-invocation: true\n---\n\nbody\n",
    })
    expect(hiddenByUser.hiddenFromPicker).toBe(true)
    expect(hiddenByModel.hiddenFromPicker).toBe(true)
  })
})

describe("listWorkspaceCustomCommands", () => {
  it("walks both directories with .cognia shadowing .claude", async () => {
    const { deps } = depsFor({
      ".claude/commands/shadowed.md": "---\ndescription: from claude\n---\n\nclaude\n",
      ".cognia/commands/shadowed.md": "---\ndescription: from cognia\n---\n\ncognia\n",
      ".claude/commands/git/commit.md": "commit body\n",
      ".cognia/commands/only-cognia.md": "cognia only\n",
      ".claude/commands/notes.txt": "ignored",
    })
    const commands = await listWorkspaceCustomCommands("/repo", deps)
    expect(commands.map((c) => c.name)).toEqual(["git/commit", "only-cognia", "shadowed"])
    const shadowed = commands.find((c) => c.name === "shadowed")
    expect(shadowed?.description).toBe("from cognia")
    expect(shadowed?.originDir).toBe(".cognia/commands")
    expect(commands.find((c) => c.name === "git/commit")?.originDir).toBe(".claude/commands")
  })

  it("reads within the byte cap so a huge file cannot cross the pairing whole", async () => {
    const readFile = jest.fn(async () => "body\n")
    const { deps } = depsFor({ ".claude/commands/a.md": "body\n" }, { readFile })
    await listWorkspaceCustomCommands("/repo", deps)
    expect(readFile).toHaveBeenCalledWith(
      "/repo",
      ".claude/commands/a.md",
      WORKSPACE_COMMAND_MAX_BYTES
    )
  })

  it("returns [] for a blank root without touching the filesystem", async () => {
    const walk = jest.fn()
    const { deps } = depsFor({}, { walk })
    await expect(listWorkspaceCustomCommands("   ", deps)).resolves.toEqual([])
    await expect(listWorkspaceCustomCommands(null, deps)).resolves.toEqual([])
    expect(walk).not.toHaveBeenCalled()
  })

  it("keeps answering when one directory is missing or one file is unreadable", async () => {
    const { deps } = depsFor(
      {
        ".claude/commands/ok.md": "fine\n",
        ".claude/commands/broken.md": "unused",
      },
      {
        readFile: async (_root, relPath) => {
          if (relPath.endsWith("broken.md")) throw new Error("EACCES")
          return "fine\n"
        },
      }
    )
    const commands = await listWorkspaceCustomCommands("/repo", deps)
    expect(commands.map((c) => c.name)).toEqual(["ok"])
  })
})

describe("workspace writes", () => {
  it("defaults new commands to .claude/commands and honours an explicit dir", async () => {
    expect(workspaceCommandRelPath("deploy")).toBe(".claude/commands/deploy.md")
    expect(workspaceCommandRelPath("deploy", ".cognia/commands")).toBe(".cognia/commands/deploy.md")
    expect(DEFAULT_PROJECT_COMMAND_DIR).toBe(".claude/commands")
    // `.cognia` first, which is what makes it shadow `.claude` in the listing.
    expect(PROJECT_COMMAND_DIRS).toEqual([".cognia/commands", ".claude/commands"])
  })

  it("writes the file where the caller said", async () => {
    const { deps, written } = depsFor({})
    const relPath = await saveWorkspaceCustomCommand(
      { root: "/repo", name: "deploy", dir: ".cognia/commands", content: "body\n" },
      deps
    )
    expect(relPath).toBe(".cognia/commands/deploy.md")
    expect(written).toEqual([
      { root: "/repo", relPath: ".cognia/commands/deploy.md", content: "body\n" },
    ])
  })

  it("treats an already-gone file as a successful delete", async () => {
    const { deps } = depsFor(
      {},
      {
        deleteEntry: async () => {
          throw new Error("ENOENT: no such file")
        },
      }
    )
    await expect(
      deleteWorkspaceCustomCommand({ root: "/repo", name: "gone" }, deps)
    ).resolves.toBeUndefined()
  })

  it("propagates a real delete failure", async () => {
    const { deps } = depsFor(
      {},
      {
        deleteEntry: async () => {
          throw new Error("EACCES: permission denied")
        },
      }
    )
    await expect(deleteWorkspaceCustomCommand({ root: "/repo", name: "x" }, deps)).rejects.toThrow(
      /EACCES/
    )
  })
})

describe("default dependencies", () => {
  // The injected-deps pattern means every other test above stubs the seam, so
  // without this one the production path would never run.
  it("reach the workspace filesystem rather than the desktop scanner", async () => {
    await listWorkspaceCustomCommands("/repo")
    expect(walkWorkspace as jest.Mock).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ relPath: ".cognia/commands", includeIgnored: true })
    )
    await saveWorkspaceCustomCommand({ root: "/repo", name: "a", content: "b" })
    expect(writeWorkspaceFile as jest.Mock).toHaveBeenCalledWith(
      "/repo",
      ".claude/commands/a.md",
      "b"
    )
    await deleteWorkspaceCustomCommand({ root: "/repo", name: "a" })
    expect(deleteWorkspaceEntry as jest.Mock).toHaveBeenCalledWith("/repo", ".claude/commands/a.md")
  })
})
