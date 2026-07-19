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

  it("emits one --allow-fs-read flag per path", () => {
    const args = nodePermissionArgs({
      ...EMPTY_SCOPE,
      readPaths: ["/etc", "/var/log"],
    })
    expect(args).toEqual(["--permission", "--allow-fs-read=/etc", "--allow-fs-read=/var/log"])
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

  it("rejects network host grants because Node has no host-scoped network flag", () => {
    expect(() =>
      nodePermissionArgs({
        permissions: [],
        readPaths: [],
        writePaths: [],
        netHosts: ["api.example.com"],
        allowedSubprocesses: [],
      })
    ).toThrow(/network grants require a scoped host broker/)
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
    ).toThrow(/subprocess grants require a scoped host broker/)
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
  it("launches through the native host and returns a stoppable process proxy", async () => {
    const hostInvoker = jest
      .fn()
      .mockResolvedValueOnce({
        command: "/opt/node26/bin/node",
        argv: ["--permission", "--allow-fs-read=/plugins/demo", "/plugins/demo/index.mjs"],
        generation: "11111111-1111-4111-8111-111111111111",
        activation: { calls: [], hooks: {}, exports: {} },
      })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(undefined)
    const result = await launchPluginJs({
      pluginId: "demo.node",
      entryPath: "index.mjs",
      cwd: "/plugins/demo",
      scope: {
        permissions: ["filesystem:read"],
        readPaths: ["/plugins/demo"],
        writePaths: [],
        netHosts: [],
        allowedSubprocesses: [],
      },
      hostInvoker,
    })

    expect(hostInvoker).toHaveBeenNthCalledWith(1, "plugin_launch_js", {
      pluginId: "demo.node",
      pluginPath: "/plugins/demo",
      entry: "index.mjs",
      extraArgs: [],
    })
    await expect(result.process.isRunning()).resolves.toBe(true)
    await result.process.kill()
    expect(hostInvoker).toHaveBeenNthCalledWith(2, "plugin_js_status", {
      pluginId: "demo.node",
      generation: "11111111-1111-4111-8111-111111111111",
    })
    expect(hostInvoker).toHaveBeenNthCalledWith(3, "plugin_stop_js", {
      pluginId: "demo.node",
      generation: "11111111-1111-4111-8111-111111111111",
    })
    expect(result.process.killed).toBe(true)
  })

  it("rejects missing plugin ids and entry paths before spawning", async () => {
    const hostInvoker = jest.fn()

    await expect(
      launchPluginJs({
        pluginId: " ",
        entryPath: "index.mjs",
        cwd: "/plugins/demo",
        scope: EMPTY_SCOPE,
        hostInvoker,
      })
    ).rejects.toThrow(/pluginId is required/)

    await expect(
      launchPluginJs({
        pluginId: "demo.node",
        entryPath: " ",
        cwd: "/plugins/demo",
        scope: EMPTY_SCOPE,
        hostInvoker,
      })
    ).rejects.toThrow(/entryPath is required/)

    expect(hostInvoker).not.toHaveBeenCalled()
  })

  it("rejects a missing installed plugin root before spawning", async () => {
    const hostInvoker = jest.fn()

    await expect(
      launchPluginJs({
        pluginId: "demo.node",
        entryPath: "index.mjs",
        scope: EMPTY_SCOPE,
        hostInvoker,
      })
    ).rejects.toThrow(/cwd is required/)

    expect(hostInvoker).not.toHaveBeenCalled()
  })

  it("rejects wildcard argv values after building the full launch command", async () => {
    await expect(
      launchPluginJs({
        pluginId: "demo.node",
        entryPath: "index.mjs",
        cwd: "/plugins/demo",
        scope: EMPTY_SCOPE,
        extraArgs: ["*"],
        hostInvoker: jest.fn(),
      })
    ).rejects.toThrow(/wildcard grants are forbidden/)
  })
})
