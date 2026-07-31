jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: () => true,
}))

import { isWithinAllowedRoots, loadExternalFile, saveExternalFile, BACKUP_SUFFIX } from "./edit"

describe("isWithinAllowedRoots", () => {
  it("accepts a path under a root", () => {
    expect(isWithinAllowedRoots("/Users/x/.claude/CLAUDE.md", ["/Users/x/.claude"])).toBe(true)
  })
  it("rejects a path outside every root", () => {
    expect(isWithinAllowedRoots("/etc/passwd", ["/Users/x/.claude", "/Users/x/.codex"])).toBe(false)
  })
  it("ignores empty roots", () => {
    expect(isWithinAllowedRoots("/Users/x/a", ["", "/Users/x"])).toBe(true)
  })
})

describe("loadExternalFile", () => {
  it("delegates to the injected reader", async () => {
    const readText = jest.fn().mockResolvedValue("body")
    expect(await loadExternalFile("/p/CLAUDE.md", { readText })).toBe("body")
    expect(readText).toHaveBeenCalledWith("/p/CLAUDE.md")
  })
})

describe("saveExternalFile", () => {
  const roots = ["/Users/x/.claude"]

  function deps(exists: boolean) {
    return {
      isDesktop: true,
      exists: jest.fn().mockResolvedValue(exists),
      readText: jest.fn().mockResolvedValue("old"),
      writeText: jest.fn().mockResolvedValue(undefined),
      copy: jest.fn().mockResolvedValue(undefined),
    }
  }

  it("backs up before overwriting an existing file", async () => {
    const d = deps(true)
    const res = await saveExternalFile("/Users/x/.claude/CLAUDE.md", "new", {
      allowedRoots: roots,
      ...d,
    })
    expect(d.copy).toHaveBeenCalledWith(
      "/Users/x/.claude/CLAUDE.md",
      "/Users/x/.claude/CLAUDE.md" + BACKUP_SUFFIX
    )
    expect(d.writeText).toHaveBeenCalledWith("/Users/x/.claude/CLAUDE.md", "new")
    expect(res.backupPath).toBe("/Users/x/.claude/CLAUDE.md.bak")
  })

  it("skips backup when the file does not yet exist", async () => {
    const d = deps(false)
    const res = await saveExternalFile("/Users/x/.claude/CLAUDE.md", "new", {
      allowedRoots: roots,
      ...d,
    })
    expect(d.copy).not.toHaveBeenCalled()
    expect(d.writeText).toHaveBeenCalled()
    expect(res.backupPath).toBeNull()
  })

  it("refuses to write outside the allowed roots", async () => {
    const d = deps(true)
    await expect(
      saveExternalFile("/etc/evil.md", "x", { allowedRoots: roots, ...d })
    ).rejects.toThrow(/allowed roots/)
    expect(d.writeText).not.toHaveBeenCalled()
  })

  it("falls back to isTauri() for desktop detection when not overridden", async () => {
    const d = {
      exists: jest.fn().mockResolvedValue(false),
      readText: jest.fn(),
      writeText: jest.fn().mockResolvedValue(undefined),
      copy: jest.fn(),
    }
    // isDesktop omitted → uses the mocked isTauri() === true.
    await saveExternalFile("/Users/x/.claude/CLAUDE.md", "new", { allowedRoots: roots, ...d })
    expect(d.writeText).toHaveBeenCalledWith("/Users/x/.claude/CLAUDE.md", "new")
  })

  it("refuses to write off-desktop", async () => {
    const d = deps(true)
    await expect(
      saveExternalFile("/Users/x/.claude/CLAUDE.md", "x", {
        allowedRoots: roots,
        ...d,
        isDesktop: false,
      })
    ).rejects.toThrow(/desktop app/)
    expect(d.writeText).not.toHaveBeenCalled()
  })
})
