/**
 * Unit tests for `cli/src/x/agent-launcher.ts`.
 */

import type { SpawnOptions } from "node:child_process"
import {
  AMBIENT_CREDENTIAL_ENV,
  buildAgentConfig,
  buildChildEnv,
  codexProviderOverrides,
  launchAgent,
} from "./agent-launcher"

describe("buildAgentConfig", () => {
  it("builds claude config with correct env and args", () => {
    const config = buildAgentConfig({
      agent: "claude",
      model: "claude-sonnet-4-20250514",
      gatewayBaseUrl: "http://127.0.0.1:54321",
      gatewayApiKey: "cgx-test",
      cwd: "/tmp",
    })
    expect(config.command).toBe("claude")
    expect(config.args).toEqual(["--model", "claude-sonnet-4-20250514"])
    expect(config.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:54321")
    // Both wire forms so either Claude Code version presents the credential.
    expect(config.env.ANTHROPIC_API_KEY).toBe("cgx-test")
    expect(config.env.ANTHROPIC_AUTH_TOKEN).toBe("cgx-test")
    // Without bindings every family selector falls back to the chosen model.
    expect(config.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4-20250514")
    expect(config.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-sonnet-4-20250514")
    expect(config.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-sonnet-4-20250514")
  })

  it("exports the ticket's family bindings to claude", () => {
    const config = buildAgentConfig({
      agent: "claude",
      model: "claude-opus-5",
      modelBindings: { primary: "claude-opus-5", haiku: "claude-haiku-4-5-20251001" },
      gatewayBaseUrl: "http://127.0.0.1:54321",
      gatewayApiKey: "sk-cognia-rt-1",
      cwd: "/tmp",
    })
    expect(config.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-4-5-20251001")
    expect(config.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-opus-5")
    expect(config.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5")
  })

  it("builds codex config with provider overrides on argv and the chat wire", () => {
    const config = buildAgentConfig({
      agent: "codex",
      model: "o3",
      gatewayBaseUrl: "http://127.0.0.1:54321",
      gatewayApiKey: "cgx-test",
      cwd: "/tmp",
    })
    expect(config.command).toBe("codex")
    expect(config.env.COGNIA_GATEWAY_KEY).toBe("cgx-test")
    expect(config.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:54321/v1")
    expect(config.env.OPENAI_API_KEY).toBeUndefined()
    expect(config.args).toEqual([
      ...codexProviderOverrides("http://127.0.0.1:54321"),
      "--model",
      "o3",
    ])
    expect(config.args.join(" ")).toContain("model_providers.cognia.wire_api=chat")
    expect(config.args.join(" ")).not.toContain("responses")
  })

  it("omits the argv overrides when the codex home fallback is requested", () => {
    const config = buildAgentConfig({
      agent: "codex",
      gatewayBaseUrl: "http://127.0.0.1:54321",
      gatewayApiKey: "cgx-test",
      cwd: "/tmp",
      codexHomeFallback: true,
    })
    expect(config.args).toEqual([])
  })

  it("adds bypass flag for claude (--dangerously-skip-permissions)", () => {
    const config = buildAgentConfig({
      agent: "claude",
      gatewayBaseUrl: "http://localhost",
      gatewayApiKey: "k",
      cwd: "/tmp",
      bypass: true,
    })
    expect(config.args).toContain("--dangerously-skip-permissions")
  })

  it("adds bypass flag for codex (--full-auto)", () => {
    const config = buildAgentConfig({
      agent: "codex",
      gatewayBaseUrl: "http://localhost",
      gatewayApiKey: "k",
      cwd: "/tmp",
      bypass: true,
    })
    expect(config.args).toContain("--full-auto")
  })

  it("includes resume flag for claude", () => {
    const config = buildAgentConfig({
      agent: "claude",
      gatewayBaseUrl: "http://localhost",
      gatewayApiKey: "k",
      cwd: "/tmp",
      resume: "session-abc",
    })
    expect(config.args).toContain("--resume")
    expect(config.args).toContain("session-abc")
  })

  it("includes resume subcommand for codex", () => {
    const config = buildAgentConfig({
      agent: "codex",
      gatewayBaseUrl: "http://localhost",
      gatewayApiKey: "k",
      cwd: "/tmp",
      resume: "session-xyz",
    })
    expect(config.args).toContain("resume")
    expect(config.args).toContain("session-xyz")
  })

  it("appends passthrough args", () => {
    const config = buildAgentConfig({
      agent: "claude",
      gatewayBaseUrl: "http://localhost",
      gatewayApiKey: "k",
      cwd: "/tmp",
      passthrough: ["--verbose", "--cwd", "/my/project"],
    })
    expect(config.args).toContain("--verbose")
    expect(config.args).toContain("--cwd")
    expect(config.args).toContain("/my/project")
  })

  it("omits --model when model is undefined", () => {
    const config = buildAgentConfig({
      agent: "claude",
      gatewayBaseUrl: "http://localhost",
      gatewayApiKey: "k",
      cwd: "/tmp",
    })
    expect(config.args).not.toContain("--model")
  })

  it("sets CLAUDE_CODE_DISABLE_UPDATE_CHECK for claude", () => {
    const config = buildAgentConfig({
      agent: "claude",
      gatewayBaseUrl: "http://localhost",
      gatewayApiKey: "k",
      cwd: "/tmp",
    })
    expect(config.env.CLAUDE_CODE_DISABLE_UPDATE_CHECK).toBe("1")
  })

  it("uses binaryPath as command when provided (claude)", () => {
    const config = buildAgentConfig({
      agent: "claude",
      gatewayBaseUrl: "http://localhost",
      gatewayApiKey: "k",
      cwd: "/tmp",
      binaryPath: "/opt/custom/bin/claude",
    })
    expect(config.command).toBe("/opt/custom/bin/claude")
  })

  it("uses binaryPath as command when provided (codex)", () => {
    const config = buildAgentConfig({
      agent: "codex",
      gatewayBaseUrl: "http://localhost",
      gatewayApiKey: "k",
      cwd: "/tmp",
      binaryPath: "/usr/local/bin/codex",
    })
    expect(config.command).toBe("/usr/local/bin/codex")
  })

  it("falls back to agent name when binaryPath not provided", () => {
    const config = buildAgentConfig({
      agent: "claude",
      gatewayBaseUrl: "http://localhost",
      gatewayApiKey: "k",
      cwd: "/tmp",
    })
    expect(config.command).toBe("claude")
  })
})

describe("launchAgent", () => {
  it("uses Bun.spawn with inherited stdio for the external agent", async () => {
    const calls: Array<{ command: string[]; options: Record<string, unknown> }> = []
    const exitCode = await launchAgent(
      {
        agent: "codex",
        gatewayBaseUrl: "http://localhost",
        gatewayApiKey: "k",
        cwd: "/workspace",
        binaryPath: "/opt/homebrew/bin/codex",
      },
      {
        bunRuntime: {
          spawn(command, options) {
            calls.push({ command, options })
            return {
              exited: Promise.resolve(0),
              signalCode: null,
              kill: jest.fn(),
            }
          },
        },
      }
    )

    expect(exitCode).toBe(0)
    expect(calls).toEqual([
      {
        command: ["/opt/homebrew/bin/codex", ...codexProviderOverrides("http://localhost")],
        options: expect.objectContaining({
          cwd: "/workspace",
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }),
      },
    ])
  })

  it("maps a Bun subprocess signal to a conventional exit code", async () => {
    const exitCode = await launchAgent(
      {
        agent: "claude",
        gatewayBaseUrl: "http://localhost",
        gatewayApiKey: "k",
        cwd: "/workspace",
      },
      {
        bunRuntime: {
          spawn: () => ({
            exited: Promise.resolve(143),
            signalCode: "SIGTERM",
            kill: jest.fn(),
          }),
        },
      }
    )

    expect(exitCode).toBe(143)
  })

  it("maps SIGKILL using the host signal number", async () => {
    const exitCode = await launchAgent(
      {
        agent: "claude",
        gatewayBaseUrl: "http://localhost",
        gatewayApiKey: "k",
        cwd: "/workspace",
      },
      {
        bunRuntime: {
          spawn: () => ({
            exited: Promise.resolve(137),
            signalCode: "SIGKILL",
            kill: jest.fn(),
          }),
        },
      }
    )

    expect(exitCode).toBe(137)
  })

  it("calls spawnAgent with correct parameters", async () => {
    let capturedCmd = ""
    let capturedArgs: string[] = []
    let capturedOpts: SpawnOptions | undefined

    const exitCode = await launchAgent(
      {
        agent: "claude",
        model: "claude-sonnet-4-20250514",
        gatewayBaseUrl: "http://127.0.0.1:12345",
        gatewayApiKey: "cgx-key",
        cwd: "/workspace",
        bypass: true,
      },
      {
        spawnAgent: async (cmd, args, opts) => {
          capturedCmd = cmd
          capturedArgs = args
          capturedOpts = opts
          return 0
        },
      }
    )

    expect(exitCode).toBe(0)
    expect(capturedCmd).toBe("claude")
    expect(capturedArgs).toContain("--model")
    expect(capturedArgs).toContain("claude-sonnet-4-20250514")
    expect(capturedArgs).toContain("--dangerously-skip-permissions")
    expect(capturedOpts?.cwd).toBe("/workspace")
    expect(capturedOpts?.stdio).toBe("inherit")
    expect((capturedOpts?.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe(
      "http://127.0.0.1:12345"
    )
  })

  it("returns non-zero exit code on failure", async () => {
    const exitCode = await launchAgent(
      {
        agent: "codex",
        gatewayBaseUrl: "http://localhost",
        gatewayApiKey: "k",
        cwd: "/tmp",
      },
      { spawnAgent: async () => 42 }
    )
    expect(exitCode).toBe(42)
  })
})

describe("buildChildEnv", () => {
  const base = {
    agent: "claude" as const,
    gatewayBaseUrl: "http://127.0.0.1:47823",
    gatewayApiKey: "sk-cognia-rt-1",
    cwd: "/tmp",
  }

  it("strips every ambient credential and routing override from the parent", () => {
    const parent = {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "sk-ant-users-own",
      ANTHROPIC_BASE_URL: "https://somewhere.else",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-users-own",
      CLAUDE_CODE_USE_BEDROCK: "1",
      OPENAI_API_KEY: "sk-openai-users-own",
      OPENAI_BASE_URL: "https://elsewhere",
      COGNIA_GATEWAY_KEY: "stale-key",
    }
    const env = buildChildEnv(base, buildAgentConfig(base).env, parent)
    for (const name of AMBIENT_CREDENTIAL_ENV) {
      if (
        name === "ANTHROPIC_API_KEY" ||
        name === "ANTHROPIC_AUTH_TOKEN" ||
        name === "ANTHROPIC_BASE_URL"
      )
        continue
      expect(env[name]).toBeUndefined()
    }
    // The gateway route is the only credential left, and it is ours.
    expect(env.ANTHROPIC_API_KEY).toBe("sk-cognia-rt-1")
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-cognia-rt-1")
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:47823")
    expect(env.PATH).toBe("/bin")
  })

  it("does the same for codex, keeping only the gateway key under its own name", () => {
    const codex = { ...base, agent: "codex" as const }
    const env = buildChildEnv(codex, buildAgentConfig(codex).env, {
      OPENAI_API_KEY: "sk-openai-users-own",
      COGNIA_GATEWAY_KEY: "stale",
    })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.COGNIA_GATEWAY_KEY).toBe("sk-cognia-rt-1")
    expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:47823/v1")
  })

  it("applies the proxy plan and the isolated home, with the agent route on top", () => {
    const env = buildChildEnv(
      {
        ...base,
        homeEnv: { CLAUDE_CONFIG_DIR: "/home/u/.cognia/x/claude/default" },
        proxyEnv: {
          set: { HTTPS_PROXY: "http://p:8080", NO_PROXY: "localhost,127.0.0.1,::1" },
          unset: [],
        },
      },
      buildAgentConfig(base).env,
      { HTTPS_PROXY: "http://shell-proxy:1", CLAUDE_CONFIG_DIR: "/home/u/.claude" }
    )
    expect(env.HTTPS_PROXY).toBe("http://p:8080")
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1")
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/u/.cognia/x/claude/default")
  })

  it("removes what the proxy plan says must not be inherited", () => {
    const env = buildChildEnv(
      { ...base, proxyEnv: { set: {}, unset: ["HTTPS_PROXY", "https_proxy"] } },
      buildAgentConfig(base).env,
      { HTTPS_PROXY: "http://shell-proxy:1", https_proxy: "http://shell-proxy:1", HOME: "/h" }
    )
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.https_proxy).toBeUndefined()
    expect(env.HOME).toBe("/h")
  })

  it("leaves a shared home alone", () => {
    const env = buildChildEnv({ ...base, homeEnv: {} }, buildAgentConfig(base).env, {
      CLAUDE_CONFIG_DIR: "/home/u/.claude",
    })
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/u/.claude")
  })

  it("is what launchAgent actually spawns with", async () => {
    let spawned: NodeJS.ProcessEnv | undefined
    const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "must-not-leak"
    try {
      await launchAgent(
        { ...base, homeEnv: { CLAUDE_CONFIG_DIR: "/iso" } },
        {
          spawnAgent: async (_cmd, _args, opts) => {
            spawned = opts.env
            return 0
          },
        }
      )
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous
    }
    expect(spawned?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(spawned?.CLAUDE_CONFIG_DIR).toBe("/iso")
    expect(spawned?.ANTHROPIC_API_KEY).toBe("sk-cognia-rt-1")
  })
})
