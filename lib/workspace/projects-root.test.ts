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

  it("is null where neither this device nor the Host names a parent", async () => {
    await expect(
      resolveProjectsRoot(null, { homeDir: async () => null, hostWorkspaceRoots: async () => [] })
    ).resolves.toBeNull()
  })

  it("asks the Host when this shell has no filesystem of its own", async () => {
    // Browser / mobile companion: the directory is made on the paired Host, so
    // the parent has to be one that Host accepts.
    await expect(
      resolveProjectsRoot(null, {
        homeDir: async () => null,
        hostWorkspaceRoots: async () => [
          { path: "/var/lib/cognia/workspaces/", source: "headless-workspaces-dir" },
        ],
      })
    ).resolves.toBe("/var/lib/cognia/workspaces")
  })

  it("prefers the Host root over a projectsRoot synced from another machine", async () => {
    // A headless Host confines every client write to its workspaces directory,
    // so a path that belongs to someone's desktop is refused on arrival.
    await expect(
      resolveProjectsRoot("/Users/someone-else/Projects", {
        homeDir: async () => null,
        hostWorkspaceRoots: async () => [
          { path: "/var/lib/cognia/workspaces", source: "headless-workspaces-dir" },
        ],
      })
    ).resolves.toBe("/var/lib/cognia/workspaces")
  })

  it("keeps the configured value when the Host names nothing", async () => {
    await expect(
      resolveProjectsRoot("/srv/code", {
        homeDir: async () => null,
        hostWorkspaceRoots: async () => [],
      })
    ).resolves.toBe("/srv/code")
  })

  it("never lets a Host lookup failure take the resolution down", async () => {
    await expect(
      resolveProjectsRoot(null, {
        homeDir: async () => null,
        hostWorkspaceRoots: async () => {
          throw new Error("transport is down")
        },
      })
    ).resolves.toBeNull()
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
