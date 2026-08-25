import {
  WorkspaceAcquireError,
  acquireWorkspace,
  cacheIsReusable,
  isInsideOpenRoot,
  releaseWorkspace,
  type AcquireDeps,
} from "./acquire"

function deps(overrides: Partial<AcquireDeps> = {}): AcquireDeps {
  return {
    openRoots: () => ["/home/u/project"],
    repoCacheDir: async (segments) => `/plugins/demo/data/repos/${segments.join("/")}`,
    removeRepoCache: async () => true,
    clone: (async (_url: string, destination: string) => destination) as AcquireDeps["clone"],
    // Default to "not a repository" so the handle shape stays exact; the
    // headRef tests below opt in.
    headOf: async () => null,
    ...overrides,
  }
}

describe("isInsideOpenRoot", () => {
  it("accepts the root itself and anything under it", () => {
    expect(isInsideOpenRoot("/home/u/project", ["/home/u/project"])).toBe(true)
    expect(isInsideOpenRoot("/home/u/project/src", ["/home/u/project"])).toBe(true)
  })

  it("does not treat a sibling with a shared prefix as inside", () => {
    // The bug a naive startsWith would ship: /home/u/project-two is not in
    // /home/u/project.
    expect(isInsideOpenRoot("/home/u/project-two", ["/home/u/project"])).toBe(false)
  })

  it("ignores a trailing separator on either side", () => {
    expect(isInsideOpenRoot("/home/u/project/", ["/home/u/project"])).toBe(true)
    expect(isInsideOpenRoot("/home/u/project/src", ["/home/u/project/"])).toBe(true)
  })

  it("is false when nothing is open", () => {
    expect(isInsideOpenRoot("/home/u/project", [])).toBe(false)
  })
})

describe("cacheIsReusable", () => {
  const origin = [{ name: "origin", url: "https://github.com/o/r.git" }]

  it("is false for an empty cache directory", () => {
    expect(cacheIsReusable(null, origin, "https://github.com/o/r.git")).toBe(false)
  })

  it("is true when a populated cache points at the same remote", () => {
    expect(cacheIsReusable("abc123", origin, "https://github.com/o/r.git")).toBe(true)
  })

  it("is false when the cache holds a different repository", () => {
    // Cloning over it would fail on a non-empty directory, which is why the
    // caller clears it instead.
    expect(cacheIsReusable("abc123", origin, "https://github.com/other/repo.git")).toBe(false)
  })
})

describe("acquireWorkspace cache reuse", () => {
  function reusableDeps(overrides: Partial<AcquireDeps> = {}) {
    const calls = { clone: 0, fetch: 0, checkout: [] as string[], removed: 0 }
    const base = deps({
      clone: (async (_url: string, destination: string) => {
        calls.clone += 1
        return destination
      }) as AcquireDeps["clone"],
      removeRepoCache: async () => {
        calls.removed += 1
        return true
      },
      headOf: async () => "cached-head",
      remotesOf: async () => [{ name: "origin", url: "https://github.com/o/r.git" }],
      fetchAll: async () => {
        calls.fetch += 1
      },
      checkoutRef: async (_root, ref) => {
        calls.checkout.push(ref)
      },
      ...overrides,
    })
    return { deps: base, calls }
  }

  it("refreshes an existing cache instead of cloning again", async () => {
    const { deps: d, calls } = reusableDeps()
    const handle = await acquireWorkspace({ kind: "git-url", url: "https://github.com/o/r.git" }, d)
    expect(handle.origin).toBe("clone")
    expect(calls.clone).toBe(0)
    expect(calls.fetch).toBe(1)
  })

  it("moves a reused cache onto the requested ref", async () => {
    const { deps: d, calls } = reusableDeps()
    await acquireWorkspace({ kind: "git-url", url: "https://github.com/o/r.git", ref: "v2" }, d)
    expect(calls.checkout).toEqual(["v2"])
  })

  it("clears and re-clones when the cache holds a different repository", async () => {
    const { deps: d, calls } = reusableDeps({
      remotesOf: async () => [{ name: "origin", url: "https://github.com/someone/else.git" }],
    })
    await acquireWorkspace({ kind: "git-url", url: "https://github.com/o/r.git" }, d)
    expect(calls.removed).toBe(1)
    expect(calls.clone).toBe(1)
    expect(calls.fetch).toBe(0)
  })

  it("falls back to cloning when refreshing throws", async () => {
    // A cache is an optimisation; a plugin asking for a workspace still gets one.
    const { deps: d, calls } = reusableDeps({
      fetchAll: async () => {
        throw new Error("network down")
      },
    })
    const handle = await acquireWorkspace({ kind: "git-url", url: "https://github.com/o/r.git" }, d)
    expect(handle.origin).toBe("clone")
    expect(calls.clone).toBe(1)
  })

  it("clones when the runtime supplies no refresh primitives", async () => {
    const { deps: d, calls } = reusableDeps({ fetchAll: undefined, remotesOf: undefined })
    await acquireWorkspace({ kind: "git-url", url: "https://github.com/o/r.git" }, d)
    expect(calls.clone).toBe(1)
  })
})

