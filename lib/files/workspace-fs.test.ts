import { transport } from "@/lib/tauri"
import {
  copyWorkspaceEntry,
  createWorkspaceDir,
  deleteWorkspaceEntry,
  listWorkspaceDir,
  listWorkspaceRoots,
  readWorkspaceFile,
  renameWorkspaceEntry,
  searchWorkspaceContent,
  statWorkspaceFile,
  writeWorkspaceFile,
} from "./workspace-fs"

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

  it("writeWorkspaceFile forwards root/relPath/content", async () => {
    const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce(null)
    await writeWorkspaceFile("/repo", "a.txt", "body")
    expect(callSpy).toHaveBeenCalledWith("fs_write_workspace_file", {
      root: "/repo",
      relPath: "a.txt",
      content: "body",
    })
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
