import {
  buildLaunchArgv,
  deriveScopeFromManifest,
  launchPluginJs,
  nodePermissionArgs,
  type NodePermissionScope,
} from "./launchPluginJs"

const EMPTY_SCOPE: NodePermissionScope = {
  permissions: [],
  readPaths: [],
  writePaths: [],
  netHosts: [],
  allowedSubprocesses: [],
}

describe("nodePermissionArgs", () => {
  it("always emits --permission as the first arg", () => {
    expect(nodePermissionArgs(EMPTY_SCOPE)[0]).toBe("--permission")
  })

  it("omits read/write/net/child flags when their lists are empty", () => {
    expect(nodePermissionArgs(EMPTY_SCOPE)).toEqual(["--permission"])
  })

  it("emits --allow-fs-read with a comma-joined list", () => {
    const args = nodePermissionArgs({
      ...EMPTY_SCOPE,
      readPaths: ["/etc", "/var/log"],
    })
    expect(args).toContain("--allow-fs-read=/etc,/var/log")
  })

  it("emits scoped filesystem read and write flags when fully populated", () => {
    const args = nodePermissionArgs({
      permissions: [],
      readPaths: ["/r"],
      writePaths: ["/w"],
      netHosts: [],
      allowedSubprocesses: [],
    })
    expect(args).toEqual(["--permission", "--allow-fs-read=/r", "--allow-fs-write=/w"])
  })

  it("does not emit wildcards — empty list ≠ allow all", () => {
    const args = nodePermissionArgs(EMPTY_SCOPE)
    expect(args.join(" ")).not.toContain("*")
  })

  it("drops wildcard grant values instead of emitting Node allow-all flags", () => {
    const args = nodePermissionArgs({
      permissions: [],
      readPaths: ["*"],
      writePaths: ["/tmp", "*"],
      netHosts: ["*"],
      allowedSubprocesses: ["*"],
    })
    expect(args).toEqual(["--permission", "--allow-fs-write=/tmp"])
    expect(args.join(" ")).not.toContain("*")
  })

  it("rejects network host grants because Node 24 has no scoped network flag", () => {
    expect(() =>
      nodePermissionArgs({
        permissions: [],
        readPaths: [],
        writePaths: [],
        netHosts: ["api.example.com"],
        allowedSubprocesses: [],
      })
    ).toThrow(/network grants require a host broker/)
  })

  it("rejects subprocess allowlists instead of emitting broad child-process access", () => {
    expect(() =>
      nodePermissionArgs({
        permissions: [],
        readPaths: [],
        writePaths: [],
        netHosts: [],
        allowedSubprocesses: ["git"],
      })
    ).toThrow(/subprocess grants require a host broker/)
  })
})

describe("deriveScopeFromManifest", () => {
  it("treats missing concrete inputs as empty lists, not wildcards", () => {
    const scope = deriveScopeFromManifest(["filesystem:read"], {})
    expect(scope.readPaths).toEqual([])
    expect(scope.writePaths).toEqual([])
    expect(scope.netHosts).toEqual([])
    expect(scope.allowedSubprocesses).toEqual([])
  })

  it("passes concrete lists through verbatim", () => {
    const scope = deriveScopeFromManifest(["filesystem:write"], {
      writePaths: ["/tmp", "/cache"],
    })
    expect(scope.writePaths).toEqual(["/tmp", "/cache"])
  })
})

describe("buildLaunchArgv", () => {
  it("places node-permission flags before the entry path", () => {
    const argv = buildLaunchArgv("./entry.mjs", {
      ...EMPTY_SCOPE,
      readPaths: ["/r"],
    })
    expect(argv).toEqual(["--permission", "--allow-fs-read=/r", "./entry.mjs"])
  })

  it("appends extra args after the entry path", () => {
    const argv = buildLaunchArgv("./entry.mjs", EMPTY_SCOPE, ["--flag", "value"])
    expect(argv).toEqual(["--permission", "./entry.mjs", "--flag", "value"])
  })
})

