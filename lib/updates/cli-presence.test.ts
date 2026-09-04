/** @jest-environment jsdom */
import {
  detectInstalledCli,
  isSelfManagedInstall,
  packageManagerFromPath,
  parseCliVersion,
} from "./cli-presence"

describe("parseCliVersion", () => {
  it("pulls a version out of a noisy line", () => {
    expect(parseCliVersion("cognia-agent 0.4.2 (build abc)")).toBe("0.4.2")
  })

  it("keeps a prerelease suffix", () => {
    expect(parseCliVersion("0.5.0-beta.3")).toBe("0.5.0-beta.3")
  })

  it("returns null when nothing looks like a version", () => {
    expect(parseCliVersion("unknown")).toBeNull()
    expect(parseCliVersion(null)).toBeNull()
  })
})

describe("packageManagerFromPath", () => {
  it.each([
    ["/Users/x/.bun/bin/cognia-agent", "bun"],
    ["/Users/x/Library/pnpm/cognia-agent", "pnpm"],
    ["/Users/x/.yarn/bin/cognia-agent", "yarn"],
    ["/usr/local/lib/node_modules/@cognia/agent-cli/dist/cognia-agent.mjs", "npm"],
    ["C:\\\\Users\\\\x\\\\AppData\\\\Roaming\\\\npm\\\\cognia-agent.cmd", "npm"],
  ])("maps %s to %s", (path, manager) => {
    expect(packageManagerFromPath(path)).toBe(manager)
  })

  it("answers unknown rather than guessing", () => {
    expect(packageManagerFromPath("/opt/custom/bin/cognia-agent")).toBe("unknown")
    expect(packageManagerFromPath(null)).toBe("unknown")
  })
})

describe("isSelfManagedInstall", () => {
  it("recognises an npx run", () => {
    expect(isSelfManagedInstall("/Users/x/.npm/_npx/abc/node_modules/.bin/cognia-agent")).toBe(true)
  })

  it("recognises the desktop sidecar", () => {
    expect(isSelfManagedInstall("/Applications/Cognia.app/Contents/Resources/cognia-agent")).toBe(
      true
    )
  })

  it("recognises a development checkout", () => {
    expect(isSelfManagedInstall("/repo/cli/dist/cognia-agent.mjs")).toBe(true)
  })

  it("leaves a real global install alone", () => {
    expect(isSelfManagedInstall("/usr/local/lib/node_modules/@cognia/agent-cli/dist/x.mjs")).toBe(
      false
    )
  })
})

describe("detectInstalledCli", () => {
  it("reports nothing installed without inventing a version", async () => {
    const result = await detectInstalledCli(async () => ({
      available: false,
      version: null,
      path: null,
      error: "web",
    }))
    expect(result).toMatchObject({ available: false, version: null, manager: "unknown" })
  })

  it("resolves version and owner for a global npm install", async () => {
    const result = await detectInstalledCli(async () => ({
      available: true,
      version: "cognia-agent 0.4.2",
      path: "/usr/local/lib/node_modules/@cognia/agent-cli/dist/cognia-agent.mjs",
      error: null,
    }))
    expect(result).toMatchObject({ available: true, version: "0.4.2", manager: "npm" })
    expect(result.selfManaged).toBe(false)
  })

  it("never names a package manager for a self-managed install", async () => {
    const result = await detectInstalledCli(async () => ({
      available: true,
      version: "0.4.2",
      path: "/Applications/Cognia.app/Contents/Resources/cognia-agent",
      error: null,
    }))
    expect(result.selfManaged).toBe(true)
    expect(result.manager).toBe("unknown")
  })
})
