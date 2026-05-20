import {
  buildLaunchArgv,
  deriveScopeFromManifest,
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

  it("emits all four flags when fully populated", () => {
    const args = nodePermissionArgs({
      permissions: [],
      readPaths: ["/r"],
      writePaths: ["/w"],
      netHosts: ["api.example.com"],
      allowedSubprocesses: ["git", "curl"],
    })
    expect(args).toEqual([
      "--permission",
      "--allow-fs-read=/r",
      "--allow-fs-write=/w",
      "--allow-net=api.example.com",
      "--allow-child-process=git,curl",
    ])
  })

  it("does not emit wildcards — empty list ≠ allow all", () => {
    const args = nodePermissionArgs(EMPTY_SCOPE)
    expect(args.join(" ")).not.toContain("*")
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