describe("launchPluginJs", () => {
  const originalNode24Path = process.env.COGNIA_NODE24_PATH
  const originalFallbackNode24Path = process.env.NODE24_PATH

  afterEach(() => {
    if (originalNode24Path === undefined) {
      delete process.env.COGNIA_NODE24_PATH
    } else {
      process.env.COGNIA_NODE24_PATH = originalNode24Path
    }
    if (originalFallbackNode24Path === undefined) {
      delete process.env.NODE24_PATH
    } else {
      process.env.NODE24_PATH = originalFallbackNode24Path
    }
  })

  it("spawns the plugin entry through buildLaunchArgv under the selected node binary", async () => {
    const on = jest.fn()
    const child = { pid: 42, killed: false, kill: jest.fn(), on } as never
    const spawn = jest.fn(() => child)
    const result = await launchPluginJs({
      pluginId: "demo.node",
      entryPath: "/plugins/demo/index.mjs",
      nodePath: "/opt/node24/bin/node",
      scope: {
        permissions: ["filesystem:read"],
        readPaths: ["/plugins/demo"],
        writePaths: [],
        netHosts: [],
        allowedSubprocesses: [],
      },
      spawn,
    })

    expect(result.argv).toEqual([
      "--permission",
      "--allow-fs-read=/plugins/demo",
      "/plugins/demo/index.mjs",
    ])
    expect(spawn).toHaveBeenCalledWith(
      "/opt/node24/bin/node",
      result.argv,
      expect.objectContaining({
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    )
    expect(result.process).toBe(child)
  })

  it("resolves the Node 24 binary from COGNIA_NODE24_PATH when no explicit path is provided", async () => {
    process.env.COGNIA_NODE24_PATH = "/opt/cognia/node24"
    const child = { pid: 7, killed: false, kill: jest.fn(), on: jest.fn() } as never
    const spawn = jest.fn(() => child)

    const result = await launchPluginJs({
      pluginId: "demo.node",
      entryPath: "/plugins/demo/index.mjs",
      scope: EMPTY_SCOPE,
      spawn,
    })

    expect(result.command).toBe("/opt/cognia/node24")
    expect(spawn).toHaveBeenCalledWith(
      "/opt/cognia/node24",
      ["--permission", "/plugins/demo/index.mjs"],
      expect.any(Object)
    )
  })

  it("falls back to NODE24_PATH when COGNIA_NODE24_PATH is unset", async () => {
    delete process.env.COGNIA_NODE24_PATH
    process.env.NODE24_PATH = "/opt/node24"
    const child = { pid: 8, killed: false, kill: jest.fn(), on: jest.fn() } as never
    const spawn = jest.fn(() => child)

    const result = await launchPluginJs({
      pluginId: "demo.node",
      entryPath: "/plugins/demo/index.mjs",
      scope: EMPTY_SCOPE,
      spawn,
    })

    expect(result.command).toBe("/opt/node24")
  })

  it("uses the current Node 24 process when no env override is configured", async () => {
    delete process.env.COGNIA_NODE24_PATH
    delete process.env.NODE24_PATH
    const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10)
    if (major < 24) return
    const child = { pid: 9, killed: false, kill: jest.fn(), on: jest.fn() } as never
    const spawn = jest.fn(() => child)

    const result = await launchPluginJs({
      pluginId: "demo.node",
      entryPath: "/plugins/demo/index.mjs",
      scope: EMPTY_SCOPE,
      spawn,
    })

    expect(result.command).toBe(process.execPath)
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ["--permission", "/plugins/demo/index.mjs"],
      expect.any(Object)
    )
  })

  it("rejects missing plugin ids and entry paths before spawning", async () => {
    const spawn = jest.fn()

    await expect(
      launchPluginJs({
        pluginId: " ",
        entryPath: "/plugins/demo/index.mjs",
        scope: EMPTY_SCOPE,
        spawn,
      })
    ).rejects.toThrow(/pluginId is required/)

    await expect(
      launchPluginJs({
        pluginId: "demo.node",
        entryPath: " ",
        scope: EMPTY_SCOPE,
        spawn,
      })
    ).rejects.toThrow(/entryPath is required/)

    expect(spawn).not.toHaveBeenCalled()
  })

  it("rejects wildcard argv values after building the full launch command", async () => {
    await expect(
      launchPluginJs({
        pluginId: "demo.node",
        entryPath: "/plugins/demo/index.mjs",
        nodePath: "/opt/node24/bin/node",
        scope: EMPTY_SCOPE,
        extraArgs: ["*"],
        spawn: jest.fn(),
      })
    ).rejects.toThrow(/wildcard grants are forbidden/)
  })
})
