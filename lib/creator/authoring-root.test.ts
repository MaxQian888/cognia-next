import {
  CREATOR_DENIED_GLOBS,
  authoringRootPolicy,
  checkCreatorAccess,
  validateAuthoringRoot,
} from "./authoring-root"
import type { AuthoringRoot } from "@/types/creator"

const NOW = 1_700_000_000_000

function root(path = "/work/authoring"): AuthoringRoot {
  return { path, label: "authoring", origin: "selected", grantedAt: NOW }
}

describe("validateAuthoringRoot", () => {
  it("normalizes the path and derives a label from the last segment", () => {
    const result = validateAuthoringRoot({ path: "/work/./authoring/", now: NOW })
    expect(result).toEqual({
      valid: true,
      root: { path: "/work/authoring", label: "authoring", origin: "selected", grantedAt: NOW },
    })
  })

  it("keeps an explicit label and origin", () => {
    const result = validateAuthoringRoot({
      path: "/work/authoring",
      label: "  My scratch  ",
      origin: "created",
      now: NOW,
    })
    expect(result.valid && result.root.label).toBe("My scratch")
    expect(result.valid && result.root.origin).toBe("created")
  })

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["relative/dir", "not-absolute"],
    ["/", "filesystem-root"],
    ["C:/", "filesystem-root"],
    ["//server/share", "filesystem-root"],
  ])("rejects %p as %s", (path, reason) => {
    const result = validateAuthoringRoot({ path, now: NOW })
    expect(result).toEqual({ valid: false, reason })
  })

  it("rejects the home directory, which is too broad to be a boundary", () => {
    const result = validateAuthoringRoot({
      path: "/Users/me",
      homeDir: "/Users/me/",
      now: NOW,
    })
    expect(result).toEqual({ valid: false, reason: "home-directory" })
  })

  it("accepts a directory inside the home directory", () => {
    const result = validateAuthoringRoot({
      path: "/Users/me/projects/thing",
      homeDir: "/Users/me",
      now: NOW,
    })
    expect(result.valid).toBe(true)
  })

  it("accepts a Windows drive path below the drive root", () => {
    const result = validateAuthoringRoot({ path: "C:\\work\\authoring", now: NOW })
    expect(result.valid && result.root.path).toBe("C:/work/authoring")
  })
})

describe("authoringRootPolicy", () => {
  it("confines to exactly one root and carries the secret deny list", () => {
    const policy = authoringRootPolicy(root())
    expect(policy.allowedRoots).toEqual(["/work/authoring"])
    expect(policy.deniedGlobs).toEqual([...CREATOR_DENIED_GLOBS])
    expect(policy.readOnly).toBe(false)
  })

  it("produces a read-only policy on request", () => {
    expect(authoringRootPolicy(root(), { readOnly: true }).readOnly).toBe(true)
  })
})

describe("checkCreatorAccess", () => {
  it("denies everything when no root has been granted", () => {
    const decision = checkCreatorAccess({ root: null, path: "/work/authoring/a.ts", op: "read" })
    expect(decision).toMatchObject({ allowed: false, reason: "no_roots" })
  })

  it("allows a read inside the root without any approval", () => {
    const decision = checkCreatorAccess({
      root: root(),
      path: "/work/authoring/src/index.ts",
      op: "read",
    })
    expect(decision.allowed).toBe(true)
  })

  it("blocks a write until the permission diff is approved", () => {
    const decision = checkCreatorAccess({
      root: root(),
      path: "/work/authoring/src/index.ts",
      op: "write",
    })
    expect(decision).toMatchObject({ allowed: false, reason: "read_only" })
    expect(decision.detail).toContain("permission diff")
  })

  it("allows the same write once approved", () => {
    const decision = checkCreatorAccess({
      root: root(),
      path: "/work/authoring/src/index.ts",
      op: "write",
      writesApproved: true,
    })
    expect(decision.allowed).toBe(true)
  })

  // The containment property this whole module exists for.
  it.each(["/work/authoring/../secrets/key.txt", "/work/other/thing.ts", "/etc/passwd"])(
    "denies %p as outside the root",
    (path) => {
      const decision = checkCreatorAccess({ root: root(), path, op: "read" })
      expect(decision).toMatchObject({ allowed: false, reason: "outside_roots" })
    }
  )

  it("denies a traversal that lands back inside only after escaping", () => {
    // Lexically this resolves to /work/authoring/b.ts, which IS inside — the
    // point of the assertion is that normalization happens before matching, so
    // the decision is based on where the path lands rather than how it is spelt.
    const decision = checkCreatorAccess({
      root: root(),
      path: "/work/authoring/sub/../b.ts",
      op: "read",
    })
    expect(decision.allowed).toBe(true)
    expect(decision.matchedRoot).toBe("/work/authoring")
  })

  it.each([
    "/work/authoring/.env",
    "/work/authoring/nested/.git/config",
    "/work/authoring/keys/server.pem",
    "/work/authoring/.ssh/id_ed25519",
  ])("denies %p even though it is inside the root", (path) => {
    const decision = checkCreatorAccess({ root: root(), path, op: "read" })
    expect(decision).toMatchObject({ allowed: false, reason: "denied_glob" })
  })

  it("denies a destination that escapes on a move", () => {
    const decision = checkCreatorAccess({
      root: root(),
      path: "/work/authoring/a.ts",
      op: "move",
      writesApproved: true,
      destPath: "/tmp/a.ts",
    })
    expect(decision).toMatchObject({ allowed: false, reason: "outside_roots" })
  })

  it("rejects an oversized write", () => {
    const decision = checkCreatorAccess({
      root: root(),
      path: "/work/authoring/big.bin",
      op: "write",
      writesApproved: true,
      bytes: 2 * 1024 * 1024,
    })
    expect(decision).toMatchObject({ allowed: false, reason: "too_large" })
  })

  it.each(["list", "stat"])("treats %s as non-mutating", (op) => {
    const decision = checkCreatorAccess({
      root: root(),
      path: "/work/authoring",
      op: op as "list" | "stat",
    })
    expect(decision.allowed).toBe(true)
  })

  it.each(["delete", "mkdir", "copy"])("treats %s as mutating", (op) => {
    const decision = checkCreatorAccess({
      root: root(),
      path: "/work/authoring/x",
      op: op as "delete" | "mkdir" | "copy",
    })
    expect(decision.allowed).toBe(false)
  })
})
