import { describeResolution, mergeHosts, resolveHost } from "./resolve"
import { EMPTY_HOSTS, addHost, type HostRecord, type HostsFile, type HostsFs } from "./store"

const HOME = "/home/.cognia"
const CWD = "/repo"
const USER_PATH = `${HOME}/hosts.json`
const PROJECT_PATH = `${CWD}/.cognia/hosts.json`

function fsWith(files: Record<string, HostsFile>): HostsFs {
  return {
    read: (target) => (files[target] ? JSON.stringify(files[target]) : null),
    write: () => undefined,
    mkdirp: () => undefined,
    dirname: (target) => target.split("/").slice(0, -1).join("/"),
  }
}

const LOCAL: HostRecord = {
  kind: "headless",
  endpoint: "https://127.0.0.1:27890",
  serviceToken: "svc-token",
}

function withHosts(file: HostsFile) {
  return fsWith({ [USER_PATH]: file })
}

describe("mergeHosts", () => {
  it("lets a project record replace a user record wholesale", () => {
    const user = addHost(EMPTY_HOSTS, "prod", { kind: "headless", endpoint: "https://user" })
    const project = addHost(EMPTY_HOSTS, "prod", {
      kind: "device",
      endpoint: "https://project",
      deviceId: "dev_1",
    })
    const merged = mergeHosts(user, project)
    // Splicing fields across records would let a project file borrow a
    // credential the user saved for a different host.
    expect(merged.hosts.prod).toEqual(project.hosts.prod)
  })

  it("lets the project file pick the active host", () => {
    const user = addHost(EMPTY_HOSTS, "a", { kind: "headless", endpoint: "https://a" })
    const project = addHost(EMPTY_HOSTS, "b", { kind: "headless", endpoint: "https://b" })
    expect(mergeHosts(user, project).active).toBe("b")
  })

  it("ignores a project active name that no record backs", () => {
    const user = addHost(EMPTY_HOSTS, "a", { kind: "headless", endpoint: "https://a" })
    const merged = mergeHosts(user, { version: 1, active: "ghost", hosts: {} })
    expect(merged.active).toBe("a")
  })
})

