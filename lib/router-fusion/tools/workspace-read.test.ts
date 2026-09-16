import { sha256Hex } from "@cognia/router-fusion"

import {
  createWorkspaceReader,
  WORKSPACE_READ_MAX_BYTES,
  workspacePathRefusal,
} from "./workspace-read"

describe("workspacePathRefusal", () => {
  it.each([
    ["src/app.ts", null],
    ["./docs/readme.md", null],
    ["a\\b.ts", null],
    ["", "PATH_EMPTY"],
    ["./", "PATH_EMPTY"],
    ["/etc/passwd", "PATH_ABSOLUTE"],
    ["C:/Windows/win.ini", "PATH_ABSOLUTE"],
    ["~/notes", "PATH_ABSOLUTE"],
    ["../outside.txt", "PATH_TRAVERSAL"],
    ["src/../../etc/passwd", "PATH_TRAVERSAL"],
    ["src\\..\\..\\secret", "PATH_TRAVERSAL"],
    [".env", "PATH_SENSITIVE"],
    ["config/.env.production", "PATH_SENSITIVE"],
    ["deploy/server.pem", "PATH_SENSITIVE"],
    ["home/.ssh/config", "PATH_SENSITIVE"],
    [".AWS/credentials", "PATH_SENSITIVE"],
  ])("%s → %s", (path, expected) => {
    expect(workspacePathRefusal(path)).toBe(expected)
  })
})

describe("createWorkspaceReader", () => {
  it("reads through the host guard and pins what it returned", async () => {
    const read = jest.fn(async () => "export const x = 1\n")
    const reader = createWorkspaceReader("/work/repo", { read })
    const result = await reader.read(" src\\x.ts ")
    expect(result).toEqual({
      ok: true,
      relPath: "src/x.ts",
      content: "export const x = 1\n",
      contentSha256: sha256Hex("export const x = 1\n"),
      truncated: false,
    })
    expect(read).toHaveBeenCalledWith("/work/repo", "src/x.ts", WORKSPACE_READ_MAX_BYTES)
  })

  it("refuses an escape before any I/O", async () => {
    const read = jest.fn()
    const reader = createWorkspaceReader("/work/repo", { read })
    await expect(reader.read("../../home/me/.ssh/id_rsa")).resolves.toMatchObject({
      ok: false,
      code: "PATH_TRAVERSAL",
    })
    expect(read).not.toHaveBeenCalled()
  })

  it("reports a symlink the host caught escaping, without echoing host paths", async () => {
    const reader = createWorkspaceReader("/work/repo", {
      read: async () => {
        throw new Error("path escapes workspace: /Users/me/.ssh/id_rsa (root /work/repo)")
      },
    })
    const result = await reader.read("docs/link-to-key")
    expect(result).toEqual({
      ok: false,
      code: "PATH_TRAVERSAL",
      message: "refused: PATH_TRAVERSAL",
    })
    expect(JSON.stringify(result)).not.toContain("/Users/me")
  })

  it("names any other failure without leaking it", async () => {
    const reader = createWorkspaceReader("/work/repo", {
      read: async () => {
        throw new Error("read /work/repo/missing.ts: No such file or directory")
      },
    })
    await expect(reader.read("missing.ts")).resolves.toEqual({
      ok: false,
      code: "READ_FAILED",
      message: "the file could not be read",
    })
  })

  it("refuses a file whose content fails the PII gate, without returning it", async () => {
    const reader = createWorkspaceReader("/r", {
      read: async () =>
        "owner: jane.doe@example.com\nkey: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    })
    const result = await reader.read("docs/contacts.md")
    expect(result).toEqual({
      ok: false,
      code: "CONTENT_SENSITIVE",
      message: "refused: CONTENT_SENSITIVE",
    })
    expect(JSON.stringify(result)).not.toContain("jane.doe")
  })

  it("notices the host cut the file short", async () => {
    const reader = createWorkspaceReader("/r", { read: async () => "abc\n... (truncated)" })
    await expect(reader.read("big.log")).resolves.toMatchObject({ ok: true, truncated: true })
  })
})
