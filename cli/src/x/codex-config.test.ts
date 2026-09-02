import path from "node:path"

import {
  codexHomeFallbackRequested,
  renderCodexConfigToml,
  writeTemporaryCodexHome,
} from "./codex-config"

describe("renderCodexConfigToml", () => {
  it("points the cognia provider at the gateway's /v1 with the chat wire", () => {
    const toml = renderCodexConfigToml("http://127.0.0.1:47823/", "gpt-5")
    expect(toml).toContain('model_provider = "cognia"')
    expect(toml).toContain('model = "gpt-5"')
    expect(toml).toContain('base_url = "http://127.0.0.1:47823/v1"')
    expect(toml).toContain('env_key = "COGNIA_GATEWAY_KEY"')
    expect(toml).toContain('wire_api = "chat"')
    expect(toml).not.toContain("responses")
  })
})

describe("writeTemporaryCodexHome", () => {
  function fakeFs(existing: string[]) {
    const writes: Array<[string, string]> = []
    const links: Array<[string, string]> = []
    const removed: string[] = []
    return {
      writes,
      links,
      removed,
      fs: {
        existsSync: (p: string) => existing.includes(p),
        writeFileSync: (p: string, data: string) => {
          writes.push([p, data])
        },
        symlinkSync: (target: string, p: string) => {
          links.push([target, p])
        },
        rmSync: (p: string) => {
          removed.push(p)
        },
        mkdirSync: () => undefined,
      },
    }
  }

  it("writes config.toml and links the user's auth.json and prompts, then cleans up once", () => {
    const home = "/home/u/.codex"
    const fake = fakeFs([path.join(home, "auth.json"), path.join(home, "prompts")])
    const temp = writeTemporaryCodexHome(
      { gatewayBaseUrl: "http://127.0.0.1:1" },
      { userCodexHome: home, mkdtemp: () => "/tmp/cognia-x-codex-1", fs: fake.fs as never }
    )
    expect(temp.dir).toBe("/tmp/cognia-x-codex-1")
    expect(fake.writes).toEqual([
      ["/tmp/cognia-x-codex-1/config.toml", expect.stringContaining("cognia")],
    ])
    expect(fake.links).toEqual([
      [path.join(home, "auth.json"), "/tmp/cognia-x-codex-1/auth.json"],
      [path.join(home, "prompts"), "/tmp/cognia-x-codex-1/prompts"],
    ])
    // The user's real config is never written.
    expect(fake.writes.some(([p]) => p.startsWith(home))).toBe(false)
    temp.cleanup()
    temp.cleanup()
    expect(fake.removed).toEqual(["/tmp/cognia-x-codex-1"])
  })

  it("is dormant unless asked for", () => {
    expect(codexHomeFallbackRequested(undefined, {})).toBe(false)
    expect(codexHomeFallbackRequested(false, { COGNIA_X_CODEX_HOME_FALLBACK: "0" })).toBe(false)
    expect(codexHomeFallbackRequested(true, {})).toBe(true)
    expect(codexHomeFallbackRequested(undefined, { COGNIA_X_CODEX_HOME_FALLBACK: "1" })).toBe(true)
  })
})
