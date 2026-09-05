import { parseArgv } from "./args"
import { EXIT_OK, EXIT_FAILURE, EXIT_USAGE } from "./errors"
import { hostCommand, HOST_HELP, type HostCommandDeps } from "./host-command"
import type { OutputSink } from "./output"
import { parseHostsFile, type HostsFs } from "../host/store"

const HOME = "/home/.cognia"
const CWD = "/repo"
const USER_FILE = `${HOME}/hosts.json`
const PROJECT_FILE = `${CWD}/.cognia/hosts.json`

function sink(): OutputSink & { stdout: string; stderr: string[] } {
  const captured = {
    stdout: "",
    stderr: [] as string[],
    write(text: string) {
      captured.stdout += text
    },
    error(text: string) {
      captured.stderr.push(text)
    },
    json(value: unknown) {
      captured.stdout += `${JSON.stringify(value)}\n`
    },
  }
  return captured
}

function memoryFs(): HostsFs & { files: Map<string, string>; modes: Map<string, number> } {
  const files = new Map<string, string>()
  const modes = new Map<string, number>()
  return {
    files,
    modes,
    read: (target) => files.get(target) ?? null,
    write: (target, content, mode) => {
      files.set(target, content)
      modes.set(target, mode)
    },
    mkdirp: () => undefined,
    dirname: (target) => target.split("/").slice(0, -1).join("/"),
  }
}

function deps(extra: Partial<HostCommandDeps> = {}): HostCommandDeps & {
  out: ReturnType<typeof sink>
  fs: ReturnType<typeof memoryFs>
} {
  const out = sink()
  const fs = memoryFs()
  return { out, fs, env: {}, home: HOME, cwd: CWD, ...extra } as never
}

function run(argv: string[], commandDeps: HostCommandDeps): Promise<number> {
  return hostCommand(parseArgv(argv), commandDeps)
}

describe("help and paths", () => {
  it("prints help and exits 2 with no subcommand", async () => {
    const d = deps()
    expect(await run(["host"], d)).toBe(EXIT_USAGE)
    expect(d.out.stdout).toBe(HOST_HELP)
  })

  it("names both files and which one a write would land in", async () => {
    const d = deps()
    await run(["host", "path", "--format", "raw"], d)
    expect(JSON.parse(d.out.stdout)).toEqual({
      user: USER_FILE,
      project: PROJECT_FILE,
      writing: USER_FILE,
    })
  })

  it("points at the project file under --local", async () => {
    const d = deps()
    await run(["host", "path", "--local", "--format", "raw"], d)
    expect(JSON.parse(d.out.stdout).writing).toBe(PROJECT_FILE)
  })
})

