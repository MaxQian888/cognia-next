import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  eventLogPath,
  isSafeSessionId,
  leasePath,
  legacyTranscriptPath,
  manifestPath,
  realSessionStoreFs,
  sessionDir,
  sessionsRoot,
  workspaceKey,
} from "./paths"

const HOME = path.join(path.sep, "home", "u", ".cognia")

describe("session store paths", () => {
  it("roots sessions under <home>/sessions by default", () => {
    expect(sessionsRoot(HOME)).toBe(path.join(HOME, "sessions"))
  })

  it("honours an absolute --session-dir override", () => {
    const override = path.join(path.sep, "tmp", "store")
    expect(sessionsRoot(HOME, override)).toBe(override)
    expect(sessionDir(HOME, "s1", override)).toBe(path.join(override, "s1"))
  })

  it("resolves a relative --session-dir override against the process cwd", () => {
    expect(path.isAbsolute(sessionsRoot(HOME, "relative-store"))).toBe(true)
  })

  it("places the canonical store in a directory that cannot collide with the legacy file", () => {
    expect(sessionDir(HOME, "s1")).toBe(path.join(HOME, "sessions", "s1"))
    expect(legacyTranscriptPath(HOME, "s1")).toBe(path.join(HOME, "sessions", "s1.jsonl"))
    expect(sessionDir(HOME, "s1")).not.toBe(legacyTranscriptPath(HOME, "s1"))
  })

  it("names the three store files inside the session directory", () => {
    const dir = sessionDir(HOME, "s1")
    expect(manifestPath(HOME, "s1")).toBe(path.join(dir, "manifest.json"))
    expect(eventLogPath(HOME, "s1")).toBe(path.join(dir, "events.jsonl"))
    expect(leasePath(HOME, "s1")).toBe(path.join(dir, "lease.json"))
  })
})

describe("workspaceKey", () => {
  it("collapses trailing separators and relative spellings", () => {
    const base = path.join(path.sep, "repo", "app")
    expect(workspaceKey(base + path.sep)).toBe(base)
    expect(workspaceKey(path.join(base, "sub", ".."))).toBe(base)
  })

  it("keeps genuinely different checkouts apart, including by case", () => {
    expect(workspaceKey(path.join(path.sep, "repo", "a"))).not.toBe(
      workspaceKey(path.join(path.sep, "repo", "b"))
    )
    // Lowercasing would merge two real directories on a case-sensitive FS.
    expect(workspaceKey(path.join(path.sep, "Repo"))).not.toBe(
      workspaceKey(path.join(path.sep, "repo"))
    )
  })

  it("never returns a bare separator for the filesystem root", () => {
    expect(workspaceKey(path.sep)).toBe(path.sep)
  })
})

describe("isSafeSessionId", () => {
  it("accepts ordinary minted ids", () => {
    expect(isSafeSessionId("s_abc123")).toBe(true)
  })

  it.each([
    ["", "empty"],
    [".", "dot"],
    ["..", "dotdot"],
    ["a/b", "slash"],
    ["a\\b", "backslash"],
  ])("rejects %s (%s)", (id) => {
    expect(isSafeSessionId(id)).toBe(false)
  })

  it("rejects a NUL byte and an over-long id", () => {
    expect(isSafeSessionId("a\0b")).toBe(false)
    expect(isSafeSessionId("x".repeat(129))).toBe(false)
    expect(isSafeSessionId("x".repeat(128))).toBe(true)
  })
})

describe("realSessionStoreFs", () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-store-"))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("reports a missing file as null rather than throwing", () => {
    expect(realSessionStoreFs.readFile(path.join(root, "definitely-missing"))).toBeNull()
  })

  it("reports a missing directory as empty and non-directory", () => {
    const missing = path.join(root, "definitely-missing")
    expect(realSessionStoreFs.readdir(missing)).toEqual([])
    expect(realSessionStoreFs.isDirectory(missing)).toBe(false)
    expect(realSessionStoreFs.mtimeMs(missing)).toBeNull()
    expect(realSessionStoreFs.exists(missing)).toBe(false)
  })

  it("swallows a remove of a file that is not there", () => {
    expect(() => realSessionStoreFs.removeFile(path.join(root, "gone"))).not.toThrow()
  })

  it("removes a session directory recursively and tolerates a missing directory", () => {
    const dir = path.join(root, "session-1")
    realSessionStoreFs.writeFileAtomic(path.join(dir, "nested", "events.jsonl"), "event\n")

    realSessionStoreFs.removeDir(dir)

    expect(realSessionStoreFs.exists(dir)).toBe(false)
    expect(() => realSessionStoreFs.removeDir(dir)).not.toThrow()
  })

  it("writes atomically through a same-directory temp file, creating parents", () => {
    const target = path.join(root, "deep", "nested", "manifest.json")
    realSessionStoreFs.writeFileAtomic(target, "first")
    expect(realSessionStoreFs.readFile(target)).toBe("first")
    realSessionStoreFs.writeFileAtomic(target, "second")
    expect(realSessionStoreFs.readFile(target)).toBe("second")
    // The temp file must not survive the rename.
    expect(realSessionStoreFs.readdir(path.dirname(target))).toEqual(["manifest.json"])
  })

  it("appends without truncating and creates parents", () => {
    const target = path.join(root, "deep", "events.jsonl")
    realSessionStoreFs.appendFile(target, "a\n")
    realSessionStoreFs.appendFile(target, "b\n")
    expect(realSessionStoreFs.readFile(target)).toBe("a\nb\n")
  })

  it("creates directories recursively and idempotently", () => {
    const dir = path.join(root, "x", "y", "z")
    realSessionStoreFs.mkdirp(dir)
    realSessionStoreFs.mkdirp(dir)
    expect(realSessionStoreFs.isDirectory(dir)).toBe(true)
    expect(realSessionStoreFs.exists(dir)).toBe(true)
  })

  it("makes exclusive create genuinely exclusive", () => {
    const target = path.join(root, "lease.json")
    expect(realSessionStoreFs.writeFileExclusive(target, "first")).toBe(true)
    expect(realSessionStoreFs.writeFileExclusive(target, "second")).toBe(false)
    expect(realSessionStoreFs.readFile(target)).toBe("first")
    realSessionStoreFs.removeFile(target)
    expect(realSessionStoreFs.writeFileExclusive(target, "third")).toBe(true)
  })

  it("lists directory entries and reports a real mtime", () => {
    realSessionStoreFs.writeFileAtomic(path.join(root, "a.txt"), "a")
    realSessionStoreFs.mkdirp(path.join(root, "sub"))
    expect(realSessionStoreFs.readdir(root).sort()).toEqual(["a.txt", "sub"])
    expect(realSessionStoreFs.mtimeMs(path.join(root, "a.txt"))).toBeGreaterThan(0)
  })

  it("propagates a non-ENOENT read failure instead of masking it as missing", () => {
    // Reading a DIRECTORY as a file fails with EISDIR — a real error the store
    // must see, not a "no such session".
    expect(() => realSessionStoreFs.readFile(root)).toThrow()
  })
})
