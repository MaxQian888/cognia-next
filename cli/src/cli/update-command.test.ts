import { parseArgv } from "./args"
import {
  CLI_PACKAGE,
  classifyInstall,
  fetchPublishedVersions,
  isNewer,
  PACKAGE_MANAGERS,
  updateCommand,
  upgradeCommand,
} from "./update-command"

function sink() {
  const out: string[] = []
  const errors: string[] = []
  const objects: unknown[] = []
  return {
    sink: {
      write: (t: string) => out.push(t),
      error: (t: string) => errors.push(t),
      json: (o: unknown) => objects.push(o),
    },
    out,
    errors,
    objects,
  }
}

describe("upgradeCommand", () => {
  it("uses each manager's global syntax", () => {
    expect(upgradeCommand("npm", "1.0.0")).toBe(`npm install -g ${CLI_PACKAGE}@1.0.0`)
    expect(upgradeCommand("pnpm")).toBe(`pnpm add -g ${CLI_PACKAGE}@latest`)
    expect(upgradeCommand("yarn")).toContain("yarn global add")
    expect(upgradeCommand("bun")).toContain("bun add -g")
  })

  it("never requests elevation", () => {
    for (const m of PACKAGE_MANAGERS) expect(upgradeCommand(m)).not.toContain("sudo")
  })
})

describe("classifyInstall", () => {
  it("recognises each package manager's prefix", () => {
    expect(classifyInstall("/u/.bun/bin/cognia-agent")).toEqual({ kind: "managed", manager: "bun" })
    expect(classifyInstall("/u/Library/pnpm/cognia-agent")).toEqual({
      kind: "managed",
      manager: "pnpm",
    })
    expect(classifyInstall("/u/.yarn/bin/cognia-agent")).toEqual({
      kind: "managed",
      manager: "yarn",
    })
    expect(classifyInstall("/usr/local/lib/node_modules/x/dist/a.mjs")).toEqual({
      kind: "managed",
      manager: "npm",
    })
  })

  it("refuses to upgrade an npx run", () => {
    expect(classifyInstall("/u/.npm/_npx/ab/node_modules/.bin/cognia-agent")).toEqual({
      kind: "self-managed",
      reason: "npx",
    })
  })

  it("refuses to upgrade the desktop sidecar", () => {
    expect(classifyInstall("/Applications/Cognia.app/Contents/Resources/x")).toEqual({
      kind: "self-managed",
      reason: "desktop-sidecar",
    })
  })

  it("refuses to upgrade a development checkout", () => {
    expect(classifyInstall("/repo/cli/dist/cognia-agent.mjs")).toEqual({
      kind: "self-managed",
      reason: "dev-checkout",
    })
  })

  it("answers ambiguous rather than guessing", () => {
    expect(classifyInstall("/opt/tools/cognia-agent")).toEqual({ kind: "ambiguous" })
  })
})

describe("isNewer", () => {
  it("compares numerically", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true)
    expect(isNewer("1.0.0", "1.0.0")).toBe(false)
    expect(isNewer("0.9.0", "0.10.0")).toBe(false)
  })
})