describe("acquireWorkspace", () => {
  it("resolves the current project to its first open root", async () => {
    const handle = await acquireWorkspace({ kind: "current-project" }, deps())
    expect(handle).toEqual({
      root: "/home/u/project",
      origin: "current-project",
      ephemeral: false,
    })
  })

  it("refuses the current project when nothing is open", async () => {
    await expect(
      acquireWorkspace({ kind: "current-project" }, deps({ openRoots: () => [] }))
    ).rejects.toThrow(/no workspace is open/)
  })

  it("accepts a local path inside an open root", async () => {
    const handle = await acquireWorkspace(
      { kind: "local-path", path: "/home/u/project/packages/api" },
      deps()
    )
    expect(handle.origin).toBe("local-path")
    expect(handle.ephemeral).toBe(false)
  })

  it("refuses a local path outside every open root", async () => {
    // This is the filesystem escape ctx.fs and ctx.git both exist to prevent;
    // acquire must not reopen it.
    await expect(acquireWorkspace({ kind: "local-path", path: "/etc" }, deps())).rejects.toThrow(
      WorkspaceAcquireError
    )
    await expect(
      acquireWorkspace({ kind: "local-path", path: "/home/u/other" }, deps())
    ).rejects.toThrow(/not inside a workspace the user has opened/)
  })

  it("clones a remote into the plugin's own cache, host first", async () => {
    const seen: { url?: string; destination?: string } = {}
    const handle = await acquireWorkspace(
      { kind: "git-url", url: "https://github.com/pallets/flask.git" },
      deps({
        clone: (async (url: string, destination: string) => {
          seen.url = url
          seen.destination = destination
          return destination
        }) as AcquireDeps["clone"],
      })
    )
    expect(seen.url).toBe("https://github.com/pallets/flask.git")
    expect(seen.destination).toBe("/plugins/demo/data/repos/github.com/pallets/flask")
    expect(handle).toMatchObject({
      origin: "clone",
      ephemeral: true,
      remote: { host: "github.com", owner: "pallets", repo: "flask" },
    })
  })

  it("carries an explicit ref onto the handle", async () => {
    const handle = await acquireWorkspace(
      { kind: "git-url", url: "https://github.com/o/r.git", ref: "v2" },
      deps()
    )
    expect(handle.remote?.ref).toBe("v2")
  })

  it("forwards extra allowed hosts to the guarded clone", async () => {
    let guards: unknown
    await acquireWorkspace(
      {
        kind: "git-url",
        url: "https://git.internal.example/o/r.git",
        allowedHosts: ["git.internal.example"],
      },
      deps({
        clone: (async (_url: string, destination: string, g: unknown) => {
          guards = g
          return destination
        }) as unknown as AcquireDeps["clone"],
      })
    )
    expect(guards).toEqual({ allowedHosts: ["git.internal.example"] })
  })

  it("routes an auto spec by what the user typed", async () => {
    const remote = await acquireWorkspace({ kind: "auto", input: "pallets/flask" }, deps())
    expect(remote.origin).toBe("clone")

    const local = await acquireWorkspace({ kind: "auto", input: "/home/u/project" }, deps())
    expect(local.origin).toBe("local-path")
  })

  it("refuses a git-url spec that names a path", async () => {
    await expect(
      acquireWorkspace({ kind: "git-url", url: "/home/u/project" }, deps())
    ).rejects.toThrow(/is a path, not a remote/)
  })

  it("records the commit a local checkout is at", async () => {
    // Without this, `changedSince` has no ref to compare against and an empty
    // diff cannot be told apart from a diff nobody could compute.
    const handle = await acquireWorkspace(
      { kind: "current-project" },
      deps({ headOf: async () => "abc123" })
    )
    expect(handle.headRef).toBe("abc123")
  })

  it("records the commit a clone landed on", async () => {
    const seen: string[] = []
    const handle = await acquireWorkspace(
      { kind: "git-url", url: "https://github.com/o/r.git" },
      deps({
        headOf: async (root: string) => {
          seen.push(root)
          return "deadbee"
        },
      })
    )
    expect(handle.headRef).toBe("deadbee")
    // Asked about the checkout, not the user's open project.
    expect(seen).toEqual(["/plugins/demo/data/repos/github.com/o/r"])
  })

  it("omits headRef rather than failing when the path is not a repository", async () => {
    const handle = await acquireWorkspace(
      { kind: "current-project" },
      deps({ headOf: async () => null })
    )
    expect(handle).toEqual({
      root: "/home/u/project",
      origin: "current-project",
      ephemeral: false,
    })
    expect("headRef" in handle).toBe(false)
  })

  it("still hands back the checkout when the git bridge throws", async () => {
    // A directory we can walk and read is worth having even with no git. What
    // is lost is the ability to ask "what changed since" — not the workspace.
    const handle = await acquireWorkspace(
      { kind: "current-project" },
      deps({
        headOf: async () => {
          throw new Error("no git bridge")
        },
      })
    )
    expect(handle.root).toBe("/home/u/project")
    expect(handle.headRef).toBeUndefined()
  })

  it("reports a missing git bridge instead of returning an empty root", async () => {
    // gitCloneGuarded returns "" off-desktop; a handle rooted at "" would walk
    // the process CWD.
    await expect(
      acquireWorkspace(
        { kind: "git-url", url: "https://github.com/o/r.git" },
        deps({ clone: (async () => "") as AcquireDeps["clone"] })
      )
    ).rejects.toThrow(/cloning is unavailable/)
  })
})

describe("releaseWorkspace", () => {
  it("deletes only the cache entry for the clone it was given", async () => {
    const removed: string[][] = []
    const handle = await acquireWorkspace(
      { kind: "git-url", url: "https://github.com/pallets/flask.git" },
      deps()
    )
    await expect(
      releaseWorkspace(handle, {
        removeRepoCache: async (segments) => {
          removed.push(segments)
          return true
        },
      })
    ).resolves.toBe(true)
    expect(removed).toEqual([["github.com", "pallets", "flask"]])
  })

  it("never deletes a checkout it did not create", async () => {
    // Releasing a handle onto the user's own project must drop the reference,
    // not the directory.
    const removeRepoCache = jest.fn()
    const handle = await acquireWorkspace({ kind: "current-project" }, deps())
    await expect(releaseWorkspace(handle, { removeRepoCache })).resolves.toBe(false)
    expect(removeRepoCache).not.toHaveBeenCalled()
  })

  it("reports false when the cache entry was already gone", async () => {
    const handle = await acquireWorkspace({ kind: "auto", input: "o/r" }, deps())
    await expect(releaseWorkspace(handle, { removeRepoCache: async () => false })).resolves.toBe(
      false
    )
  })
})
