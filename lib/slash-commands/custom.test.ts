import { invoke } from "@tauri-apps/api/core"

// Mock the Tauri filesystem helpers before importing the module under test —
// the save / delete entry points dynamically `import("@tauri-apps/plugin-fs")`.
const mockMkdir = jest.fn().mockResolvedValue(undefined)
const mockWriteTextFile = jest.fn().mockResolvedValue(undefined)
const mockRemove = jest.fn().mockResolvedValue(undefined)

jest.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeTextFile: (...args: unknown[]) => mockWriteTextFile(...args),
  remove: (...args: unknown[]) => mockRemove(...args),
  BaseDirectory: { Home: 1 },
}))

const mockHomeDir = jest.fn().mockResolvedValue("/Users/me")
const mockJoin = jest.fn(async (...parts: string[]) => parts.join("/"))
const mockDirname = jest.fn(async (path: string) => path.replace(/\/[^/]+$/, ""))

jest.mock("@tauri-apps/api/path", () => ({
  homeDir: () => mockHomeDir(),
  join: (...args: unknown[]) => mockJoin(...(args as string[])),
  dirname: (path: string) => mockDirname(path),
}))

// The workspace fallback. Partial-actual so the shared constants
// (`DEFAULT_PROJECT_COMMAND_DIR`) that `custom.ts` imports are the real ones.
jest.mock("./custom-workspace", () => ({
  ...jest.requireActual("./custom-workspace"),
  listWorkspaceCustomCommands: jest.fn(async () => []),
  saveWorkspaceCustomCommand: jest.fn(async () => ".claude/commands/x.md"),
  deleteWorkspaceCustomCommand: jest.fn(async () => undefined),
}))

import {
  GlobalScopeUnavailableError,
  applyTemplate,
  assertValidCommandName,
  buildCommandFile,
  deleteCustomSlashCommand,
  loadCustomSlashCommands,
  projectCommandDirOf,
  resolveCommandPath,
  saveCustomSlashCommand,
} from "./custom"
import {
  deleteWorkspaceCustomCommand,
  listWorkspaceCustomCommands,
  saveWorkspaceCustomCommand,
} from "./custom-workspace"

const mockedListWorkspace = listWorkspaceCustomCommands as jest.Mock
const mockedSaveWorkspace = saveWorkspaceCustomCommand as jest.Mock
const mockedDeleteWorkspace = deleteWorkspaceCustomCommand as jest.Mock

/** What `invoke` / `plugin-fs` reject with when there is no desktop process. */
const NO_HOST = () => new Error("Cannot read properties of undefined (reading 'invoke')")

const mockedInvoke = invoke as unknown as jest.Mock

beforeEach(() => {
  mockedInvoke.mockReset()
  mockMkdir.mockReset().mockResolvedValue(undefined)
  mockWriteTextFile.mockReset().mockResolvedValue(undefined)
  mockRemove.mockReset().mockResolvedValue(undefined)
  mockHomeDir.mockReset().mockResolvedValue("/Users/me")
  mockJoin.mockClear()
  mockDirname.mockClear()
  mockedListWorkspace.mockReset().mockResolvedValue([])
  mockedSaveWorkspace.mockReset().mockResolvedValue(".claude/commands/x.md")
  mockedDeleteWorkspace.mockReset().mockResolvedValue(undefined)
})

