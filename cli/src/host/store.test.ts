import {
  EMPTY_HOSTS,
  HOSTS_MODE,
  addHost,
  hostsPath,
  normalizeEndpoint,
  parseHostsFile,
  projectHostsPath,
  redactHost,
  removeHost,
  activateHost,
  writeHostsFile,
  type HostRecord,
  type HostsFs,
} from "./store"

function memoryFs(): HostsFs & { files: Map<string, { content: string; mode: number }> } {
  const files = new Map<string, { content: string; mode: number }>()
  return {
    files,
    read: (target) => files.get(target)?.content ?? null,
    write: (target, content, mode) => {
      files.set(target, { content, mode })
    },
    mkdirp: () => undefined,
    dirname: (target) => target.split("/").slice(0, -1).join("/"),
  }
}

const HEADLESS: HostRecord = { kind: "headless", endpoint: "https://127.0.0.1:27890" }

describe("paths", () => {
  it("puts hosts.json beside credentials.json in the CLI home", () => {
    expect(hostsPath("/home/x/.cognia")).toBe("/home/x/.cognia/hosts.json")
  })

  it("puts the project file under .cognia in the working directory", () => {
    expect(projectHostsPath("/repo")).toBe("/repo/.cognia/hosts.json")
  })
})

describe("normalizeEndpoint", () => {
  it("drops trailing slashes so path concatenation never doubles them", () => {
    expect(normalizeEndpoint("https://host:1/")).toBe("https://host:1")
    expect(normalizeEndpoint("  https://host:1///  ")).toBe("https://host:1")
  })
})

describe("parseHostsFile", () => {
  it("returns an empty file for a missing one", () => {
    expect(parseHostsFile(null)).toEqual({ version: 1, hosts: {} })
  })

  it("returns an empty file rather than throwing on malformed JSON", () => {
    expect(parseHostsFile("{not json")).toEqual({ version: 1, hosts: {} })
  })

  it("keeps the records that parse and drops only the broken ones", () => {
    const file = parseHostsFile(
      JSON.stringify({ hosts: { good: HEADLESS, bad: { kind: "headless" }, worse: 5 } })
    )
    expect(Object.keys(file.hosts)).toEqual(["good"])
  })

  it("ignores an active name that no record backs", () => {
    const file = parseHostsFile(JSON.stringify({ active: "ghost", hosts: { good: HEADLESS } }))
    expect(file.active).toBeUndefined()
  })

  it("defaults an unrecognised kind to headless rather than inventing one", () => {
    const file = parseHostsFile(
      JSON.stringify({ hosts: { x: { kind: "carrier-pigeon", endpoint: "https://h" } } })
    )
    expect(file.hosts.x.kind).toBe("headless")
  })

  it("carries the device identity through", () => {
    const file = parseHostsFile(
      JSON.stringify({
        hosts: {
          phone: {
            kind: "device",
            endpoint: "https://h",
            deviceId: "dev_1",
            devicePrivateKeyJwk: { kty: "EC" },
            serverFingerprint: "aa",
          },
        },
      })
    )
    expect(file.hosts.phone).toMatchObject({
      kind: "device",
      deviceId: "dev_1",
      serverFingerprint: "aa",
    })
    expect(file.hosts.phone.devicePrivateKeyJwk).toEqual({ kty: "EC" })
  })
})

describe("mutations", () => {
  it("makes the first host active without an explicit use", () => {
    const file = addHost(EMPTY_HOSTS, "local", HEADLESS)
    expect(file.active).toBe("local")
  })

  it("leaves the active host alone when adding a second one", () => {
    const first = addHost(EMPTY_HOSTS, "local", HEADLESS)
    const second = addHost(first, "prod", { ...HEADLESS, endpoint: "https://prod" })
    expect(second.active).toBe("local")
    expect(Object.keys(second.hosts)).toEqual(["local", "prod"])
  })

  it("activates on request", () => {
    const first = addHost(EMPTY_HOSTS, "local", HEADLESS)
    const second = addHost(
      first,
      "prod",
      { ...HEADLESS, endpoint: "https://prod" },
      { activate: true }
    )
    expect(second.active).toBe("prod")
  })

  it("normalizes the endpoint on the way in", () => {
    const file = addHost(EMPTY_HOSTS, "local", { ...HEADLESS, endpoint: "https://h/" })
    expect(file.hosts.local.endpoint).toBe("https://h")
  })

  it("refuses to use or remove a host that does not exist", () => {
    expect(activateHost(EMPTY_HOSTS, "ghost").error).toContain("ghost")
    expect(removeHost(EMPTY_HOSTS, "ghost").error).toContain("ghost")
  })

  it("moves active to a survivor when the active host is removed", () => {
    let file = addHost(EMPTY_HOSTS, "local", HEADLESS)
    file = addHost(file, "prod", { ...HEADLESS, endpoint: "https://prod" })
    const removed = removeHost(file, "local")
    expect(removed.error).toBeUndefined()
    expect(removed.file.active).toBe("prod")
  })

  it("leaves no active host when the last one is removed", () => {
    const file = addHost(EMPTY_HOSTS, "local", HEADLESS)
    expect(removeHost(file, "local").file.active).toBeUndefined()
  })
})

describe("writeHostsFile", () => {
  it("writes owner-only permissions because the file carries a private key", () => {
    const fsx = memoryFs()
    writeHostsFile("/home/.cognia/hosts.json", addHost(EMPTY_HOSTS, "local", HEADLESS), fsx)
    expect(fsx.files.get("/home/.cognia/hosts.json")!.mode).toBe(HOSTS_MODE)
  })

  it("round-trips through parse", () => {
    const fsx = memoryFs()
    const file = addHost(EMPTY_HOSTS, "local", HEADLESS)
    writeHostsFile("/h/hosts.json", file, fsx)
    expect(parseHostsFile(fsx.files.get("/h/hosts.json")!.content)).toEqual(file)
  })
})

describe("redactHost", () => {
  it("replaces the secrets with a presence marker", () => {
    const redacted = redactHost({
      ...HEADLESS,
      serviceToken: "super-secret",
      devicePrivateKeyJwk: { kty: "EC", d: "secret" },
    })
    expect(redacted.serviceToken).toBe("(set)")
    expect(redacted.devicePrivateKey).toBe("(set)")
    expect(JSON.stringify(redacted)).not.toContain("super-secret")
    expect(JSON.stringify(redacted)).not.toContain("secret")
  })

  it("says nothing about a secret that is not set", () => {
    const redacted = redactHost(HEADLESS)
    expect(redacted).not.toHaveProperty("serviceToken")
    expect(redacted).not.toHaveProperty("devicePrivateKey")
  })
})
