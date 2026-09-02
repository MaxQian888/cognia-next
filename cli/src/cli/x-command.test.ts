/**
 * Unit tests for `cli/src/cli/x-command.ts`.
 */

import { parseArgv } from "./args"
import { executionFingerprintFor, ticketRequestFor, xCommand } from "./x-command"
import { GatewayCredentialError } from "../x/gateway-connect"
import type { ResolvedConfig } from "../config/schema"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"

const MOCK_CONFIG: ResolvedConfig = {
  provider: "anthropic",
  permissionMode: "default",
  builtinTools: { ...DEFAULT_BUILTIN_TOOLS },
  providers: {
    anthropic: { protocol: "anthropic", apiKey: "sk-ant-test-key" },
    openai: { protocol: "openai", apiKey: "sk-openai-test-key" },
  },
  agentBackends: {
    claude: { model: "claude-sonnet-4-20250514" },
  },
  cwd: "/workspace",
}

function createOutput() {
  const lines: string[] = []
  const errors: string[] = []
  return {
    sink: {
      write: (s: string) => lines.push(s),
      error: (s: string) => errors.push(s),
      json: (value: unknown) => lines.push(JSON.stringify(value)),
    },
    lines,
    errors,
  }
}

describe("xCommand", () => {
  it("shows help with --help", async () => {
    const { sink, lines } = createOutput()
    const args = parseArgv(["x", "--help"])
    const code = await xCommand(args, { out: sink })
    expect(code).toBe(0)
    expect(lines.join("")).toContain("cognia-agent x")
    expect(lines.join("")).toContain("claude")
    expect(lines.join("")).toContain("codex")
  })

  it("rejects unknown agent", async () => {
    const { sink, errors } = createOutput()
    const args = parseArgv(["x", "unknown-agent"])
    const code = await xCommand(args, { out: sink })
    expect(code).toBe(2)
    expect(errors.join("")).toContain("Unknown agent")
  })

  it("shows help when no agent specified", async () => {
    const { sink, errors } = createOutput()
    const args = parseArgv(["x"])
    const code = await xCommand(args, { out: sink })
    expect(code).toBe(2)
    expect(errors.join("")).toContain("cognia-agent x")
  })

  it("exits with error when agent CLI not installed", async () => {
    const { sink, errors } = createOutput()
    const args = parseArgv(["x", "claude"])
    const code = await xCommand(args, {
      out: sink,
      detect: async () => ({
        installed: false,
        installHint: "npm install -g @anthropic-ai/claude-code",
      }),
    })
    expect(code).toBe(1)
    expect(errors.join("")).toContain("not installed")
    expect(errors.join("")).toContain("npm install")
  })

  it("launches claude agent with correct config (happy path)", async () => {
    const { sink } = createOutput()
    const args = parseArgv(["x", "claude", "--model", "claude-sonnet-4-20250514"])
    let launchConfig: Parameters<typeof import("../x/agent-launcher").launchAgent>[0] | undefined

    const code = await xCommand(args, {
      out: sink,
      detect: async () => ({ installed: true, path: "/usr/bin/claude", version: "1.0.0" }),
      loadConfig: () => MOCK_CONFIG,
      selectModel: async () => "claude-sonnet-4-20250514",
      connect: async () => ({
        baseUrl: "http://127.0.0.1:47823",
        apiKey: "gw-key",
        shutdown: async () => {},
        mode: "desktop-gateway-key" as const,
      }),
      launch: async (cfg) => {
        launchConfig = cfg
        return 0
      },
    })

    expect(code).toBe(0)
    expect(launchConfig).toBeDefined()
    expect(launchConfig!.agent).toBe("claude")
    expect(launchConfig!.model).toBe("claude-sonnet-4-20250514")
    expect(launchConfig!.gatewayBaseUrl).toBe("http://127.0.0.1:47823")
    expect(launchConfig!.gatewayApiKey).toBe("gw-key")
  })

  it("launches codex agent with correct config", async () => {
    const { sink } = createOutput()
    const args = parseArgv(["x", "codex", "--model", "o3"])
    let launchConfig: Parameters<typeof import("../x/agent-launcher").launchAgent>[0] | undefined

    const code = await xCommand(args, {
      out: sink,
      detect: async () => ({ installed: true, path: "/usr/bin/codex" }),
      loadConfig: () => MOCK_CONFIG,
      selectModel: async () => "o3",
      connect: async () => ({
        baseUrl: "http://127.0.0.1:55555",
        apiKey: "proxy-key",
        shutdown: async () => {},
        mode: "node-proxy" as const,
      }),
      launch: async (cfg) => {
        launchConfig = cfg
        return 0
      },
    })

    expect(code).toBe(0)
    expect(launchConfig!.agent).toBe("codex")
    expect(launchConfig!.model).toBe("o3")
  })

  it("passes bypass flag through", async () => {
    const { sink } = createOutput()
    const args = parseArgv(["x", "claude", "--model", "test", "--bypass"])
    let launchConfig: Parameters<typeof import("../x/agent-launcher").launchAgent>[0] | undefined

    await xCommand(args, {
      out: sink,
      detect: async () => ({ installed: true, path: "/usr/bin/claude" }),
      loadConfig: () => MOCK_CONFIG,
      selectModel: async () => "test",
      connect: async () => ({
        baseUrl: "http://localhost",
        apiKey: "k",
        shutdown: async () => {},
        mode: "node-proxy" as const,
      }),
      launch: async (cfg) => {
        launchConfig = cfg
        return 0
      },
    })

    expect(launchConfig!.bypass).toBe(true)
  })

  it("passes resume flag through", async () => {
    const { sink } = createOutput()
    const args = parseArgv(["x", "claude", "--model", "test", "--resume", "session-123"])
    let launchConfig: Parameters<typeof import("../x/agent-launcher").launchAgent>[0] | undefined

    await xCommand(args, {
      out: sink,
      detect: async () => ({ installed: true, path: "/usr/bin/claude" }),
      loadConfig: () => MOCK_CONFIG,
      selectModel: async () => "test",
      connect: async () => ({
        baseUrl: "http://localhost",
        apiKey: "k",
        shutdown: async () => {},
        mode: "node-proxy" as const,
      }),
      launch: async (cfg) => {
        launchConfig = cfg
        return 0
      },
    })

    expect(launchConfig!.resume).toBe("session-123")
  })

  it("shuts down gateway even when launch fails", async () => {
    const { sink } = createOutput()
    const args = parseArgv(["x", "claude", "--model", "test"])
    let shutdownCalled = false

    const code = await xCommand(args, {
      out: sink,
      detect: async () => ({ installed: true, path: "/usr/bin/claude" }),
      loadConfig: () => MOCK_CONFIG,
      selectModel: async () => "test",
      connect: async () => ({
        baseUrl: "http://localhost",
        apiKey: "k",
        shutdown: async () => {
          shutdownCalled = true
        },
        mode: "node-proxy" as const,
      }),
      launch: async () => {
        throw new Error("spawn failed")
      },
    })

    expect(code).toBe(1)
    expect(shutdownCalled).toBe(true)
  })

  it("returns agent exit code", async () => {
    const { sink } = createOutput()
    const args = parseArgv(["x", "codex", "--model", "o3"])

    const code = await xCommand(args, {
      out: sink,
      detect: async () => ({ installed: true, path: "/usr/bin/codex" }),
      loadConfig: () => MOCK_CONFIG,
      selectModel: async () => "o3",
      connect: async () => ({
        baseUrl: "http://localhost",
        apiKey: "k",
        shutdown: async () => {},
        mode: "node-proxy" as const,
      }),
      launch: async () => 42,
    })

    expect(code).toBe(42)
  })

  it("uses --model flag directly without interactive picker", async () => {
    const { sink } = createOutput()
    const args = parseArgv(["x", "claude", "--model", "my-custom-model"])
    let selectModelCalled = false
    let launchConfig: Parameters<typeof import("../x/agent-launcher").launchAgent>[0] | undefined

    await xCommand(args, {
      out: sink,
      detect: async () => ({ installed: true, path: "/usr/bin/claude" }),
      loadConfig: () => MOCK_CONFIG,
      selectModel: async () => {
        selectModelCalled = true
        return "should-not-use-this"
      },
      connect: async () => ({
        baseUrl: "http://localhost",
        apiKey: "k",
        shutdown: async () => {},
        mode: "node-proxy" as const,
      }),
      launch: async (cfg) => {
        launchConfig = cfg
        return 0
      },
    })

    expect(selectModelCalled).toBe(false)
    expect(launchConfig!.model).toBe("my-custom-model")
  })

  it("persists model choice on successful exit (exitCode 0)", async () => {
    const { sink } = createOutput()
    const args = parseArgv(["x", "claude", "--model", "claude-opus-4-20250514"])
    let persistedModel: string | undefined
    let persistedAgent: string | undefined

    await xCommand(args, {
      out: sink,
      detect: async () => ({ installed: true, path: "/usr/bin/claude" }),
      loadConfig: () => MOCK_CONFIG,
      selectModel: async () => "claude-opus-4-20250514",
      connect: async () => ({
        baseUrl: "http://localhost",
        apiKey: "k",
        shutdown: async () => {},
        mode: "node-proxy" as const,
      }),
      launch: async () => 0,
      persistModel: (_home, agent, model) => {
        persistedAgent = agent
        persistedModel = model
        return "/tmp/config.json"
      },
    })

    expect(persistedAgent).toBe("claude")
    expect(persistedModel).toBe("claude-opus-4-20250514")
  })

  it("does NOT persist model on non-zero exit", async () => {
    const { sink } = createOutput()
    const args = parseArgv(["x", "claude", "--model", "test-model"])
    let persistCalled = false

    await xCommand(args, {
      out: sink,
      detect: async () => ({ installed: true, path: "/usr/bin/claude" }),
      loadConfig: () => MOCK_CONFIG,
      selectModel: async () => "test-model",
      connect: async () => ({
        baseUrl: "http://localhost",
        apiKey: "k",
        shutdown: async () => {},
        mode: "node-proxy" as const,
      }),
      launch: async () => 1,
      persistModel: () => {
        persistCalled = true
        return "/tmp/config.json"
      },
    })

    expect(persistCalled).toBe(false)
  })

  it("passes -- passthrough args to agent", async () => {
    const { sink } = createOutput()
    const args = parseArgv([
      "x",
      "claude",
      "--model",
      "test",
      "--",
      "--verbose",
      "--cwd",
      "/my/dir",
    ])
    let launchConfig: Parameters<typeof import("../x/agent-launcher").launchAgent>[0] | undefined

    await xCommand(args, {
      out: sink,
      detect: async () => ({ installed: true, path: "/usr/bin/claude" }),
      loadConfig: () => MOCK_CONFIG,
      selectModel: async () => "test",
      connect: async () => ({
        baseUrl: "http://localhost",
        apiKey: "k",
        shutdown: async () => {},
        mode: "node-proxy" as const,
      }),
      launch: async (cfg) => {
        launchConfig = cfg
        return 0
      },
    })

    expect(launchConfig!.passthrough).toEqual(["--verbose", "--cwd", "/my/dir"])
  })

  it("warns when no API key configured for the agent's provider", async () => {
    const { sink, errors } = createOutput()
    const configNoKeys: ResolvedConfig = {
      ...MOCK_CONFIG,
      providers: {},
    }
    const args = parseArgv(["x", "claude", "--model", "test"])

    // Temporarily remove env vars
    const origKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY

    try {
      await xCommand(args, {
        out: sink,
        detect: async () => ({ installed: true, path: "/usr/bin/claude" }),
        loadConfig: () => configNoKeys,
        selectModel: async () => "test",
        connect: async () => ({
          baseUrl: "http://localhost",
          apiKey: "k",
          shutdown: async () => {},
          mode: "node-proxy" as const,
        }),
        launch: async () => 0,
      })

      expect(errors.join("")).toContain("No API key found for Anthropic")
    } finally {
      // Always restore env (even if origKey was undefined)
      if (origKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = origKey
      }
    }
  })

  it("passes resolved binary path to launcher", async () => {
    const { sink } = createOutput()
    const args = parseArgv(["x", "claude", "--model", "test"])
    let launchConfig: Parameters<typeof import("../x/agent-launcher").launchAgent>[0] | undefined

    await xCommand(args, {
      out: sink,
      detect: async () => ({ installed: true, path: "/opt/custom/bin/claude", version: "2.0" }),
      loadConfig: () => MOCK_CONFIG,
      selectModel: async () => "test",
      connect: async () => ({
        baseUrl: "http://localhost",
        apiKey: "k",
        shutdown: async () => {},
        mode: "node-proxy" as const,
      }),
      launch: async (cfg) => {
        launchConfig = cfg
        return 0
      },
    })

    expect(launchConfig!.binaryPath).toBe("/opt/custom/bin/claude")
  })

  it("hands the gateway a ticket request and exports the ticket's bindings to the agent", async () => {
    const { sink, lines, errors } = createOutput()
    const args = parseArgv(["x", "claude", "--model", "claude-opus-5"])
    let launchConfig: Parameters<typeof import("../x/agent-launcher").launchAgent>[0] | undefined
    let connectDeps: Parameters<typeof import("../x/gateway-connect").connectGateway>[1] | undefined
    const code = await xCommand(args, {
      out: sink,
      detect: async () => ({ installed: true, path: "/usr/bin/claude", version: "1.0.0" }),
      loadConfig: () => ({ ...MOCK_CONFIG, providers: {} }),
      connect: async (_proxyConfig, deps) => {
        connectDeps = deps
        return {
          baseUrl: "http://127.0.0.1:47823",
          apiKey: "sk-cognia-rt-1",
          shutdown: async () => {},
          mode: "desktop-gateway-ticket" as const,
          modelBindings: { haiku: "claude-haiku-4-5-20251001" },
          ticketId: "rt_1",
        }
      },
      launch: async (cfg) => {
        launchConfig = cfg
        return 0
      },
      persistModel: () => {},
    })
    expect(code).toBe(0)
    expect(connectDeps?.ticketRequest).toMatchObject({
      model: "claude-opus-5",
      routePolicy: "gateway-required",
      executionFingerprint: executionFingerprintFor("claude", "claude-opus-5", "/workspace"),
    })
    expect(launchConfig?.gatewayApiKey).toBe("sk-cognia-rt-1")
    expect(launchConfig?.modelBindings).toEqual({ haiku: "claude-haiku-4-5-20251001" })
    expect(lines.join("")).toContain("cognia gateway (route ticket)")
    // No upstream-key warning in ticket mode: the gateway never needs one.
    expect(errors.join("")).not.toContain("No API key found")
  })

  it("prints the fix and exits 1 when no gateway credential can be obtained", async () => {
    const { sink, errors } = createOutput()
    const args = parseArgv(["x", "codex", "--model", "o3"])
    const code = await xCommand(args, {
      out: sink,
      detect: async () => ({ installed: true, path: "/usr/bin/codex" }),
      loadConfig: () => MOCK_CONFIG,
      connect: async () => {
        throw new GatewayCredentialError("http://127.0.0.1:47823", "bridge: desktop not running")
      },
      launch: async () => 0,
    })
    expect(code).toBe(1)
    expect(errors.join("")).toContain("desktop not running")
    expect(errors.join("")).toContain("COGNIA_GATEWAY_KEY")
  })

  it("warns about a missing upstream key only on the proxy path", async () => {
    const { sink, errors } = createOutput()
    const args = parseArgv(["x", "claude", "--model", "m"])
    await xCommand(args, {
      out: sink,
      detect: async () => ({ installed: true, path: "/usr/bin/claude" }),
      loadConfig: () => ({ ...MOCK_CONFIG, providers: {} }),
      connect: async () => ({
        baseUrl: "http://127.0.0.1:1",
        apiKey: "cgx",
        shutdown: async () => {},
        mode: "node-proxy" as const,
      }),
      launch: async () => 0,
      persistModel: () => {},
    })
    expect(errors.join("")).toContain("No API key found for Anthropic")
  })

  it("derives a stable fingerprint and a unique session id per launch", () => {
    expect(executionFingerprintFor("claude", "m", "/w")).toBe(
      executionFingerprintFor("claude", "m", "/w")
    )
    expect(executionFingerprintFor("claude", "m", "/w")).not.toBe(
      executionFingerprintFor("codex", "m", "/w")
    )
    const a = ticketRequestFor("claude", "m", "/w")
    const b = ticketRequestFor("claude", "m", "/w")
    expect(a.sessionId).not.toBe(b.sessionId)
    expect(a.executionFingerprint).toBe(b.executionFingerprint)
  })
})
