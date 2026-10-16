import Ajv from "ajv"
import responseSchemas from "@/protocol/companion-response-schemas.json"
import { transport } from "@/lib/tauri"
import {
  copyWorkspaceEntry,
  createWorkspaceDir,
  deleteWorkspaceEntry,
  listWorkspaceDir,
  listWorkspaceRoots,
  isWorkspaceFileConflict,
  readWorkspaceFile,
  readWorkspaceFileBase64,
  readWorkspaceFileChunk,
  readWorkspaceFileVersioned,
  renameWorkspaceEntry,
  searchWorkspaceContent,
  statWorkspaceFile,
  writeWorkspaceFile,
  writeWorkspaceFileChecked,
  WorkspaceFileConflictError,
} from "./workspace-fs"
import { CompanionError } from "@/lib/tauri/transport-companion"

afterEach(() => {
  jest.restoreAllMocks()
})

describe("searchWorkspaceContent", () => {
  it("forwards options and maps raw matches", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce([
      {
        rel_path: "src/a.ts",
        absolute_path: "/repo/src/a.ts",
        line: 2,
        column: 7,
        preview: "const needle = 2",
      },
    ])
    const out = await searchWorkspaceContent("/repo", "needle", {
      isRegex: true,
      caseSensitive: false,
      maxResults: 100,
    })
    expect(callSpy).toHaveBeenCalledWith("fs_search_content_workspace", {
      root: "/repo",
      query: "needle",
      isRegex: true,
      caseSensitive: false,
      maxResults: 100,
    })
    expect(out).toEqual([
      {
        relPath: "src/a.ts",
        absolutePath: "/repo/src/a.ts",
        line: 2,
        column: 7,
        preview: "const needle = 2",
      },
    ])
  })

  it("defaults options to undefined", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce([])
    await searchWorkspaceContent("/repo", "x")
    expect(callSpy).toHaveBeenCalledWith("fs_search_content_workspace", {
      root: "/repo",
      query: "x",
      isRegex: undefined,
      caseSensitive: undefined,
      maxResults: undefined,
    })
  })
})

describe("listWorkspaceDir", () => {
  it("maps raw entries and forwards root/relPath/includeIgnored", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce([
      {
        rel_path: "src",
        absolute_path: "/repo/src",
        is_dir: true,
        size: 0,
        mtime_ms: 111,
      },
      {
        rel_path: "src/a.ts",
        absolute_path: "/repo/src/a.ts",
        is_dir: false,
        size: 12,
      },
    ])
    const out = await listWorkspaceDir("/repo", "src", true)
    expect(callSpy).toHaveBeenCalledWith("fs_list_workspace_dir", {
      root: "/repo",
      relPath: "src",
      includeIgnored: true,
    })
    expect(out).toEqual([
      { relPath: "src", absolutePath: "/repo/src", isDir: true, size: 0, mtimeMs: 111 },
      {
        relPath: "src/a.ts",
        absolutePath: "/repo/src/a.ts",
        isDir: false,
        size: 12,
        mtimeMs: null,
      },
    ])
  })

  it("omits relPath/includeIgnored when not provided", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce([])
    await listWorkspaceDir("/repo")
    expect(callSpy).toHaveBeenCalledWith("fs_list_workspace_dir", {
      root: "/repo",
      relPath: undefined,
      includeIgnored: undefined,
    })
  })
})

describe("statWorkspaceFile", () => {
  it("maps an existing-file stat", async () => {
    const callSpy = jest
      .spyOn(transport, "call")
      .mockResolvedValueOnce({ exists: true, is_dir: false, size: 5, mtime_ms: 999 })
    const out = await statWorkspaceFile("/repo", "a.txt")
    expect(callSpy).toHaveBeenCalledWith("fs_stat_workspace_file", {
      root: "/repo",
      relPath: "a.txt",
    })
    expect(out).toEqual({ exists: true, isDir: false, size: 5, mtimeMs: 999 })
  })

  it("maps a missing path without throwing", async () => {
    jest.spyOn(transport, "call").mockResolvedValueOnce({ exists: false, is_dir: false, size: 0 })
    await expect(statWorkspaceFile("/repo", "nope")).resolves.toEqual({
      exists: false,
      isDir: false,
      size: 0,
      mtimeMs: null,
    })
  })
})

