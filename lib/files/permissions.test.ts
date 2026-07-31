import {
  checkFileAccess,
  normalizeFsPath,
  isMutatingOperation,
  defaultFilePolicy,
} from "@/lib/files/permissions"
import type { FileAccessPolicy } from "@/types/files"

describe("normalizeFsPath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizeFsPath("C:\\Users\\me\\file.txt")).toBe("C:/Users/me/file.txt")
  })

  it("collapses '.' and resolves '..' segments", () => {
    expect(normalizeFsPath("/a/b/../c/./d")).toBe("/a/c/d")
  })

  it("preserves a posix-absolute leading slash", () => {
    expect(normalizeFsPath("/a/b")).toBe("/a/b")
  })

  it("does not pop above the root", () => {
    expect(normalizeFsPath("/a/../../x")).toBe("/x")
  })

  it("strips a trailing slash (except bare root)", () => {
    expect(normalizeFsPath("/a/b/")).toBe("/a/b")
    expect(normalizeFsPath("/")).toBe("/")
  })

  it("trims surrounding whitespace", () => {
    expect(normalizeFsPath("  /a/b  ")).toBe("/a/b")
  })

  it("treats a UNC share as the immovable floor and does not pop above it", () => {
    expect(normalizeFsPath("\\\\server\\share\\a\\b")).toBe("//server/share/a/b")
    expect(normalizeFsPath("//server/share/a/../../../x")).toBe("//server/share/x")
    expect(normalizeFsPath("//server/share")).toBe("//server/share/")
  })

  it("strips a \\\\?\\ extended-length prefix and is equivalent to the plain path", () => {
    expect(normalizeFsPath("\\\\?\\C:\\proj\\f.txt")).toBe("C:/proj/f.txt")
    expect(normalizeFsPath("\\\\?\\C:\\proj\\f.txt")).toBe(normalizeFsPath("C:/proj/f.txt"))
  })

  it("strips a \\\\?\\UNC\\ extended-length prefix into the UNC form", () => {
    expect(normalizeFsPath("\\\\?\\UNC\\server\\share\\f.txt")).toBe("//server/share/f.txt")
  })

  it("rejects an ambiguous drive-relative path (no slash after the colon)", () => {
    expect(normalizeFsPath("C:foo")).toBe("")
    expect(normalizeFsPath("C:")).toBe("")
  })
})

describe("isMutatingOperation", () => {
  it("flags write/delete/copy/move/mkdir as mutating", () => {
    for (const op of ["write", "delete", "copy", "move", "mkdir"] as const) {
      expect(isMutatingOperation(op)).toBe(true)
    }
  })

  it("flags read/list/stat as non-mutating", () => {
    for (const op of ["read", "list", "stat"] as const) {
      expect(isMutatingOperation(op)).toBe(false)
    }
  })
})

