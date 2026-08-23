/**
 * Unit tests for `cli/src/x/agent-launcher.ts`.
 */

import type { SpawnOptions } from "node:child_process"
import { buildAgentConfig, launchAgent } from "./agent-launcher"

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
    expect(config.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:54321")
    expect(config.env.ANTHROPIC_API_KEY).toBe("cgx-test")
    expect(config.args).toContain("--model")
    expect(config.args).toContain("claude-sonnet-4-20250514")
  })

  it("builds codex config with correct env and args", () => {
    const config = buildAgentConfig({
      agent: "codex",
      model: "o3",
      gatewayBaseUrl: "http://127.0.0.1:54321",
      gatewayApiKey: "cgx-test",
      cwd: "/tmp",
    })
    expect(config.command).toBe("codex")
    expect(config.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:54321")
    expect(config.env.OPENAI_API_KEY).toBe("cgx-test")
    expect(config.args).toContain("--model")
    expect(config.args).toContain("o3")
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
        command: ["/opt/homebrew/bin/codex"],
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