describe("read/write wrappers", () => {
  it("readWorkspaceFile forwards maxBytes and returns the content string", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce("hello")
    await expect(readWorkspaceFile("/repo", "a.txt", 1024)).resolves.toBe("hello")
    expect(callSpy).toHaveBeenCalledWith("fs_read_workspace_file", {
      root: "/repo",
      relPath: "a.txt",
      maxBytes: 1024,
    })
  })

  it("readWorkspaceFileBase64 hits the binary command with the cap", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce("QUJD")
    await expect(readWorkspaceFileBase64("/repo", "img.png", 512)).resolves.toBe("QUJD")
    expect(callSpy).toHaveBeenCalledWith("fs_read_workspace_file_base64", {
      root: "/repo",
      relPath: "img.png",
      maxBytes: 512,
    })
  })

  it("readWorkspaceFileChunk asks for one slice and returns it as sent", async () => {
    const chunk = { dataBase64: "QUJD", offset: 8, bytesRead: 3, size: 11, eof: true }
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce(chunk)
    await expect(readWorkspaceFileChunk("/repo", "big.bin", 8, 4)).resolves.toEqual(chunk)
    expect(callSpy).toHaveBeenCalledWith("fs_read_workspace_file_chunk", {
      root: "/repo",
      relPath: "big.bin",
      offset: 8,
      length: 4,
    })
  })

  it("writeWorkspaceFile stays unconditional and discards the host result", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce({
      sha256: "a".repeat(64),
      size: 4,
      mtimeMs: 123,
    })
    const result: Promise<void> = writeWorkspaceFile("/repo", "a.txt", "body")
    await expect(result).resolves.toBeUndefined()
    expect(callSpy).toHaveBeenCalledWith("fs_write_workspace_file", {
      root: "/repo",
      relPath: "a.txt",
      content: "body",
    })
  })

  it("readWorkspaceFileVersioned keeps the content and host version together", async () => {
    const version = { content: "你好", sha256: "a".repeat(64), size: 6, mtimeMs: null }
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce(version)
    await expect(readWorkspaceFileVersioned("/repo", "a.txt", 1024)).resolves.toEqual(version)
    expect(callSpy).toHaveBeenCalledWith("fs_read_workspace_file_versioned", {
      root: "/repo",
      relPath: "a.txt",
      maxBytes: 1024,
    })
  })
})

describe("writeWorkspaceFileChecked", () => {
  const hash = "a".repeat(64)
  const conflictMessage = `workspace_file_conflict:${JSON.stringify({ currentSha256: hash })}`

  it.each([{ expectedSha256: hash }, { expectAbsent: true as const }])(
    "passes the precondition and returns the written version: %j",
    async (precondition) => {
      const version = { sha256: "b".repeat(64), size: 4, mtimeMs: 123 }
      const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce(version)
      await expect(
        writeWorkspaceFileChecked("/repo", "a.txt", "body", precondition)
      ).resolves.toEqual(version)
      expect(callSpy).toHaveBeenCalledWith("fs_write_workspace_file", {
        root: "/repo",
        relPath: "a.txt",
        content: "body",
        ...precondition,
      })
    }
  )

  it.each([
    ["Tauri structured error", { code: "workspace_file_conflict", currentSha256: hash }],
    ["Tauri legacy string", conflictMessage],
    [
      "companion transport error",
      new CompanionError({
        code: "workspace_file_conflict",
        message: conflictMessage,
        retryable: false,
      }),
    ],
    [
      "companion problem document",
      {
        type: "https://cognia.dev/problems/workspace_file_conflict",
        title: "Conflict",
        status: 409,
        detail: conflictMessage,
        code: "workspace_file_conflict",
        requestId: "test-request",
        retryable: false,
        details: {},
      },
    ],
  ])("normalizes %s with the current hash", async (_name, rejection) => {
    jest.spyOn(transport, "call").mockRejectedValueOnce(rejection)
    const error = await writeWorkspaceFileChecked("/repo", "a.txt", "draft", {
      expectedSha256: "b".repeat(64),
    }).catch((caught: unknown) => caught)
    expect(isWorkspaceFileConflict(error)).toBe(true)
    expect(error).toBeInstanceOf(WorkspaceFileConflictError)
    expect(error).toMatchObject({ code: "workspace_file_conflict", currentSha256: hash })
  })

  it.each([
    { code: "workspace_file_conflict", currentSha256: null },
    'workspace_file_conflict:{"currentSha256":null}',
  ])("preserves a missing-file conflict: %j", async (rejection) => {
    jest.spyOn(transport, "call").mockRejectedValueOnce(rejection)
    await expect(
      writeWorkspaceFileChecked("/repo", "a.txt", "draft", { expectedSha256: hash })
    ).rejects.toMatchObject({ currentSha256: null })
  })

  it("preserves a conflict already normalized by a transport adapter", async () => {
    const conflict = new WorkspaceFileConflictError(hash)
    jest.spyOn(transport, "call").mockRejectedValueOnce(conflict)
    await expect(
      writeWorkspaceFileChecked("/repo", "a.txt", "draft", { expectedSha256: hash })
    ).rejects.toBe(conflict)
  })

  it.each([
    new Error("permission denied"),
    "workspace_file_conflict:invalid-json",
    "workspace_file_conflict:{}",
    'workspace_file_conflict:{"currentSha256":17}',
    { code: "workspace_file_conflict" },
  ])("preserves unknown or malformed errors without assuming absence: %j", async (rejection) => {
    jest.spyOn(transport, "call").mockRejectedValueOnce(rejection)
    const error = await writeWorkspaceFileChecked("/repo", "a.txt", "draft", {
      expectAbsent: true,
    }).catch((caught: unknown) => caught)
    expect(error).toBe(rejection)
    expect(isWorkspaceFileConflict(error)).toBe(false)
  })
})