describe("resolveHost", () => {
  it("uses the active saved host when nothing else is given", () => {
    const resolution = resolveHost({
      home: HOME,
      cwd: CWD,
      env: {},
      fs: withHosts(addHost(EMPTY_HOSTS, "local", LOCAL)),
    })
    expect(resolution.host?.name).toBe("local")
    expect(resolution.host?.endpoint).toMatchObject({ value: LOCAL.endpoint, source: "user-file" })
    expect(resolution.host?.serviceToken).toMatchObject({ value: "svc-token", source: "user-file" })
  })

  it("lets --endpoint beat every saved and environment value", () => {
    const resolution = resolveHost({
      endpoint: "https://override/",
      home: HOME,
      cwd: CWD,
      env: { COGNIA_SERVER_URL: "https://from-env" },
      fs: withHosts(addHost(EMPTY_HOSTS, "local", LOCAL)),
    })
    expect(resolution.host?.endpoint).toMatchObject({ value: "https://override", source: "flag" })
  })

  it("lets the environment beat a saved host", () => {
    const resolution = resolveHost({
      home: HOME,
      cwd: CWD,
      env: { COGNIA_ENDPOINT: "https://from-env" },
      fs: withHosts(addHost(EMPTY_HOSTS, "local", LOCAL)),
    })
    expect(resolution.host?.endpoint).toMatchObject({ source: "env", origin: "COGNIA_ENDPOINT" })
  })

  it("prefers COGNIA_ENDPOINT over the older COGNIA_SERVER_URL", () => {
    const resolution = resolveHost({
      home: HOME,
      cwd: CWD,
      env: { COGNIA_ENDPOINT: "https://new", COGNIA_SERVER_URL: "https://old" },
      fs: withHosts(EMPTY_HOSTS),
    })
    expect(resolution.host?.endpoint.value).toBe("https://new")
  })

  it("never sends a saved token to an endpoint that record does not describe", () => {
    const resolution = resolveHost({
      endpoint: "https://somewhere-else",
      home: HOME,
      cwd: CWD,
      env: {},
      fs: withHosts(addHost(EMPTY_HOSTS, "local", LOCAL)),
    })
    expect(resolution.host?.endpoint.value).toBe("https://somewhere-else")
    expect(resolution.host?.serviceToken).toBeUndefined()
    expect(resolution.host?.record).toBeUndefined()
  })

  it("still uses the saved token when --endpoint names the same host", () => {
    const resolution = resolveHost({
      endpoint: "https://127.0.0.1:27890/",
      home: HOME,
      cwd: CWD,
      env: {},
      fs: withHosts(addHost(EMPTY_HOSTS, "local", LOCAL)),
    })
    expect(resolution.host?.serviceToken?.value).toBe("svc-token")
  })

  it("reads the token from the environment ahead of the saved one", () => {
    const resolution = resolveHost({
      home: HOME,
      cwd: CWD,
      env: { COGNIA_SERVICE_TOKEN: "env-token" },
      fs: withHosts(addHost(EMPTY_HOSTS, "local", LOCAL)),
    })
    expect(resolution.host?.serviceToken).toMatchObject({
      value: "env-token",
      origin: "COGNIA_SERVICE_TOKEN",
    })
  })

  it("accepts the local-debug token as a service credential", () => {
    const resolution = resolveHost({
      home: HOME,
      cwd: CWD,
      env: { COGNIA_ENDPOINT: "https://h", COGNIA_LOCAL_DEBUG_TOKEN: "debug-token" },
      fs: withHosts(EMPTY_HOSTS),
    })
    expect(resolution.host?.serviceToken).toMatchObject({ origin: "COGNIA_LOCAL_DEBUG_TOKEN" })
  })

  it("selects a named profile over the active one", () => {
    let file = addHost(EMPTY_HOSTS, "local", LOCAL)
    file = addHost(file, "prod", { kind: "device", endpoint: "https://prod", deviceId: "d" })
    const resolution = resolveHost({
      profile: "prod",
      home: HOME,
      cwd: CWD,
      env: {},
      fs: withHosts(file),
    })
    expect(resolution.host?.name).toBe("prod")
    expect(resolution.host?.kind.value).toBe("device")
  })

  it("takes the profile from COGNIA_PROFILE when no flag is given", () => {
    let file = addHost(EMPTY_HOSTS, "local", LOCAL)
    file = addHost(file, "prod", { kind: "headless", endpoint: "https://prod" })
    const resolution = resolveHost({
      home: HOME,
      cwd: CWD,
      env: { COGNIA_PROFILE: "prod" },
      fs: withHosts(file),
    })
    expect(resolution.host?.name).toBe("prod")
  })

  it("names the known hosts when the requested profile is missing", () => {
    const resolution = resolveHost({
      profile: "ghost",
      home: HOME,
      cwd: CWD,
      env: {},
      fs: withHosts(addHost(EMPTY_HOSTS, "local", LOCAL)),
    })
    expect(resolution.skipped.some((leg) => leg.reason.includes("local"))).toBe(true)
  })

  it("prefers the project file over the user file", () => {
    const fsx = fsWith({
      [USER_PATH]: addHost(EMPTY_HOSTS, "local", LOCAL),
      [PROJECT_PATH]: addHost(EMPTY_HOSTS, "local", {
        kind: "headless",
        endpoint: "https://staging",
      }),
    })
    const resolution = resolveHost({ home: HOME, cwd: CWD, env: {}, fs: fsx })
    expect(resolution.host?.endpoint).toMatchObject({
      value: "https://staging",
      source: "project-file",
      origin: PROJECT_PATH,
    })
  })

  it("resolves nothing and says why when there is no host anywhere", () => {
    const resolution = resolveHost({ home: HOME, cwd: CWD, env: {}, fs: withHosts(EMPTY_HOSTS) })
    expect(resolution.host).toBeUndefined()
    expect(resolution.skipped.map((leg) => leg.leg)).toEqual(["saved host", "environment"])
  })

  it("assumes the headless wire for a bare endpoint with no saved record", () => {
    const resolution = resolveHost({
      home: HOME,
      cwd: CWD,
      env: { COGNIA_ENDPOINT: "https://h" },
      fs: withHosts(EMPTY_HOSTS),
    })
    expect(resolution.host?.kind).toMatchObject({ value: "headless", source: "default" })
  })
})

describe("describeResolution", () => {
  it("reports a source for every value and never prints the token", () => {
    const resolution = resolveHost({
      home: HOME,
      cwd: CWD,
      env: {},
      fs: withHosts(addHost(EMPTY_HOSTS, "local", { ...LOCAL, tenantId: "tnt_1" })),
    })
    const rows = describeResolution(resolution.host!)
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]))
    expect(byKey.endpoint.source).toBe("user-file")
    expect(byKey.tenantId.value).toBe("tnt_1")
    expect(byKey.serviceToken.value).toBe("(set)")
    expect(JSON.stringify(rows)).not.toContain("svc-token")
    expect(rows.every((row) => row.source.length > 0)).toBe(true)
  })
})
