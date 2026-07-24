/** @jest-environment node */
import path from "node:path"

import {
  agentSearchDirs,
  fallbackInstallDirs,
  resolveAgentSearchPath,
  type AgentPathRuntime,
} from "./agent-path"

const runtime = (over: Partial<AgentPathRuntime> = {}): AgentPathRuntime => ({
  platform: "linux",
  home: "/home/user",
  env: {},
  ...over,
})

describe("external-agent path resolution", () => {
  it("covers the per-user package-manager roots a minimal PATH omits", () => {
    const dirs = fallbackInstallDirs(runtime())
    for (const relative of [
      ".local/bin",
      ".bun/bin",
      ".cargo/bin",
      ".volta/bin",
      ".npm-global/bin",
      ".deno/bin",
      "Library/pnpm",
      ".nix-profile/bin",
    ]) {
      expect(dirs).toContain(path.join("/home/user", ...relative.split("/")))
    }
    // The launchd-invisible system roots are always searched off Windows.
    expect(dirs).toEqual(
      expect.arrayContaining(["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"])
    )
  })

  it("honors explicit package-manager env roots ahead of the guessed home ones", () => {
    const dirs = fallbackInstallDirs(
      runtime({
        env: {
          PNPM_HOME: "/pm/pnpm",
          BUN_INSTALL: "/pm/bun",
          VOLTA_HOME: "/pm/volta",
          NVM_BIN: "/pm/nvm/versions/node/v22/bin",
          CARGO_HOME: "/pm/cargo",
        },
      })
    )
    expect(dirs).toContain("/pm/pnpm")
    expect(dirs).toContain(path.join("/pm/bun", "bin"))
    expect(dirs).toContain(path.join("/pm/volta", "bin"))
    expect(dirs).toContain("/pm/nvm/versions/node/v22/bin")
    expect(dirs).toContain(path.join("/pm/cargo", "bin"))
    // Env roots come before the home-relative fallbacks.
    expect(dirs.indexOf("/pm/pnpm")).toBeLessThan(
      dirs.indexOf(path.join("/home/user", ".local", "bin"))
    )
  })

  it("skips empty env roots and the home block when HOME is unset", () => {
    const dirs = fallbackInstallDirs(runtime({ home: undefined, env: { PNPM_HOME: "" } }))
    expect(dirs).not.toContain("")
    expect(dirs.some((dir) => dir.includes(".local"))).toBe(false)
    // System roots still apply without a home.
    expect(dirs).toContain("/opt/homebrew/bin")
  })

  it("omits the posix system roots on Windows", () => {
    const dirs = fallbackInstallDirs(runtime({ platform: "win32", home: "C:/Users/u" }))
    expect(dirs).not.toContain("/opt/homebrew/bin")
    expect(dirs).not.toContain("/usr/local/bin")
  })

  it("keeps PATH first and in order, deduped, then appends the fallback roots", () => {
    const p = ["/usr/bin", "/usr/local/bin", "/usr/bin"].join(path.delimiter)
    const dirs = agentSearchDirs(runtime({ env: { PATH: p } }))
    // Every PATH entry preserved, in PATH order, ahead of any fallback-only root.
    expect(dirs.slice(0, 2)).toEqual(["/usr/bin", "/usr/local/bin"])
    // No duplicates, PATH repeats included.
    expect(new Set(dirs).size).toBe(dirs.length)
    // The home fallback root is present even though PATH omitted it.
    expect(dirs).toContain(path.join("/home/user", ".local", "bin"))
    // /usr/local/bin appears once even though it is in both PATH and the fallbacks.
    expect(dirs.filter((dir) => dir === "/usr/local/bin")).toHaveLength(1)
  })

  it("tolerates a missing PATH", () => {
    const dirs = agentSearchDirs(runtime({ env: {} }))
    expect(dirs).toContain("/opt/homebrew/bin")
  })

  it("joins the resolved dirs with the platform delimiter", () => {
    const joined = resolveAgentSearchPath(runtime({ env: { PATH: "/usr/bin" } }))
    expect(joined.split(path.delimiter)).toEqual(
      agentSearchDirs(runtime({ env: { PATH: "/usr/bin" } }))
    )
    expect(joined.startsWith("/usr/bin")).toBe(true)
  })
})
