/**
 * Unit tests for `cli/src/cli/x-command.ts`.
 */

import { parseArgv } from "./args"
import {
  executionFingerprintFor,
  findBaseUrl,
  ticketRequestFor,
  xCommand,
  type XCommandDeps,
} from "./x-command"
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

describe("xCommand launch isolation, gateway and proxy", () => {
  type LaunchConfig = Parameters<typeof import("../x/agent-launcher").launchAgent>[0]
  type ConnectDeps = Parameters<typeof import("../x/gateway-connect").connectGateway>[1]

  function harness(argv: string[], overrides: Partial<XCommandDeps> = {}) {
    const { sink, lines, errors } = createOutput()
    let launchConfig: LaunchConfig | undefined
    let connectDeps: ConnectDeps | undefined
    let proxyConfig: import("../x/proxy-server").ProxyConfig | undefined
    let shutdowns = 0
    const run = () =>
      xCommand(parseArgv(argv), {
        out: sink,
        env: {},
        detect: async () => ({ installed: true, path: "/usr/bin/claude" }),
        loadConfig: () => ({ ...MOCK_CONFIG, cliHome: "/home/u/.cognia" }),
        selectModel: async () => "m",
        connect: async (cfg, deps) => {
          connectDeps = deps
          proxyConfig = typeof cfg === "function" ? cfg() : cfg
          return {
            baseUrl: "http://127.0.0.1:47823",
            apiKey: "sk-cognia-rt-1",
            shutdown: async () => {
              shutdowns += 1
            },
            mode: "desktop-gateway-ticket" as const,
          }
        },
        launchHome: (input) => ({
          mode: "isolated",
          profile: input.profile ?? "default",
          dir: `/home/u/.cognia/x/${input.agent}/${input.profile ?? "default"}`,
          env: {
            CLAUDE_CONFIG_DIR: `/home/u/.cognia/x/${input.agent}/${input.profile ?? "default"}`,
          },
        }),
        launch: async (cfg) => {
          launchConfig = cfg
          return 0
        },
        ...overrides,
      })
    return {
      run,
      lines,
      errors,
      get launchConfig() {
        return launchConfig
      },
      get connectDeps() {
        return connectDeps
      },
      get proxyConfig() {
        return proxyConfig
      },
      get shutdowns() {
        return shutdowns
      },
    }
  }

  it("isolates the launch by default and prints where", async () => {
    const h = harness(["x", "claude", "--model", "m"])
    expect(await h.run()).toBe(0)
    expect(h.launchConfig!.homeEnv).toEqual({
      CLAUDE_CONFIG_DIR: "/home/u/.cognia/x/claude/default",
    })
    expect(h.lines.join("")).toContain('isolated profile "default"')
    expect(h.lines.join("")).toContain("Egress proxy: direct (no proxy configured)")
  })

  it("passes --profile and --shared-home to the home resolver", async () => {
    const inputs: Array<Parameters<typeof import("../x/launch-home").resolveLaunchHome>[0]> = []
    const h = harness(["x", "claude", "--model", "m", "--profile", "work", "--shared-home"], {
      launchHome: (input) => {
        inputs.push(input)
        return { mode: "shared", dir: "/home/u/.claude", env: {} }
      },
    })
    await h.run()
    expect(inputs[0]).toMatchObject({
      agent: "claude",
      cliHome: "/home/u/.cognia",
      profile: "work",
      shared: true,
      gatewayBaseUrl: "http://127.0.0.1:47823",
      model: "m",
    })
    expect(h.launchConfig!.homeEnv).toEqual({})
    expect(h.lines.join("")).toContain("shared with your own agent")
  })

  it("rejects a bad profile before launching and still shuts the gateway down", async () => {
    const { LaunchProfileError } = await import("../x/launch-home")
    let launched = false
    const h = harness(["x", "claude", "--model", "m", "--profile", "../x"], {
      launchHome: () => {
        throw new LaunchProfileError("../x")
      },
      launch: async () => {
        launched = true
        return 0
      },
    })
    expect(await h.run()).toBe(2)
    expect(launched).toBe(false)
    expect(h.shutdowns).toBe(1)
    expect(h.errors.join("")).toContain('profile "../x"')
  })

  it("routes --gateway (and the config gateway) into the connection", async () => {
    const flag = harness(["x", "claude", "--model", "m", "--gateway", "http://127.0.0.1:5555"])
    await flag.run()
    expect(flag.connectDeps!.gatewayUrl).toBe("http://127.0.0.1:5555")

    const configured = harness(["x", "claude", "--model", "m"], {
      loadConfig: () => ({
        ...MOCK_CONFIG,
        agentBackends: { claude: { model: "m", gateway: "http://localhost:6666" } },
      }),
    })
    await configured.run()
    expect(configured.connectDeps!.gatewayUrl).toBe("http://localhost:6666")
  })

  it("hands --proxy to the local proxy's upstream hop and to the agent's environment", async () => {
    const h = harness([
      "x",
      "claude",
      "--model",
      "m",
      "--proxy",
      "socks5://user:pw@127.0.0.1:1080",
      "--proxy-bypass",
      ".corp",
    ])
    await h.run()
    expect(h.proxyConfig!.egress).toEqual({
      endpoint: {
        protocol: "socks5",
        host: "127.0.0.1",
        port: 1080,
        username: "user",
        password: "pw",
      },
      bypass: ["localhost", "127.0.0.1", "::1", ".corp"],
    })
    expect(h.launchConfig!.proxyEnv).toEqual({
      set: {
        HTTPS_PROXY: "socks5://user:pw@127.0.0.1:1080",
        https_proxy: "socks5://user:pw@127.0.0.1:1080",
        HTTP_PROXY: "socks5://user:pw@127.0.0.1:1080",
        http_proxy: "socks5://user:pw@127.0.0.1:1080",
        ALL_PROXY: "socks5://user:pw@127.0.0.1:1080",
        all_proxy: "socks5://user:pw@127.0.0.1:1080",
        NO_PROXY: "localhost,127.0.0.1,::1,.corp",
        no_proxy: "localhost,127.0.0.1,::1,.corp",
      },
      unset: [],
    })
    // The banner never shows the password.
    expect(h.lines.join("")).not.toContain("pw@")
    expect(h.lines.join("")).toContain("socks5://127.0.0.1:1080 via --proxy")
  })

  it("reads the proxy from config and lets --proxy off override an inherited one", async () => {
    const configured = harness(["x", "claude", "--model", "m"], {
      env: { HTTPS_PROXY: "http://shell:1" },
      loadConfig: () => ({
        ...MOCK_CONFIG,
        agentBackends: {
          claude: { model: "m", proxy: "http://cfg:3128", proxyBypass: ["10.0.0.0/8"] },
        },
      }),
    })
    await configured.run()
    expect(configured.proxyConfig!.egress).toMatchObject({
      endpoint: { protocol: "http", host: "cfg", port: 3128 },
      bypass: ["localhost", "127.0.0.1", "::1", "10.0.0.0/8"],
    })

    const off = harness(["x", "claude", "--model", "m", "--proxy", "off"], {
      env: { HTTPS_PROXY: "http://shell:1" },
    })
    await off.run()
    expect(off.proxyConfig!.egress).toBeNull()
    expect(off.launchConfig!.proxyEnv!.unset).toContain("HTTPS_PROXY")
  })

  it("stops on an unusable proxy value before touching the gateway", async () => {
    let connected = false
    const h = harness(["x", "claude", "--model", "m", "--proxy", "ftp://nope:21"], {
      connect: async () => {
        connected = true
        throw new Error("unreachable")
      },
    })
    expect(await h.run()).toBe(2)
    expect(connected).toBe(false)
    expect(h.errors.join("")).toContain("--proxy: ")
  })

  it("dials a configured provider baseURL from the fallback proxy", () => {
    expect(
      findBaseUrl(
        { relay: { protocol: "anthropic", baseURL: "https://relay.example/anthropic" } },
        "anthropic"
      )
    ).toBe("https://relay.example/anthropic")
    expect(findBaseUrl({ relay: { protocol: "anthropic" } }, "anthropic")).toBeUndefined()
  })
})