describe("fetchPublishedVersions", () => {
  it("reads the dist-tags", async () => {
    const result = await fetchPublishedVersions("https://registry.test", (async () => ({
      ok: true,
      json: async () => ({ "dist-tags": { latest: "1.2.3", beta: "1.3.0-beta.1" } }),
    })) as unknown as typeof fetch)
    expect(result).toEqual({ latest: "1.2.3", beta: "1.3.0-beta.1" })
  })

  it("returns null on a bad response rather than throwing", async () => {
    const result = await fetchPublishedVersions("https://registry.test", (async () => ({
      ok: false,
    })) as unknown as typeof fetch)
    expect(result).toBeNull()
  })

  it("returns null when the network throws", async () => {
    const result = await fetchPublishedVersions("https://registry.test", (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch)
    expect(result).toBeNull()
  })
})

describe("updateCommand", () => {
  const args = (argv: string[]) => parseArgv(argv)

  it("reports being current", async () => {
    const s = sink()
    const code = await updateCommand(args(["update"]), {
      out: s.sink,
      currentVersion: "1.0.0",
      fetchVersions: async () => ({ latest: "1.0.0" }),
    })
    expect(code).toBe(0)
    expect(s.out.join("")).toContain("up to date")
  })

  it("fails loudly when the registry is unreachable", async () => {
    const s = sink()
    const code = await updateCommand(args(["update"]), {
      out: s.sink,
      currentVersion: "1.0.0",
      fetchVersions: async () => null,
    })
    expect(code).toBe(1)
    expect(s.errors.join("")).toContain("Could not reach the registry")
  })

  it("emits machine-readable output with --json", async () => {
    const s = sink()
    await updateCommand(args(["update", "--json"]), {
      out: s.sink,
      currentVersion: "1.0.0",
      scriptPath: "/u/Library/pnpm/cognia-agent",
      fetchVersions: async () => ({ latest: "2.0.0" }),
    })
    expect(s.objects[0]).toMatchObject({
      updateAvailable: true,
      latest: "2.0.0",
      commands: [`pnpm add -g ${CLI_PACKAGE}@2.0.0`],
    })
  })

  it("explains, and offers nothing to run, for a self-managed install", async () => {
    const s = sink()
    await updateCommand(args(["update"]), {
      out: s.sink,
      currentVersion: "1.0.0",
      scriptPath: "/Applications/Cognia.app/Contents/Resources/cognia-agent",
      fetchVersions: async () => ({ latest: "2.0.0" }),
    })
    const text = s.out.join("")
    expect(text).toContain("ships inside the Cognia desktop app")
    expect(text).not.toContain("npm install -g")
  })

  it("prints every command when the source is ambiguous", async () => {
    const s = sink()
    await updateCommand(args(["update"]), {
      out: s.sink,
      currentVersion: "1.0.0",
      scriptPath: "/opt/tools/cognia-agent",
      fetchVersions: async () => ({ latest: "2.0.0" }),
    })
    const text = s.out.join("")
    for (const manager of PACKAGE_MANAGERS) expect(text).toContain(upgradeCommand(manager, "2.0.0"))
  })

  it("only prints the command for `update check`, never runs it", async () => {
    const s = sink()
    let ran = false
    await updateCommand(args(["update", "check"]), {
      out: s.sink,
      currentVersion: "1.0.0",
      scriptPath: "/u/Library/pnpm/cognia-agent",
      fetchVersions: async () => ({ latest: "2.0.0" }),
      run: async () => {
        ran = true
        return 0
      },
    })
    expect(ran).toBe(false)
    expect(s.out.join("")).toContain(`pnpm add -g ${CLI_PACKAGE}@2.0.0`)
  })

  it("does not upgrade without a yes", async () => {
    const s = sink()
    let ran = false
    await updateCommand(args(["update"]), {
      out: s.sink,
      currentVersion: "1.0.0",
      scriptPath: "/u/Library/pnpm/cognia-agent",
      fetchVersions: async () => ({ latest: "2.0.0" }),
      confirm: async () => false,
      run: async () => {
        ran = true
        return 0
      },
    })
    expect(ran).toBe(false)
    expect(s.out.join("")).toContain("Skipped")
  })

  it("delegates to the package manager once confirmed", async () => {
    const s = sink()
    const commands: string[] = []
    const code = await updateCommand(args(["update"]), {
      out: s.sink,
      currentVersion: "1.0.0",
      scriptPath: "/u/Library/pnpm/cognia-agent",
      fetchVersions: async () => ({ latest: "2.0.0" }),
      confirm: async () => true,
      run: async (command) => {
        commands.push(command)
        return 0
      },
    })
    expect(commands).toEqual([`pnpm add -g ${CLI_PACKAGE}@2.0.0`])
    expect(code).toBe(0)
  })

  it("accepts --yes for a non-interactive upgrade", async () => {
    const s = sink()
    const commands: string[] = []
    await updateCommand(args(["update", "--yes"]), {
      out: s.sink,
      currentVersion: "1.0.0",
      scriptPath: "/u/Library/pnpm/cognia-agent",
      fetchVersions: async () => ({ latest: "2.0.0" }),
      confirm: async () => {
        throw new Error("must not prompt")
      },
      run: async (command) => {
        commands.push(command)
        return 0
      },
    })
    expect(commands).toHaveLength(1)
  })

  it("propagates the package manager's exit code", async () => {
    const s = sink()
    const code = await updateCommand(args(["update", "--yes"]), {
      out: s.sink,
      currentVersion: "1.0.0",
      scriptPath: "/u/Library/pnpm/cognia-agent",
      fetchVersions: async () => ({ latest: "2.0.0" }),
      run: async () => 7,
    })
    expect(code).toBe(7)
  })
})