describe("checkFileAccess", () => {
  const policy: FileAccessPolicy = { allowedRoots: ["/workspace/project"] }

  it("allows a read inside an allowed root", () => {
    const d = checkFileAccess("/workspace/project/src/a.ts", "read", policy)
    expect(d.allowed).toBe(true)
    expect(d.reason).toBe("ok")
    expect(d.matchedRoot).toBe("/workspace/project")
  })

  it("allows the root directory itself", () => {
    expect(checkFileAccess("/workspace/project", "list", policy).allowed).toBe(true)
  })

  it("denies an empty path", () => {
    const d = checkFileAccess("   ", "read", policy)
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe("empty_path")
  })

  it("denies a path outside every root", () => {
    const d = checkFileAccess("/etc/passwd", "read", policy)
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe("outside_roots")
  })

  it("denies a sibling that shares a name prefix with the root", () => {
    // "/workspace/project-secret" must NOT be treated as inside "/workspace/project".
    const d = checkFileAccess("/workspace/project-secret/x", "read", policy)
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe("outside_roots")
  })

  it("denies a traversal escape even when the literal prefix matches", () => {
    const d = checkFileAccess("/workspace/project/../outside/x", "read", policy)
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe("outside_roots")
  })

  it("denies all access when the policy has no roots", () => {
    const d = checkFileAccess("/anything", "read", { allowedRoots: [] })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe("no_roots")
  })

  it("allows any absolute path when allowAnyPath is set", () => {
    const d = checkFileAccess("/etc/hosts", "read", { allowedRoots: [], allowAnyPath: true })
    expect(d.allowed).toBe(true)
  })

  it("denies mutating ops under a read-only policy", () => {
    const ro: FileAccessPolicy = { allowedRoots: ["/workspace/project"], readOnly: true }
    expect(checkFileAccess("/workspace/project/a.ts", "write", ro).reason).toBe("read_only")
    expect(checkFileAccess("/workspace/project/a.ts", "delete", ro).reason).toBe("read_only")
    // Reads still pass.
    expect(checkFileAccess("/workspace/project/a.ts", "read", ro).allowed).toBe(true)
  })

  it("denies a path matching a denied glob (case-insensitive)", () => {
    const p: FileAccessPolicy = {
      allowedRoots: ["/workspace/project"],
      deniedGlobs: [".env", "/.git/"],
    }
    expect(checkFileAccess("/workspace/project/.ENV", "read", p).reason).toBe("denied_glob")
    expect(checkFileAccess("/workspace/project/.git/config", "read", p).reason).toBe("denied_glob")
    expect(checkFileAccess("/workspace/project/app.ts", "read", p).allowed).toBe(true)
  })

  it("does NOT deny a segment that merely contains a denied token (substring bug fix)", () => {
    const p: FileAccessPolicy = {
      allowedRoots: ["/workspace/project"],
      deniedGlobs: [".env"],
    }
    expect(checkFileAccess("/workspace/project/.environment/x", "read", p).allowed).toBe(true)
    expect(checkFileAccess("/workspace/project/prevent.ts", "read", p).allowed).toBe(true)
    // The real .env file is still denied.
    expect(checkFileAccess("/workspace/project/config/.env", "read", p).reason).toBe("denied_glob")
  })

  it("does NOT let a denied token in the root prefix deny the whole tree", () => {
    // The root path itself contains '.git' — only in-sandbox .git must be denied.
    const p: FileAccessPolicy = {
      allowedRoots: ["/home/me/my.git-backups/app"],
      deniedGlobs: [".git"],
    }
    expect(checkFileAccess("/home/me/my.git-backups/app/src/a.ts", "read", p).allowed).toBe(true)
    expect(checkFileAccess("/home/me/my.git-backups/app/.git/config", "read", p).reason).toBe(
      "denied_glob"
    )
  })

  it("supports ** and *.ext denied globs against the relative path", () => {
    const p: FileAccessPolicy = {
      allowedRoots: ["/ws"],
      deniedGlobs: ["**/.git/**", "*.pem", "secrets/**"],
    }
    expect(checkFileAccess("/ws/a/b/.git/x", "read", p).reason).toBe("denied_glob")
    expect(checkFileAccess("/ws/certs/key.pem", "read", p).reason).toBe("denied_glob")
    expect(checkFileAccess("/ws/secrets/db.key", "read", p).reason).toBe("denied_glob")
    expect(checkFileAccess("/ws/src/app.ts", "read", p).allowed).toBe(true)
  })

  it("contains a UNC path within a UNC root and blocks share escape", () => {
    const unc: FileAccessPolicy = { allowedRoots: ["//srv/share/proj"] }
    expect(checkFileAccess("\\\\srv\\share\\proj\\a\\b.txt", "read", unc).allowed).toBe(true)
    expect(checkFileAccess("//srv/share/other/x", "read", unc).reason).toBe("outside_roots")
  })

  it("denies an ambiguous drive-relative target", () => {
    const win: FileAccessPolicy = { allowedRoots: ["C:/proj"] }
    expect(checkFileAccess("C:foo", "read", win).reason).toBe("empty_path")
  })

  it("enforces maxBytes for read/write when a byte count is supplied", () => {
    const p: FileAccessPolicy = { allowedRoots: ["/workspace/project"], maxBytes: 10 }
    const ok = checkFileAccess("/workspace/project/a.ts", "write", p, { bytes: 5 })
    expect(ok.allowed).toBe(true)
    const tooBig = checkFileAccess("/workspace/project/a.ts", "write", p, { bytes: 50 })
    expect(tooBig.reason).toBe("too_large")
  })

  it("treats Windows paths case-insensitively for containment", () => {
    const win: FileAccessPolicy = { allowedRoots: ["C:/Users/Me/Project"] }
    const d = checkFileAccess("c:\\users\\me\\project\\src\\a.ts", "read", win)
    expect(d.allowed).toBe(true)
  })

  it("checks the destination root for copy/move", () => {
    const d = checkFileAccess("/workspace/project/a.ts", "move", policy, {
      destPath: "/etc/evil",
    })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe("outside_roots")
  })
})

describe("defaultFilePolicy", () => {
  it("builds a policy from workspace root paths", () => {
    const p = defaultFilePolicy(["/a", "/b"])
    expect(p.allowedRoots).toEqual(["/a", "/b"])
    expect(p.readOnly).toBeUndefined()
  })

  it("drops empty/whitespace roots", () => {
    expect(defaultFilePolicy(["/a", "", "  "]).allowedRoots).toEqual(["/a"])
  })

  it("carries through overrides", () => {
    const p = defaultFilePolicy(["/a"], { readOnly: true, maxBytes: 99 })
    expect(p.readOnly).toBe(true)
    expect(p.maxBytes).toBe(99)
  })
})
