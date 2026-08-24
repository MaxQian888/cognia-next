import {
  DEFAULT_PROJECTS_DIR_NAME,
  proposeWorkspacePath,
  resolveProjectsRoot,
  sanitizeWorkspaceFolderName,
} from "./projects-root"

describe("resolveProjectsRoot", () => {
  it("prefers the configured parent", async () => {
    await expect(
      resolveProjectsRoot("/srv/code ", { homeDir: async () => "/Users/x" })
    ).resolves.toBe("/srv/code")
    await expect(
      resolveProjectsRoot("/srv/code/", { homeDir: async () => "/Users/x" })
    ).resolves.toBe("/srv/code")
  })

  it("falls back to a home-relative default", async () => {
    await expect(resolveProjectsRoot(undefined, { homeDir: async () => "/Users/x" })).resolves.toBe(
      `/Users/x/${DEFAULT_PROJECTS_DIR_NAME}`
    )
    await expect(resolveProjectsRoot("   ", { homeDir: async () => "/Users/x/" })).resolves.toBe(
      `/Users/x/${DEFAULT_PROJECTS_DIR_NAME}`
    )
  })

  it("is null where there is no local filesystem to resolve against", async () => {
    // Browser / mobile: creation happens on a paired host, which resolves its
    // own root — proposing a path from a device that has none would be a lie.
    await expect(resolveProjectsRoot(null, { homeDir: async () => null })).resolves.toBeNull()
  })
})

describe("sanitizeWorkspaceFolderName", () => {
  it("keeps an ordinary name intact", () => {
    expect(sanitizeWorkspaceFolderName("  My App  ")).toBe("My App")
  })

  it("never lets a name climb out of its parent", () => {
    expect(sanitizeWorkspaceFolderName("../etc")).toBe("etc")
    expect(sanitizeWorkspaceFolderName("a/b")).toBe("a-b")
    expect(sanitizeWorkspaceFolderName("a\\b")).toBe("a-b")
    expect(sanitizeWorkspaceFolderName("..")).toBe("workspace")
  })

  it("never produces a hidden directory", () => {
    expect(sanitizeWorkspaceFolderName(".ssh")).toBe("ssh")
    expect(sanitizeWorkspaceFolderName("~/secrets")).toBe("secrets")
  })

  it("strips control characters and trailing dots", () => {
    expect(sanitizeWorkspaceFolderName("we\u0000ird\u001f")).toBe("weird")
    expect(sanitizeWorkspaceFolderName("api.")).toBe("api")
  })

  it("always yields something usable", () => {
    expect(sanitizeWorkspaceFolderName("   ")).toBe("workspace")
    expect(sanitizeWorkspaceFolderName("///")).toBe("workspace")
  })
})

describe("proposeWorkspacePath", () => {
  it("joins the sanitized name under the parent", () => {
    expect(proposeWorkspacePath("/Users/x/Projects", "My App")).toEqual({
      ok: true,
      path: "/Users/x/Projects/My App",
      folderName: "My App",
    })
  })

  it("contains a traversal attempt inside the parent", () => {
    const result = proposeWorkspacePath("/Users/x/Projects", "../../etc")
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.path.startsWith("/Users/x/Projects/")).toBe(true)
  })

  it("refuses without a parent or a name", () => {
    expect(proposeWorkspacePath(null, "App")).toEqual({ ok: false, reason: "no-parent" })
    expect(proposeWorkspacePath("  ", "App")).toEqual({ ok: false, reason: "no-parent" })
    expect(proposeWorkspacePath("/Users/x/Projects", "  ")).toEqual({
      ok: false,
      reason: "empty-name",
    })
  })

  it("tolerates a windows-style parent", () => {
    expect(proposeWorkspacePath("C:\\Users\\x\\Projects\\", "My App")).toEqual({
      ok: true,
      path: "C:\\Users\\x\\Projects\\My App",
      folderName: "My App",
    })
  })
})