describe("mutating wrappers", () => {
  it("createWorkspaceDir forwards root/relPath", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce(null)
    await createWorkspaceDir("/repo", "a/b")
    expect(callSpy).toHaveBeenCalledWith("fs_create_workspace_dir", {
      root: "/repo",
      relPath: "a/b",
    })
  })

  it("deleteWorkspaceEntry forwards recursive", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce(null)
    await deleteWorkspaceEntry("/repo", "a/b", true)
    expect(callSpy).toHaveBeenCalledWith("fs_delete_workspace_entry", {
      root: "/repo",
      relPath: "a/b",
      recursive: true,
    })
  })

  it("renameWorkspaceEntry forwards from/to", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce(null)
    await renameWorkspaceEntry("/repo", "a.txt", "b.txt")
    expect(callSpy).toHaveBeenCalledWith("fs_rename_workspace_entry", {
      root: "/repo",
      fromRelPath: "a.txt",
      toRelPath: "b.txt",
    })
  })

  it("copyWorkspaceEntry forwards from/to/recursive", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce(null)
    await copyWorkspaceEntry("/repo", "d", "d-copy", true)
    expect(callSpy).toHaveBeenCalledWith("fs_copy_workspace_entry", {
      root: "/repo",
      fromRelPath: "d",
      toRelPath: "d-copy",
      recursive: true,
    })
  })

  it("propagates transport rejections", async () => {
    jest.spyOn(transport, "call").mockRejectedValueOnce(new Error("path escapes workspace"))
    await expect(deleteWorkspaceEntry("/repo", "../evil")).rejects.toThrow("path escapes workspace")
  })
})

describe("listWorkspaceRoots", () => {
  it("returns the roots the Host reports", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce({
      roots: [{ path: "/srv/workspaces", source: "headless-workspaces-dir" }],
    })
    await expect(listWorkspaceRoots()).resolves.toEqual([
      { path: "/srv/workspaces", source: "headless-workspaces-dir" },
    ])
    expect(callSpy).toHaveBeenCalledWith("fs_workspace_roots")
  })

  it("resolves empty instead of throwing when the Host does not know the command", async () => {
    // A Host predating this command answers `unknown_command`. That is "this
    // Host did not say", not "nothing is browsable", and the picker still has a
    // fallback starting path to fall back to, so a throw here would turn an old
    // Host into a dead dialog.
    jest.spyOn(transport, "call").mockRejectedValueOnce(
      Object.assign(new Error("unknown command"), {
        code: "unknown_command",
        retryable: false,
      })
    )
    await expect(listWorkspaceRoots()).resolves.toEqual([])
  })

  it("drops entries that are not a usable root", async () => {
    jest.spyOn(transport, "call").mockResolvedValueOnce({
      roots: [
        { path: "/srv/ok", source: "desktop-project" },
        { path: "", source: "desktop-project" },
        { path: "/srv/unknown", source: "something-else" },
        null,
      ],
    })
    await expect(listWorkspaceRoots()).resolves.toEqual([
      { path: "/srv/ok", source: "desktop-project" },
    ])
  })

  it("tolerates a response that is not the report shape", async () => {
    jest.spyOn(transport, "call").mockResolvedValueOnce(null)
    await expect(listWorkspaceRoots()).resolves.toEqual([])
  })
})

describe("published workspace version response contracts", () => {
  it.each([
    ["fs_write_workspace_file", { sha256: "a".repeat(64), size: 4, mtimeMs: null }],
    [
      "fs_read_workspace_file_versioned",
      { content: "text", sha256: "a".repeat(64), size: 4, mtimeMs: 123 },
    ],
  ] as const)("accepts the complete %s result off desktop", (command, result) => {
    const validate = new Ajv({ strict: false }).compile({
      ...responseSchemas.commands[command],
      $defs: responseSchemas.$defs,
    })
    expect(validate(result)).toBe(true)
    expect(validate(null)).toBe(false)
    expect(validate({ ...result, mtimeMs: undefined })).toBe(false)
    expect(validate({ ...result, mtime_ms: result.mtimeMs })).toBe(false)
  })
})
