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

  it("get <dotted.path> walks nested config — the path `set` writes must read back", async () => {
    const s = sink()
    const code = await configCommand(parseArgv(["config", "get", "agentBackends.pi-rpc.model"]), {
      out: s.out,
      home: "/h",
      loadConfig: () =>
        cfg({
          agentBackends: {
            "pi-rpc": { model: "commandcode/deepseek/deepseek-v4.1-flash" },
          },
        }),
    })
    expect(code).toBe(0)
    expect(s.stdout()).toBe("commandcode/deepseek/deepseek-v4.1-flash\n")
  })

  it("get <dotted.path> prints nested objects as JSON", async () => {
    const s = sink()
    const code = await configCommand(parseArgv(["config", "get", "agentBackends.pi-rpc"]), {
      out: s.out,
      home: "/h",
      loadConfig: () =>
        cfg({
          agentBackends: {
            "pi-rpc": { model: "m-x", piExtensionPolicy: "global" },
          },
        }),
    })
    expect(code).toBe(0)
    expect(JSON.parse(s.stdout())).toEqual({ model: "m-x", piExtensionPolicy: "global" })
  })

  it("get <dotted.path> keeps redacting secrets on the way down", async () => {
    const s = sink()
    const code = await configCommand(parseArgv(["config", "get", "providers.deepseek.apiKey"]), {
      out: s.out,
      home: "/h",
      loadConfig: () => cfg({ providers: { deepseek: { apiKey: "sk-real-secret" } } }),
    })
    expect(code).toBe(0)
    expect(s.stdout()).toBe("***\n")
  })

  it("get errors when a dotted segment resolves through a non-object", async () => {
    const s = sink()
    const code = await configCommand(parseArgv(["config", "get", "provider.name"]), {
      out: s.out,
      home: "/h",
      loadConfig: () => cfg({ provider: "deepseek" }),
    })
    expect(code).toBe(2)
    expect(s.stderr()).toMatch(/unknown key "provider\.name"/)
  })

  it("get does not resolve dotted keys through the prototype chain", async () => {
    const s = sink()
    const code = await configCommand(parseArgv(["config", "get", "providers.constructor.name"]), {
      out: s.out,
      home: "/h",
      loadConfig: () => cfg({ providers: {} }),
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

  it("set providers.<id>.model routes to setProviderModel, not the flat writer", async () => {
    const s = sink()
    const setConfigValue = jest.fn()
    const setProviderModel = jest.fn().mockReturnValue("/h/config.json")
    const code = await configCommand(
      parseArgv(["config", "set", "providers.deepseek.model", "deepseek-v4.1-flash"]),
      { out: s.out, home: "/h", setConfigValue, setProviderModel }
    )
    expect(code).toBe(0)
    expect(setProviderModel).toHaveBeenCalledWith("/h", "deepseek", "deepseek-v4.1-flash")
    expect(setConfigValue).not.toHaveBeenCalled()
    expect(s.stdout()).toMatch(/Set providers\.deepseek\.model in \/h\/config\.json/)
  })

  it("set agentBackends.<preset>.model routes to the backend model writer", async () => {
    const s = sink()
    const setConfigValue = jest.fn()
    const setAgentBackendModel = jest.fn().mockReturnValue("/h/config.json")
    const code = await configCommand(
      parseArgv([
        "config",
        "set",
        "agentBackends.pi-rpc.model",
        "commandcode/deepseek/deepseek-v4.1-flash",
      ]),
      { out: s.out, home: "/h", setConfigValue, setAgentBackendModel }
    )
    expect(code).toBe(0)
    // An external backend is not a chat provider — routing to the provider
    // writer would have rewritten the built-in sidecar's remembered model.
    expect(setAgentBackendModel).toHaveBeenCalledWith(
      "/h",
      "pi-rpc",
      "commandcode/deepseek/deepseek-v4.1-flash"
    )
    expect(setConfigValue).not.toHaveBeenCalled()
  })

  it("set agentBackends.<preset>.model surfaces writer validation errors", async () => {
    const s = sink()
    const code = await configCommand(
      parseArgv(["config", "set", "agentBackends.pi-rpc.model", "not a model"]),
      {
        out: s.out,
        home: "/h",
        setAgentBackendModel: () => {
          throw new Error("model id must not be empty")
        },
      }
    )
    expect(code).toBe(2)
    expect(s.stderr()).toMatch(/model id must not be empty/)
  })

  it("set agentBackends.<preset>.piExtensionPolicy routes to the backend writer", async () => {
    const s = sink()
    const setConfigValue = jest.fn()
    const setBackendExtensionPolicy = jest.fn().mockReturnValue("/h/config.json")
    const code = await configCommand(
      parseArgv(["config", "set", "agentBackends.pi-rpc.piExtensionPolicy", "global"]),
      { out: s.out, home: "/h", setConfigValue, setBackendExtensionPolicy }
    )
    expect(code).toBe(0)
    expect(setBackendExtensionPolicy).toHaveBeenCalledWith("/h", "pi-rpc", "global")
    // The flat writer would have rejected the dotted key outright, which is how
    // this setting was unreachable from the CLI in the first place.
    expect(setConfigValue).not.toHaveBeenCalled()
  })

  it("set agentBackends.<preset>.piExtensionPolicy surfaces writer validation errors", async () => {
    const s = sink()
    const code = await configCommand(
      parseArgv(["config", "set", "agentBackends.pi-rpc.piExtensionPolicy", "wide-open"]),
      {
        out: s.out,
        home: "/h",
        setBackendExtensionPolicy: () => {
          throw new Error("invalid enum value")
        },
      }
    )
    expect(code).toBe(2)
    expect(s.stderr()).toMatch(/invalid enum value/)
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
