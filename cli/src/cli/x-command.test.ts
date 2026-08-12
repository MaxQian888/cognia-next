/**
 * Unit tests for `cli/src/cli/x-command.ts`.
 */

import { parseArgv } from "./args"
import { xCommand } from "./x-command"
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
        mode: "desktop-gateway" as const,
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
})
