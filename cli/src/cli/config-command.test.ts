/**
 * @jest-environment node
 */
import { configCommand } from "./config-command"
import { parseArgv } from "./args"
import type { OutputSink } from "./output"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"

function sink() {
  const stdout: string[] = []
  const stderr: string[] = []
  const jsonl: unknown[] = []
  const out: OutputSink = {
    write: (t) => stdout.push(t),
    error: (t) => stderr.push(t),
    json: (o) => jsonl.push(o),
  }
  return { out, stdout: () => stdout.join(""), stderr: () => stderr.join(""), jsonl }
}

function cfg(p: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
    providers: {},
    cwd: "/work",
    ...p,
  }
}

describe("configCommand", () => {
  it("path prints both file locations", async () => {
    const s = sink()
    const code = await configCommand(parseArgv(["config", "path"]), {
      out: s.out,
      home: "/h/.cognia",
    })
    expect(code).toBe(0)
    expect(s.stdout()).toMatch(/config:/)
    expect(s.stdout()).toMatch(/credentials:/)
  })

  it("get prints the redacted resolved config as JSON", async () => {
    const s = sink()
    const code = await configCommand(parseArgv(["config", "get"]), {
      out: s.out,
      home: "/h",
      loadConfig: () =>
        cfg({
          providers: {
            anthropic: { apiKey: "sk-secret", authToken: "oauth-secret" },
          },
        }),
    })
    expect(code).toBe(0)
    const printed = s.jsonl[0] as {
      providers: Record<string, { apiKey?: string; authToken?: string }>
    }
    expect(printed.providers.anthropic.apiKey).toBe("***") // never leak the key
    expect(printed.providers.anthropic.authToken).toBe("***")
  })

  it("get <key> prints a single value", async () => {
    const s = sink()
    await configCommand(parseArgv(["config", "get", "provider"]), {
      out: s.out,
      home: "/h",
      loadConfig: () => cfg({ provider: "openai" }),
    })
    expect(s.stdout()).toBe("openai\n")
  })

  it("get unknown key errors with exit 2", async () => {
    const s = sink()
    const code = await configCommand(parseArgv(["config", "get", "nope"]), {
      out: s.out,
      home: "/h",
      loadConfig: () => cfg(),
    })
    expect(code).toBe(2)
  })

  it("set writes the value via the injected writer", async () => {
    const s = sink()
    const setConfigValue = jest.fn().mockReturnValue("/h/config.json")
    const code = await configCommand(parseArgv(["config", "set", "model", "claude-x"]), {
      out: s.out,
      home: "/h",
      setConfigValue,
    })
    expect(code).toBe(0)
    expect(setConfigValue).toHaveBeenCalledWith("/h", "model", "claude-x")
  })

  it("set providers.<id>.baseURL routes to setProviderBaseURL, not the flat writer", async () => {
    const s = sink()
    const setConfigValue = jest.fn()
    const setProviderBaseURL = jest.fn().mockReturnValue("/h/config.json")
    const code = await configCommand(
      parseArgv(["config", "set", "providers.deepseek.baseURL", "https://relay.example.com/v1"]),
      { out: s.out, home: "/h", setConfigValue, setProviderBaseURL }
    )
    expect(code).toBe(0)
    expect(setProviderBaseURL).toHaveBeenCalledWith(
      "/h",
      "deepseek",
      "https://relay.example.com/v1"
    )
    expect(setConfigValue).not.toHaveBeenCalled()
    expect(s.stdout()).toMatch(/Set providers\.deepseek\.baseURL in \/h\/config\.json/)
  })

  it("set providers.<id>.baseURL surfaces writer validation errors", async () => {
    const s = sink()
    const code = await configCommand(
      parseArgv(["config", "set", "providers.deepseek.baseURL", "not-a-url"]),
      {
        out: s.out,
        home: "/h",
        setProviderBaseURL: () => {
          throw new Error("Invalid url")
        },
      }
    )
    expect(code).toBe(2)
    expect(s.stderr()).toMatch(/Invalid url/)
  })

  it("set without a value errors with exit 2", async () => {
    const s = sink()
    const code = await configCommand(parseArgv(["config", "set", "model"]), {
      out: s.out,
      home: "/h",
    })
    expect(code).toBe(2)
    expect(s.stderr()).toMatch(/config set <key> <value>/)
  })

  it("set surfaces writer validation errors", async () => {
    const s = sink()
    const code = await configCommand(parseArgv(["config", "set", "bogus", "x"]), {
      out: s.out,
      home: "/h",
      setConfigValue: () => {
        throw new Error('unknown config key "bogus"')
      },
    })
    expect(code).toBe(2)
    expect(s.stderr()).toMatch(/unknown config key/)
  })

  it("errors on an unknown subcommand", async () => {
    const s = sink()
    const code = await configCommand(parseArgv(["config"]), { out: s.out, home: "/h" })
    expect(code).toBe(2)
  })
})