describe("loadCustomSlashCommands", () => {
  it("returns [] without browser logging when invoke throws in Node", async () => {
    const consoleSpy = jest.spyOn(console, "debug").mockImplementation(() => {})
    mockedInvoke.mockRejectedValue(new Error("not Tauri"))
    const out = await loadCustomSlashCommands(null)
    expect(out).toEqual([])
    expect(consoleSpy).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it("converts each raw row into a SlashCommand", async () => {
    mockedInvoke.mockResolvedValue([
      {
        name: "deploy",
        scope: "project",
        path: "/proj/.claude/commands/deploy.md",
        description: "Deploy the app",
        argumentHint: "<env>",
        allowedTools: ["bash"],
        model: "claude-3-opus",
        paths: ["/p"],
        disableModelInvocation: null,
        userInvocable: null,
        body: "deploy to $1",
      },
    ])
    const out = await loadCustomSlashCommands("/proj")
    expect(mockedInvoke).toHaveBeenCalledWith("slash_commands_scan", { cwd: "/proj" })
    expect(out).toEqual([
      {
        name: "deploy",
        description: "Deploy the app",
        scope: "project",
        argumentHint: "<env>",
        template: "deploy to $1",
        filePath: "/proj/.claude/commands/deploy.md",
        model: "claude-3-opus",
        allowedTools: ["bash"],
        paths: ["/p"],
        hiddenFromPicker: false,
      },
    ])
  })

  it("falls back to user scope and (custom command) description for unknown scope/null fields", async () => {
    mockedInvoke.mockResolvedValue([
      {
        name: "x",
        scope: "unrecognised",
        path: "/p",
        description: null,
        argumentHint: null,
        allowedTools: null,
        model: null,
        paths: null,
        disableModelInvocation: null,
        userInvocable: null,
        body: "body",
      },
    ])
    const out = await loadCustomSlashCommands(null)
    expect(out[0].scope).toBe("user")
    expect(out[0].description).toBe("(custom command)")
    expect(out[0].argumentHint).toBeUndefined()
    expect(out[0].allowedTools).toBeUndefined()
    expect(out[0].model).toBeUndefined()
    expect(out[0].paths).toBeUndefined()
    expect(out[0].hiddenFromPicker).toBe(false)
  })

  it("preserves explicit user scope mapping", async () => {
    mockedInvoke.mockResolvedValue([
      {
        name: "u",
        scope: "user",
        path: "/p",
        description: "d",
        argumentHint: null,
        allowedTools: null,
        model: null,
        paths: null,
        disableModelInvocation: null,
        userInvocable: null,
        body: "b",
      },
    ])
    const out = await loadCustomSlashCommands(undefined)
    expect(out[0].scope).toBe("user")
  })

  it("hides commands when userInvocable is false", async () => {
    mockedInvoke.mockResolvedValue([
      {
        name: "h",
        scope: "user",
        path: "/p",
        description: "d",
        argumentHint: null,
        allowedTools: null,
        model: null,
        paths: null,
        disableModelInvocation: null,
        userInvocable: false,
        body: "b",
      },
    ])
    const out = await loadCustomSlashCommands(null)
    expect(out[0].hiddenFromPicker).toBe(true)
  })

  it("hides commands when disableModelInvocation is true", async () => {
    mockedInvoke.mockResolvedValue([
      {
        name: "h",
        scope: "user",
        path: "/p",
        description: "d",
        argumentHint: null,
        allowedTools: null,
        model: null,
        paths: null,
        disableModelInvocation: true,
        userInvocable: null,
        body: "b",
      },
    ])
    const out = await loadCustomSlashCommands(null)
    expect(out[0].hiddenFromPicker).toBe(true)
  })
})

describe("custom re-exports applyTemplate", () => {
  it("re-exports the same applyTemplate", () => {
    expect(applyTemplate("$1", "x")).toBe("x")
  })
})

describe("assertValidCommandName", () => {
  it("accepts ASCII names with allowed punctuation", () => {
    expect(() => assertValidCommandName("refactor")).not.toThrow()
    expect(() => assertValidCommandName("git/commit")).not.toThrow()
    expect(() => assertValidCommandName("plan-mode_v2.1")).not.toThrow()
  })

  it("rejects empty / over-long / unsafe names", () => {
    expect(() => assertValidCommandName("")).toThrow()
    expect(() => assertValidCommandName("a".repeat(70))).toThrow()
    expect(() => assertValidCommandName("../escape")).toThrow()
    expect(() => assertValidCommandName("has space")).toThrow()
    expect(() => assertValidCommandName("../../etc/passwd")).toThrow()
    expect(() => assertValidCommandName("-leading")).toThrow()
  })
})

describe("buildCommandFile", () => {
  it("emits an empty frontmatter when no metadata is set", () => {
    const out = buildCommandFile({ scope: "user", name: "x", body: "hello" })
    expect(out).toBe("hello\n")
    expect(out).not.toMatch(/^---/)
  })

  it("serialises every metadata field", () => {
    const out = buildCommandFile({
      scope: "user",
      name: "deploy",
      description: "Deploy the app",
      argumentHint: "<env>",
      allowedTools: ["Bash", "Read"],
      model: "claude-sonnet-4-5",
      body: "deploy to $1",
    })
    expect(out).toContain("description: Deploy the app")
    expect(out).toContain("argument-hint: <env>")
    expect(out).toContain("allowed-tools: [Bash, Read]")
    expect(out).toContain("model: claude-sonnet-4-5")
    expect(out.startsWith("---\n")).toBe(true)
    expect(out.trimEnd().endsWith("deploy to $1")).toBe(true)
  })

  it("quotes scalars with reserved characters", () => {
    const out = buildCommandFile({
      scope: "user",
      name: "x",
      description: 'has "quotes" and: a colon',
      body: "b",
    })
    expect(out).toMatch(/description: ".*"/)
  })

  it("trims trailing whitespace on the body and preserves $1 / $ARGUMENTS", () => {
    const out = buildCommandFile({
      scope: "user",
      name: "x",
      description: "d",
      body: "first $1\nsecond $ARGUMENTS\n\n",
    })
    expect(out).toContain("first $1")
    expect(out).toContain("second $ARGUMENTS")
    expect(out.endsWith("\n")).toBe(true)
  })

  it("filters empty allowed-tools entries", () => {
    const out = buildCommandFile({
      scope: "user",
      name: "x",
      allowedTools: ["Bash", "  ", "", "Read"],
      body: "b",
    })
    expect(out).toContain("allowed-tools: [Bash, Read]")
  })
})

describe("resolveCommandPath", () => {
  it("uses the home dir for user-scope commands", async () => {
    const path = await resolveCommandPath("user", "refactor", null)
    expect(mockHomeDir).toHaveBeenCalled()
    expect(path).toBe("/Users/me/.claude/commands/refactor.md")
  })

  it("uses the cwd for project-scope commands", async () => {
    const path = await resolveCommandPath("project", "deploy", "/work/repo")
    expect(path).toBe("/work/repo/.claude/commands/deploy.md")
  })

  it("throws when project scope has no cwd", async () => {
    await expect(resolveCommandPath("project", "x", null)).rejects.toThrow(/working directory/)
  })

  it("validates the name before resolving", async () => {
    await expect(resolveCommandPath("user", "../escape", null)).rejects.toThrow()
  })
})

describe("saveCustomSlashCommand", () => {
  it("creates the directory then writes the file", async () => {
    const path = await saveCustomSlashCommand({
      scope: "user",
      name: "refactor",
      description: "Refactor",
      body: "Refactor $ARGUMENTS",
    })
    expect(path).toBe("/Users/me/.claude/commands/refactor.md")
    expect(mockMkdir).toHaveBeenCalledWith(
      "/Users/me/.claude/commands",
      expect.objectContaining({ recursive: true })
    )
    expect(mockWriteTextFile).toHaveBeenCalledTimes(1)
    const [writePath, content] = mockWriteTextFile.mock.calls[0] as [string, string]
    expect(writePath).toBe("/Users/me/.claude/commands/refactor.md")
    expect(content).toContain("description: Refactor")
    expect(content).toContain("Refactor $ARGUMENTS")
  })

  it("tolerates EEXIST from mkdir on older plugin-fs builds", async () => {
    mockMkdir.mockRejectedValueOnce(new Error("EEXIST: already exists"))
    await saveCustomSlashCommand({ scope: "user", name: "x", body: "b" })
    expect(mockWriteTextFile).toHaveBeenCalled()
  })

  it("propagates non-EEXIST mkdir errors", async () => {
    mockMkdir.mockRejectedValueOnce(new Error("EACCES: permission denied"))
    await expect(saveCustomSlashCommand({ scope: "user", name: "x", body: "b" })).rejects.toThrow(
      /permission denied/
    )
    expect(mockWriteTextFile).not.toHaveBeenCalled()
  })

  it("rejects an invalid name before any IO", async () => {
    await expect(
      saveCustomSlashCommand({ scope: "user", name: "../bad", body: "b" })
    ).rejects.toThrow()
    expect(mockMkdir).not.toHaveBeenCalled()
    expect(mockWriteTextFile).not.toHaveBeenCalled()
  })

  it("project scope writes under cwd", async () => {
    const path = await saveCustomSlashCommand({
      scope: "project",
      name: "deploy",
      cwd: "/work/repo",
      body: "deploy",
    })
    expect(path).toBe("/work/repo/.claude/commands/deploy.md")
  })
})

describe("deleteCustomSlashCommand", () => {
  it("removes the file via plugin-fs", async () => {
    await deleteCustomSlashCommand({ scope: "user", name: "refactor" })
    expect(mockRemove).toHaveBeenCalledWith("/Users/me/.claude/commands/refactor.md")
  })

  it("swallows ENOENT — already-gone files are fine", async () => {
    mockRemove.mockRejectedValueOnce(new Error("ENOENT: no such file"))
    await expect(
      deleteCustomSlashCommand({ scope: "user", name: "refactor" })
    ).resolves.toBeUndefined()
  })

  it("propagates other errors", async () => {
    mockRemove.mockRejectedValueOnce(new Error("EACCES"))
    await expect(deleteCustomSlashCommand({ scope: "user", name: "refactor" })).rejects.toThrow(
      /EACCES/
    )
  })
})

// ---------------------------------------------------------------------------
// Off-desktop routing. The local scanner and `plugin-fs` are `target: "client"`
// and simply do not exist on a paired browser or phone, so the project scope
// falls through to the workspace filesystem and the global scope refuses.
// ---------------------------------------------------------------------------

describe("loadCustomSlashCommands off the desktop", () => {
  it("falls through to the workspace scan when the local scanner is unreachable", async () => {
    jest.spyOn(console, "debug").mockImplementation(() => {})
    mockedInvoke.mockRejectedValue(NO_HOST())
    mockedListWorkspace.mockResolvedValue([
      { name: "deploy", description: "d", scope: "project", originDir: ".cognia/commands" },
    ])
    const out = await loadCustomSlashCommands("/repo")
    expect(mockedListWorkspace).toHaveBeenCalledWith("/repo")
    expect(out).toEqual([
      { name: "deploy", description: "d", scope: "project", originDir: ".cognia/commands" },
    ])
    ;(console.debug as jest.Mock).mockRestore()
  })

  it("does not try the workspace when there is no working directory", async () => {
    jest.spyOn(console, "debug").mockImplementation(() => {})
    mockedInvoke.mockRejectedValue(NO_HOST())
    await expect(loadCustomSlashCommands(null)).resolves.toEqual([])
    expect(mockedListWorkspace).not.toHaveBeenCalled()
    ;(console.debug as jest.Mock).mockRestore()
  })

  it("prefers the local scanner when it answers, because only it sees the global scope", async () => {
    mockedInvoke.mockResolvedValue([])
    await loadCustomSlashCommands("/repo")
    expect(mockedListWorkspace).not.toHaveBeenCalled()
  })

  it("carries the host's originDir through so an edit goes back where it came from", async () => {
    mockedInvoke.mockResolvedValue([
      {
        name: "deploy",
        scope: "project",
        path: "/repo/.cognia/commands/deploy.md",
        originDir: "/repo/.cognia/commands",
        description: null,
        argumentHint: null,
        allowedTools: null,
        model: null,
        paths: null,
        disableModelInvocation: null,
        userInvocable: null,
        body: "b",
      },
    ])
    const [command] = await loadCustomSlashCommands("/repo")
    expect(command.originDir).toBe("/repo/.cognia/commands")
    expect(projectCommandDirOf(command.originDir)).toBe(".cognia/commands")
  })
})

describe("projectCommandDirOf", () => {
  it("recognises .cognia and defaults everything else to .claude", () => {
    expect(projectCommandDirOf("/repo/.cognia/commands")).toBe(".cognia/commands")
    expect(projectCommandDirOf("C:\\repo\\.cognia\\commands")).toBe(".cognia/commands")
    expect(projectCommandDirOf("/repo/.claude/commands")).toBe(".claude/commands")
    expect(projectCommandDirOf(undefined)).toBe(".claude/commands")
    expect(projectCommandDirOf(null)).toBe(".claude/commands")
  })
})

describe("resolveCommandPath with an explicit directory", () => {
  it("writes a project command into the directory it came from", async () => {
    await expect(
      resolveCommandPath("project", "deploy", "/repo", ".cognia/commands")
    ).resolves.toBe("/repo/.cognia/commands/deploy.md")
  })

  it("ignores the directory for user scope, which has only one", async () => {
    await expect(resolveCommandPath("user", "deploy", null, ".cognia/commands")).resolves.toBe(
      "/Users/me/.claude/commands/deploy.md"
    )
  })
})

describe("saveCustomSlashCommand off the desktop", () => {
  it("writes a project command through the workspace filesystem", async () => {
    mockMkdir.mockRejectedValueOnce(NO_HOST())
    const path = await saveCustomSlashCommand({
      scope: "project",
      name: "deploy",
      cwd: "/repo",
      dir: ".cognia/commands",
      body: "body",
    })
    expect(path).toBe(".claude/commands/x.md")
    expect(mockedSaveWorkspace).toHaveBeenCalledWith({
      root: "/repo",
      name: "deploy",
      dir: ".cognia/commands",
      content: expect.stringContaining("body"),
    })
    expect(mockWriteTextFile).not.toHaveBeenCalled()
  })

  it("refuses the user scope with a reason instead of writing it somewhere else", async () => {
    mockMkdir.mockRejectedValueOnce(NO_HOST())
    await expect(
      saveCustomSlashCommand({ scope: "user", name: "deploy", body: "body" })
    ).rejects.toBeInstanceOf(GlobalScopeUnavailableError)
    expect(mockedSaveWorkspace).not.toHaveBeenCalled()
  })

  it("still propagates a real write failure rather than writing elsewhere", async () => {
    mockMkdir.mockRejectedValueOnce(new Error("EACCES: permission denied"))
    await expect(
      saveCustomSlashCommand({ scope: "project", name: "deploy", cwd: "/repo", body: "b" })
    ).rejects.toThrow(/permission denied/)
    expect(mockedSaveWorkspace).not.toHaveBeenCalled()
  })
})

describe("deleteCustomSlashCommand off the desktop", () => {
  it("deletes a project command through the workspace filesystem", async () => {
    mockRemove.mockRejectedValueOnce(NO_HOST())
    await deleteCustomSlashCommand({
      scope: "project",
      name: "deploy",
      cwd: "/repo",
      dir: ".cognia/commands",
    })
    expect(mockedDeleteWorkspace).toHaveBeenCalledWith({
      root: "/repo",
      name: "deploy",
      dir: ".cognia/commands",
    })
  })

  it("refuses the user scope with a reason", async () => {
    mockRemove.mockRejectedValueOnce(NO_HOST())
    await expect(
      deleteCustomSlashCommand({ scope: "user", name: "deploy" })
    ).rejects.toBeInstanceOf(GlobalScopeUnavailableError)
    expect(mockedDeleteWorkspace).not.toHaveBeenCalled()
  })
})