describe("host add", () => {
  it("writes a host and makes the first one active", async () => {
    const d = deps()
    expect(await run(["host", "add", "local", "--endpoint", "https://127.0.0.1:27890/"], d)).toBe(
      EXIT_OK
    )
    const stored = parseHostsFile(d.fs.files.get(USER_FILE)!)
    expect(stored.active).toBe("local")
    expect(stored.hosts.local).toEqual({ kind: "headless", endpoint: "https://127.0.0.1:27890" })
  })

  it("stores the token but never prints it back", async () => {
    const d = deps()
    await run(
      [
        "host",
        "add",
        "local",
        "--endpoint",
        "https://h",
        "--token",
        "super-secret",
        "--format",
        "raw",
      ],
      d
    )
    expect(parseHostsFile(d.fs.files.get(USER_FILE)!).hosts.local.serviceToken).toBe("super-secret")
    expect(d.out.stdout).toContain('"serviceToken":"(set)"')
    expect(d.out.stdout).not.toContain("super-secret")
  })

  it("writes owner-only permissions", async () => {
    const d = deps()
    await run(["host", "add", "local", "--endpoint", "https://h"], d)
    expect(d.fs.modes.get(USER_FILE)).toBe(0o600)
  })

  it("needs a name and an endpoint", async () => {
    const d = deps()
    expect(await run(["host", "add", "local"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("--endpoint")
  })

  it("refuses an unknown kind", async () => {
    const d = deps()
    expect(await run(["host", "add", "x", "--endpoint", "https://h", "--kind", "pigeon"], d)).toBe(
      EXIT_USAGE
    )
    expect(d.out.stderr[0]).toContain("headless or device")
  })

  it("activates the new host under --use", async () => {
    const d = deps()
    await run(["host", "add", "a", "--endpoint", "https://a"], d)
    await run(["host", "add", "b", "--endpoint", "https://b", "--use"], d)
    expect(parseHostsFile(d.fs.files.get(USER_FILE)!).active).toBe("b")
  })

  it("writes to the project file under --local", async () => {
    const d = deps()
    await run(["host", "add", "staging", "--endpoint", "https://s", "--local"], d)
    expect(d.fs.files.has(PROJECT_FILE)).toBe(true)
    expect(d.fs.files.has(USER_FILE)).toBe(false)
  })
})

describe("host list, use and remove", () => {
  it("lists hosts with the active one marked and secrets redacted", async () => {
    const d = deps()
    await run(["host", "add", "a", "--endpoint", "https://a", "--token", "t"], d)
    await run(["host", "add", "b", "--endpoint", "https://b"], d)
    d.out.stdout = ""
    await run(["host", "list", "--format", "raw"], d)
    const rows = JSON.parse(d.out.stdout) as Array<Record<string, string>>
    expect(rows.map((row) => row.name)).toEqual(["a", "b"])
    expect(rows[0].active).toBe("yes")
    expect(rows[0].serviceToken).toBe("(set)")
    expect(d.out.stdout).not.toContain('"t"')
  })

  it("switches the active host", async () => {
    const d = deps()
    await run(["host", "add", "a", "--endpoint", "https://a"], d)
    await run(["host", "add", "b", "--endpoint", "https://b"], d)
    expect(await run(["host", "use", "b"], d)).toBe(EXIT_OK)
    expect(parseHostsFile(d.fs.files.get(USER_FILE)!).active).toBe("b")
  })

  it("refuses to use a host that does not exist", async () => {
    const d = deps()
    expect(await run(["host", "use", "ghost"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("ghost")
  })

  it("removes a host and reports the survivor", async () => {
    const d = deps()
    await run(["host", "add", "a", "--endpoint", "https://a"], d)
    await run(["host", "add", "b", "--endpoint", "https://b"], d)
    d.out.stdout = ""
    await run(["host", "remove", "a", "--format", "raw"], d)
    expect(JSON.parse(d.out.stdout)).toMatchObject({ removed: "a", active: "b" })
  })
})

describe("host show", () => {
  it("reports the source of every resolved value", async () => {
    const d = deps()
    await run(["host", "add", "local", "--endpoint", "https://h", "--token", "t"], d)
    d.out.stdout = ""
    await run(["host", "show", "--format", "raw"], d)
    const rows = JSON.parse(d.out.stdout) as Array<Record<string, string>>
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]))
    expect(byKey.endpoint.source).toBe("user-file")
    expect(byKey.serviceToken.value).toBe("(set)")
  })

  it("shows the environment winning over the saved value", async () => {
    const d = deps({ env: { COGNIA_SERVICE_TOKEN: "env-token" } })
    await run(["host", "add", "local", "--endpoint", "https://h", "--token", "saved"], d)
    d.out.stdout = ""
    await run(["host", "show", "--format", "raw"], d)
    const rows = JSON.parse(d.out.stdout) as Array<Record<string, string>>
    const token = rows.find((row) => row.key === "serviceToken")!
    expect(token.source).toBe("env")
    expect(token.origin).toBe("COGNIA_SERVICE_TOKEN")
  })

  it("explains what it tried when nothing resolves", async () => {
    const d = deps()
    expect(await run(["host", "show"], d)).toBe(EXIT_FAILURE)
    expect(d.out.stderr[0]).toContain("Cause: no-host")
    expect(d.out.stderr[0]).toContain("Fix: cognia-agent host add")
  })
})

describe("host login", () => {
  it("saves the paired device identity and keeps the key out of stdout", async () => {
    const d = deps({
      login: {
        fetchConfig: async () =>
          ({ deploymentMode: "single-user", hostId: "host_1", tenantId: "tnt_1" }) as never,
        register: async () =>
          ({
            baseUrl: "https://h",
            deviceId: "dev_9",
            devicePrivateKeyJwk: { kty: "EC", d: "PRIVATE" },
            deviceKeyThumbprint: "thumb",
            serverVersion: "1",
          }) as never,
      },
    })
    expect(
      await run(
        [
          "host",
          "login",
          "desktop",
          "--endpoint",
          "https://h",
          "--pair-code",
          "ABC",
          "--format",
          "raw",
        ],
        d
      )
    ).toBe(EXIT_OK)
    const stored = parseHostsFile(d.fs.files.get(USER_FILE)!)
    expect(stored.hosts.desktop).toMatchObject({
      kind: "device",
      deviceId: "dev_9",
      tenantId: "tnt_1",
    })
    expect(stored.hosts.desktop.devicePrivateKeyJwk).toEqual({ kty: "EC", d: "PRIVATE" })
    expect(d.out.stdout).toContain('"devicePrivateKey":"(set)"')
    expect(d.out.stdout).not.toContain("PRIVATE")
  })

  it("needs a name, an endpoint and a pairing code", async () => {
    const d = deps()
    expect(await run(["host", "login", "desktop", "--endpoint", "https://h"], d)).toBe(EXIT_USAGE)
    expect(d.out.stderr[0]).toContain("--pair-code")
  })

  it("sends a multi-tenant host to the OIDC flow instead of guessing", async () => {
    const d = deps({
      login: {
        fetchConfig: async () => ({ deploymentMode: "multi-tenant", hostId: "h" }) as never,
      },
    })
    expect(
      await run(["host", "login", "cloud", "--endpoint", "https://h", "--pair-code", "X"], d)
    ).toBe(EXIT_FAILURE)
    expect(d.out.stderr[0]).toContain("logto login")
  })

  it("says a pairing code is single-use when the host refuses", async () => {
    const d = deps({
      login: {
        fetchConfig: async () =>
          ({ deploymentMode: "single-user", hostId: "h", tenantId: "t" }) as never,
        register: async () => {
          throw new Error("invitation_consumed")
        },
      },
    })
    expect(
      await run(["host", "login", "desktop", "--endpoint", "https://h", "--pair-code", "X"], d)
    ).toBe(EXIT_FAILURE)
    expect(d.out.stderr[0]).toContain("single-use")
    expect(d.out.stderr[0]).toContain("invitation_consumed")
  })

  it("reports an unreachable host with the fingerprint hint", async () => {
    const d = deps({
      login: {
        fetchConfig: async () => {
          throw new Error("self signed certificate")
        },
      },
    })
    expect(
      await run(["host", "login", "desktop", "--endpoint", "https://h", "--pair-code", "X"], d)
    ).toBe(EXIT_FAILURE)
    expect(d.out.stderr[0]).toContain("--fingerprint")
  })
})
