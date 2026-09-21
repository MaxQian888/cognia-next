import { DELEGATE_TOOL_NAMES, DELEGATE_WORK_POLICY } from "@cognia/router-fusion"

import {
  DELEGATE_PATCH_LIMITS,
  delegatePatchLimitRefusal,
  delegateSymlinkRefusal,
  delegateWorkTools,
  delegateWriteAllowed,
  normalizeDelegateHostPath,
  normalizeDelegateListPrefix,
} from "./delegate-tool-policy"

describe("normalizeDelegateHostPath", () => {
  it.each([
    ["src/app.ts", "src/app.ts"],
    ["./src/./app.ts", "src/app.ts"],
    ["src\\users\\list.ts", "src/users/list.ts"],
    [" tests/users/ ", "tests/users"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeDelegateHostPath(raw)).toEqual({ ok: true, path: expected })
  })

  it.each([
    ["", "PATH_EMPTY"],
    ["./", "PATH_EMPTY"],
    ["/etc/passwd", "PATH_ABSOLUTE"],
    ["C:/Windows/win.ini", "PATH_ABSOLUTE"],
    ["~/notes", "PATH_ABSOLUTE"],
    ["../outside.txt", "PATH_TRAVERSAL"],
    ["src/../../etc/passwd", "PATH_TRAVERSAL"],
    ["src\\..\\..\\secret", "PATH_TRAVERSAL"],
    [".git/config", "PATH_SENSITIVE"],
    ["home/.ssh/id_rsa", "PATH_SENSITIVE"],
    [".AWS/credentials", "PATH_SENSITIVE"],
    ["src/\u0000evil.ts", "PATH_INVALID"],
  ])("[ACC:DEL-05] refuses %s with %s", (raw, code) => {
    expect(normalizeDelegateHostPath(raw)).toEqual({ ok: false, code })
  })

  it("[ACC:SAFE-02] refuses the docker socket, host process trees and token dotfiles", () => {
    for (const path of [
      "var/run/docker.sock",
      "run/docker/docker.sock",
      "tmp/docker.sock",
      "proc/self/environ",
      "sys/kernel/debug",
      "dev/mem",
    ]) {
      expect(normalizeDelegateHostPath(path)).toEqual({ ok: false, code: "PATH_HOST_SURFACE" })
    }
    for (const path of [
      ".netrc",
      "home/user/.npmrc",
      ".git-credentials",
      "config/.env.production",
      "deploy/server.pem",
      "keys/id_ed25519",
    ]) {
      expect(normalizeDelegateHostPath(path)).toEqual({ ok: false, code: "PATH_SENSITIVE" })
    }
  })

  it("lists from the root with an empty prefix and refuses an escaping one", () => {
    expect(normalizeDelegateListPrefix("   ")).toEqual({ ok: true, path: "" })
    expect(normalizeDelegateListPrefix("src")).toEqual({ ok: true, path: "src" })
    expect(normalizeDelegateListPrefix("../..")).toEqual({ ok: false, code: "PATH_TRAVERSAL" })
  })
})

describe("delegateSymlinkRefusal", () => {
  it("[ACC:DEL-05] refuses a link rather than following it, and passes an ordinary file", () => {
    expect(delegateSymlinkRefusal({ exists: true, isSymlink: true })).toBe("PATH_SYMLINK")
    expect(delegateSymlinkRefusal({ exists: true, isSymlink: false })).toBeNull()
    expect(delegateSymlinkRefusal({ exists: true })).toBeNull()
    // A path that does not exist yet is a write target, not a link.
    expect(delegateSymlinkRefusal({ exists: false, isSymlink: true })).toBeNull()
  })
})

describe("delegateWriteAllowed", () => {
  it("[ACC:DEL-07] allows the subtask's paths and nothing else", () => {
    const scope = ["src/users", "tests/users"]
    expect(delegateWriteAllowed("src/users/list.ts", scope)).toBe(true)
    expect(delegateWriteAllowed("src/users", scope)).toBe(true)
    expect(delegateWriteAllowed("src/usersx/list.ts", scope)).toBe(false)
    expect(delegateWriteAllowed("src/billing/rate.ts", scope)).toBe(false)
    expect(delegateWriteAllowed("src/users/list.ts", [])).toBe(false)
  })
})

describe("delegateWorkTools", () => {
  it("offers read, list and propose-patch only when the host has a workspace", () => {
    expect(delegateWorkTools(false)).toEqual([])
    const tools = delegateWorkTools(true)
    expect(tools.map((tool) => tool.name)).toEqual([
      DELEGATE_TOOL_NAMES.read,
      DELEGATE_TOOL_NAMES.list,
      DELEGATE_TOOL_NAMES.proposePatch,
    ])
    // Exactly one non-read tool, and it writes nothing: it proposes.
    expect(tools.filter((tool) => tool.toolClass !== "read_only").map((tool) => tool.name)).toEqual(
      [DELEGATE_TOOL_NAMES.proposePatch]
    )
    expect(tools.every((tool) => tool.toolClass !== "external_write")).toBe(true)
    expect(DELEGATE_WORK_POLICY).toBe("delegate-work-1")
  })
})

describe("delegatePatchLimitRefusal", () => {
  it("bounds files, one file's bytes and the whole patch", () => {
    expect(delegatePatchLimitRefusal({ files: 1, fileBytes: 10, totalBytes: 10 })).toBeNull()
    expect(
      delegatePatchLimitRefusal({
        files: DELEGATE_PATCH_LIMITS.maxFiles + 1,
        fileBytes: 1,
        totalBytes: 1,
      })
    ).toBe("PATCH_TOO_LARGE")
    expect(
      delegatePatchLimitRefusal({
        files: 1,
        fileBytes: DELEGATE_PATCH_LIMITS.maxFileBytes + 1,
        totalBytes: 1,
      })
    ).toBe("PATCH_TOO_LARGE")
    expect(
      delegatePatchLimitRefusal({
        files: 1,
        fileBytes: 1,
        totalBytes: DELEGATE_PATCH_LIMITS.maxTotalBytes + 1,
      })
    ).toBe("PATCH_TOO_LARGE")
  })
})
