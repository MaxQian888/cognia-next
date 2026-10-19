import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  CODEX_GATEWAY_WIRE_API,
  codexHomeFallbackRequested,
  migrateCodexProfileConfigToml,
  renderCodexConfigToml,
  splitTomlKey,
  writeTemporaryCodexHome,
} from "./codex-config"

describe("renderCodexConfigToml", () => {
  it("points the cognia provider at the gateway's /v1 with the responses wire", () => {
    const toml = renderCodexConfigToml("http://127.0.0.1:47823/", "gpt-5")
    expect(toml).toContain('model_provider = "cognia"')
    expect(toml).toContain('model = "gpt-5"')
    expect(toml).toContain('base_url = "http://127.0.0.1:47823/v1"')
    expect(toml).toContain('env_key = "COGNIA_GATEWAY_KEY"')
    expect(toml).toContain('cli_auth_credentials_store = "file"')
    expect(toml).toContain("requires_openai_auth = false")
    expect(toml).toContain('wire_api = "responses"')
    expect(toml).not.toContain('"chat"')
    expect(CODEX_GATEWAY_WIRE_API).toBe("responses")
  })

  it("is already current: migrating a fresh render changes nothing", () => {
    const toml = renderCodexConfigToml("http://127.0.0.1:47823", "gpt-5")
    expect(migrateCodexProfileConfigToml(toml)).toEqual({ text: toml, migrated: false })
  })
})

describe("splitTomlKey", () => {
  it.each([
    ["wire_api", ["wire_api"]],
    ["model_providers.cognia", ["model_providers", "cognia"]],
    [" model_providers . cognia ", ["model_providers", "cognia"]],
    ['"model_providers".cognia', ["model_providers", "cognia"]],
    ["model_providers.'cognia'", ["model_providers", "cognia"]],
    ['"a.b".c', ["a.b", "c"]],
    ['projects."/Users/u/repo"', ["projects", "/Users/u/repo"]],
  ])("splits %s", (raw, parts) => {
    expect(splitTomlKey(raw)).toEqual(parts)
  })

  it.each(["", "a..b", "a b", '"open', '"a" b', 'a"b"', "a.", ".a", "a=b"])("refuses %j", (raw) => {
    expect(splitTomlKey(raw)).toBeNull()
  })
})

describe("migrateCodexProfileConfigToml", () => {
  // What `cognia-agent x codex` wrote before the wire changed.
  const LEGACY = [
    "# Written by cognia-agent x codex for ONE launch. Not your ~/.codex/config.toml.",
    'model_provider = "cognia"',
    'cli_auth_credentials_store = "file"',
    'model = "o3"',
    "",
    "[model_providers.cognia]",
    'name = "Cognia gateway"',
    'base_url = "http://127.0.0.1:47823/v1"',
    'env_key = "COGNIA_GATEWAY_KEY"',
    "requires_openai_auth = false",
    'wire_api = "chat"',
    "",
  ].join("\n")

  it("rewrites the legacy launcher file to the responses wire and nothing else", () => {
    const { text, migrated } = migrateCodexProfileConfigToml(LEGACY)
    expect(migrated).toBe(true)
    expect(text).toBe(LEGACY.replace('wire_api = "chat"', 'wire_api = "responses"'))
  })

  it("keeps what Codex and the user added to the profile", () => {
    const input = [
      LEGACY.trimEnd() + "  # pinned by hand",
      "",
      '[projects."/Users/u/repo"]',
      'trust_level = "trusted"',
      "",
      "[mcp_servers.docs]",
      'command = "npx"',
      'args = ["-y", "docs-mcp"]',
      "",
    ].join("\n")
    const { text, migrated } = migrateCodexProfileConfigToml(input)
    expect(migrated).toBe(true)
    expect(text).toBe(
      input.replace(
        'wire_api = "chat"  # pinned by hand',
        'wire_api = "responses"  # pinned by hand'
      )
    )
  })

  it("preserves CRLF line endings and indentation", () => {
    const input = '[model_providers.cognia]\r\n  wire_api   =   "chat"\r\nname = "x"\r\n'
    expect(migrateCodexProfileConfigToml(input)).toEqual({
      text: '[model_providers.cognia]\r\n  wire_api   =   "responses"\r\nname = "x"\r\n',
      migrated: true,
    })
  })

  it("understands single quotes, quoted table names and dotted keys", () => {
    expect(
      migrateCodexProfileConfigToml("[\"model_providers\".'cognia']\nwire_api = 'chat'\n").text
    ).toBe('["model_providers".\'cognia\']\nwire_api = "responses"\n')
    expect(
      migrateCodexProfileConfigToml('[model_providers]\ncognia.wire_api = "chat"\n').text
    ).toBe('[model_providers]\ncognia.wire_api = "responses"\n')
    expect(migrateCodexProfileConfigToml('model_providers.cognia.wire_api = "chat"\n').text).toBe(
      'model_providers.cognia.wire_api = "responses"\n'
    )
  })

  it("rewrites an inline cognia provider table", () => {
    const input =
      '[model_providers]\ncognia = { name = "Cognia gateway", wire_api = "chat", base_url = "x" }\n'
    expect(migrateCodexProfileConfigToml(input)).toEqual({
      text: input.replace('wire_api = "chat"', 'wire_api = "responses"'),
      migrated: true,
    })
  })

  it("leaves another provider's chat wire to the user", () => {
    const input = '[model_providers.ollama]\nwire_api = "chat"\n'
    expect(migrateCodexProfileConfigToml(input)).toEqual({ text: input, migrated: false })
    const inline = '[model_providers]\nollama = { wire_api = "chat" }\n'
    expect(migrateCodexProfileConfigToml(inline)).toEqual({ text: inline, migrated: false })
  })

  it("only rewrites the provider's own key, not a value that merely says chat", () => {
    const input = [
      "[model_providers.cognia]",
      'name = "chat"',
      'wire_api = "chat-ish"',
      "[model_providers.cognia.http_headers]",
      'wire_api = "chat"',
      "",
    ].join("\n")
    expect(migrateCodexProfileConfigToml(input)).toEqual({ text: input, migrated: false })
  })

  it("ignores a header-like line inside a multi-line string", () => {
    const input = [
      'developer_instructions = """',
      "[model_providers.cognia]",
      'wire_api = "chat"',
      '"""',
      "[model_providers.cognia]",
      'wire_api = "chat"',
      "",
    ].join("\n")
    const { text, migrated } = migrateCodexProfileConfigToml(input)
    expect(migrated).toBe(true)
    expect(text.split("\n")).toEqual([
      'developer_instructions = """',
      "[model_providers.cognia]",
      'wire_api = "chat"',
      '"""',
      "[model_providers.cognia]",
      'wire_api = "responses"',
      "",
    ])
  })

  it("leaves a file without a cognia provider byte-for-byte alone", () => {
    for (const input of ["", "\n", 'model = "gpt-5"\n', "[[profiles]]\nname = 'x'\n"]) {
      expect(migrateCodexProfileConfigToml(input)).toEqual({ text: input, migrated: false })
    }
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
