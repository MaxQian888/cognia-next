import fs from "node:fs"
import os from "node:os"
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
    expect(toml).toContain('cli_auth_credentials_store = "file"')
    expect(toml).toContain("requires_openai_auth = false")
    expect(toml).toContain('wire_api = "chat"')
    expect(toml).not.toContain("responses")
  })
})

describe("writeTemporaryCodexHome", () => {
  afterEach(() => jest.restoreAllMocks())

  function fakeFs(existing: string[]) {
    const writes: Array<[string, string]> = []
    const links: Array<[string, string]> = []
    const removed: string[] = []
    const checked: string[] = []
    return {
      writes,
      links,
      removed,
      checked,
      fs: {
        existsSync: (p: string) => {
          checked.push(p)
          return existing.includes(p)
        },
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

  it("uses gateway auth without probing or sharing the user's login, and preserves prompts", () => {
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
    expect(fake.links).toEqual([[path.join(home, "prompts"), "/tmp/cognia-x-codex-1/prompts"]])
    expect(fake.checked).toEqual([path.join(home, "prompts")])
    // The user's real config is never written.
    expect(fake.writes.some(([p]) => p.startsWith(home))).toBe(false)
    temp.cleanup()
    temp.cleanup()
    expect(fake.removed).toEqual(["/tmp/cognia-x-codex-1"])
  })

  it("keeps auth isolated even when the user's home contains only auth.json", () => {
    const home = "/synthetic/codex-profile"
    const fake = fakeFs([path.join(home, "auth.json")])
    const temp = writeTemporaryCodexHome(
      { gatewayBaseUrl: "http://127.0.0.1:1" },
      { userCodexHome: home, mkdtemp: () => "/tmp/cognia-x-codex-2", fs: fake.fs as never }
    )
    expect(fake.links).toEqual([])
    expect(fake.checked).toEqual([path.join(home, "prompts")])
    expect(fake.writes).toEqual([
      ["/tmp/cognia-x-codex-2/config.toml", expect.stringContaining("COGNIA_GATEWAY_KEY")],
    ])
    temp.cleanup()
    expect(fake.removed).toEqual(["/tmp/cognia-x-codex-2"])
  })

  it.each([undefined, "/synthetic/custom-codex"])(
    "isolates default filesystem wiring with CODEX_HOME=%s",
    (codexHome) => {
      const env = { ...process.env }
      if (codexHome) env.CODEX_HOME = codexHome
      else delete env.CODEX_HOME
      jest.replaceProperty(process, "env", env)
      jest.spyOn(os, "homedir").mockReturnValue("/synthetic/user")
      jest.spyOn(os, "tmpdir").mockReturnValue("/synthetic/tmp")
      const mkdtemp = jest.spyOn(fs, "mkdtempSync").mockReturnValue("/synthetic/tmp/launch")
      const exists = jest.spyOn(fs, "existsSync").mockReturnValue(false)
      jest.spyOn(fs, "mkdirSync").mockReturnValue(undefined)
      const write = jest.spyOn(fs, "writeFileSync").mockReturnValue(undefined)
      const link = jest.spyOn(fs, "symlinkSync").mockReturnValue(undefined)
      const remove = jest.spyOn(fs, "rmSync").mockReturnValue(undefined)

      const temp = writeTemporaryCodexHome({ gatewayBaseUrl: "http://127.0.0.1:1" })

      expect(mkdtemp).toHaveBeenCalledWith("/synthetic/tmp/cognia-x-codex-")
      expect(exists.mock.calls).toEqual([
        [path.join(codexHome ?? "/synthetic/user/.codex", "prompts")],
      ])
      expect(link).not.toHaveBeenCalled()
      expect(write).toHaveBeenCalledWith(
        "/synthetic/tmp/launch/config.toml",
        expect.stringContaining('cli_auth_credentials_store = "file"')
      )
      temp.cleanup()
      expect(remove).toHaveBeenCalledWith("/synthetic/tmp/launch", {
        recursive: true,
        force: true,
      })
    }
  )

  it("is dormant unless asked for", () => {
    expect(codexHomeFallbackRequested(undefined, {})).toBe(false)
    expect(codexHomeFallbackRequested(false, { COGNIA_X_CODEX_HOME_FALLBACK: "0" })).toBe(false)
    expect(codexHomeFallbackRequested(true, {})).toBe(true)
    expect(codexHomeFallbackRequested(undefined, { COGNIA_X_CODEX_HOME_FALLBACK: "1" })).toBe(true)
  })
})
