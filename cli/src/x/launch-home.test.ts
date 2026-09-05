/**
 * Unit tests for `cli/src/x/launch-home.ts`. Every filesystem call goes to an
 * in-memory fake, so no real agent home is touched.
 */

import path from "node:path"
import {
  AGENT_HOME_ENV,
  DEFAULT_PROFILE,
  LaunchProfileError,
  describeLaunchHome,
  launchHomeDir,
  resolveLaunchHome,
  sharedHomeDir,
} from "./launch-home"

function fakeFs() {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  return {
    files,
    dirs,
    fs: {
      existsSync: (p: string) => files.has(String(p)) || dirs.has(String(p)),
      mkdirSync: (p: string) => {
        dirs.add(String(p))
        return undefined
      },
      writeFileSync: (p: string, data: string | NodeJS.ArrayBufferView) => {
        files.set(String(p), String(data))
      },
    },
  }
}

const CLI_HOME = "/home/u/.cognia"
const GATEWAY = "http://127.0.0.1:47823"

describe("resolveLaunchHome", () => {
  it("isolates claude under <cliHome>/x/claude/default and seeds the onboarding flag", () => {
    const { fs, dirs, files } = fakeFs()
    const plan = resolveLaunchHome({
      agent: "claude",
      cliHome: CLI_HOME,
      gatewayBaseUrl: GATEWAY,
      fs,
    })
    const dir = launchHomeDir(CLI_HOME, "claude", DEFAULT_PROFILE)
    expect(plan).toEqual({
      mode: "isolated",
      profile: "default",
      dir,
      env: { CLAUDE_CONFIG_DIR: dir },
    })
    expect(dirs.has(dir)).toBe(true)
    expect(JSON.parse(files.get(path.join(dir, ".claude.json"))!)).toEqual({
      hasCompletedOnboarding: true,
    })
  })

  it("never overwrites a profile file that already exists", () => {
    const { fs, files } = fakeFs()
    const dir = launchHomeDir(CLI_HOME, "claude", "work")
    files.set(path.join(dir, ".claude.json"), '{"theme":"light"}')
    resolveLaunchHome({
      agent: "claude",
      cliHome: CLI_HOME,
      profile: "work",
      gatewayBaseUrl: GATEWAY,
      fs,
    })
    expect(files.get(path.join(dir, ".claude.json"))).toBe('{"theme":"light"}')
  })

  it("isolates codex under its own CODEX_HOME with a gateway config.toml", () => {
    const { fs, files } = fakeFs()
    const plan = resolveLaunchHome({
      agent: "codex",
      cliHome: CLI_HOME,
      profile: "review",
      gatewayBaseUrl: GATEWAY,
      model: "o3",
      fs,
    })
    const dir = launchHomeDir(CLI_HOME, "codex", "review")
    expect(plan).toMatchObject({ mode: "isolated", profile: "review", env: { CODEX_HOME: dir } })
    const toml = files.get(path.join(dir, "config.toml"))!
    expect(toml).toContain('model_provider = "cognia"')
    expect(toml).toContain('base_url = "http://127.0.0.1:47823/v1"')
    expect(toml).toContain('model = "o3"')
    expect(toml).toContain('wire_api = "chat"')
  })

  it("keeps profiles apart", () => {
    const { fs } = fakeFs()
    const a = resolveLaunchHome({
      agent: "claude",
      cliHome: CLI_HOME,
      profile: "a",
      gatewayBaseUrl: GATEWAY,
      fs,
    })
    const b = resolveLaunchHome({
      agent: "claude",
      cliHome: CLI_HOME,
      profile: "b",
      gatewayBaseUrl: GATEWAY,
      fs,
    })
    expect(a.dir).not.toBe(b.dir)
    expect(a.dir.startsWith(path.join(CLI_HOME, "x", "claude"))).toBe(true)
  })

  it("refuses a profile that could escape the profile root", () => {
    const { fs } = fakeFs()
    for (const bad of ["../etc", "a/b", "", " ", ".hidden", "x".repeat(65)]) {
      const attempt = () =>
        resolveLaunchHome({
          agent: "claude",
          cliHome: CLI_HOME,
          profile: bad,
          gatewayBaseUrl: GATEWAY,
          fs,
        })
      if (bad.trim() === "") {
        // Blank falls back to the default profile.
        expect(attempt().mode).toBe("isolated")
      } else {
        expect(attempt).toThrow(LaunchProfileError)
      }
    }
  })

  it("shared mode points at the user's own directory and writes nothing", () => {
    const { fs, files, dirs } = fakeFs()
    const plan = resolveLaunchHome({
      agent: "claude",
      cliHome: CLI_HOME,
      shared: true,
      gatewayBaseUrl: GATEWAY,
      env: {},
      homedir: "/home/u",
      fs,
    })
    expect(plan).toEqual({ mode: "shared", dir: "/home/u/.claude", env: {} })
    expect(files.size).toBe(0)
    expect(dirs.size).toBe(0)
  })

  it("shared mode respects an explicit agent home variable", () => {
    expect(sharedHomeDir("codex", { CODEX_HOME: "/srv/codex" }, "/home/u")).toBe("/srv/codex")
    expect(sharedHomeDir("codex", {}, "/home/u")).toBe("/home/u/.codex")
    expect(AGENT_HOME_ENV).toEqual({ claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" })
  })

  it("describes both modes for the banner", () => {
    const { fs } = fakeFs()
    const isolated = resolveLaunchHome({
      agent: "claude",
      cliHome: CLI_HOME,
      gatewayBaseUrl: GATEWAY,
      fs,
    })
    expect(describeLaunchHome(isolated)).toContain('isolated profile "default"')
    expect(describeLaunchHome({ mode: "shared", dir: "/home/u/.claude", env: {} })).toContain(
      "shared with your own agent"
    )
  })
})
