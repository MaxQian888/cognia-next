/** @jest-environment node */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { buildExternalAgentChildEnv, NodeExternalAgentBackend } from "./node-backend"

const flush = () => new Promise((resolve) => setTimeout(resolve, 25))

describe("NodeExternalAgentBackend", () => {
  it("inherits plain credential env, accepts configured agent credentials, and strips loaders", () => {
    const env = buildExternalAgentChildEnv(
      {
        NODE_ENV: "test",
        OPENAI_API_KEY: "plain-openai",
        ANTHROPIC_API_KEY: "plain-anthropic",
        DISABLE_AUTO_UPDATE: "1",
        PWD: "/work",
        AWS_SECRET_ACCESS_KEY: "must-not-leak",
        NODE_OPTIONS: "--require bad.js",
      },
      {
        CODEX_ACCESS_TOKEN: "configured-codex",
        CLAUDE_CODE_OAUTH_TOKEN: "configured-claude",
        GH_TOKEN: "configured-copilot",
        QWEN_API_KEY: "configured-qwen",
        FACTORY_API_KEY: "configured-droid",
        NODE_OPTIONS: "--inspect",
        PATH: "/untrusted/bin",
      }
    )

    expect(env).toMatchObject({
      OPENAI_API_KEY: "plain-openai",
      ANTHROPIC_API_KEY: "plain-anthropic",
      CODEX_ACCESS_TOKEN: "configured-codex",
      CLAUDE_CODE_OAUTH_TOKEN: "configured-claude",
      GH_TOKEN: "configured-copilot",
      QWEN_API_KEY: "configured-qwen",
      FACTORY_API_KEY: "configured-droid",
      DISABLE_AUTO_UPDATE: "1",
      PWD: "/work",
    })
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.PATH).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })

  it("emits the frozen lifecycle payloads and line-frames stdio", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-agent-backend-"))
    const stub = fileURLToPath(new URL("./stub-acp-agent.mjs", import.meta.url))
    const backend = new NodeExternalAgentBackend({
      workspacesRoot: workspace,
      allowSmokeAgent: true,
      resolveLaunch: async (config) => ({ command: config.command, args: config.args ?? [] }),
    })
    const seen: Array<[string, unknown]> = []
    for (const channel of [
      "external-agent://spawn",
      "external-agent://state-change",
      "external-agent://stdout",
      "external-agent://stderr",
      "external-agent://exit",
    ])
      backend.listen(channel, (payload) => seen.push([channel, payload]))

    await expect(
      backend.invoke<string>("spawn_external_agent", {
        config: { id: "stub", command: "node", args: [stub], cwd: workspace },
      })
    ).resolves.toBe("stub")
    await flush()
    await backend.invoke("send_to_external_agent", { agentId: "stub", message: "hello" })
    await flush()
    await backend.invoke("send_to_external_agent", { agentId: "stub", message: "exit" })
    await flush()

    expect(seen).toContainEqual(["external-agent://spawn", { agentId: "stub", status: "starting" }])
    expect(seen).toContainEqual([
      "external-agent://state-change",
      { agentId: "stub", state: "Running" },
    ])
    expect(seen).toContainEqual(["external-agent://stdout", { agentId: "stub", data: "hello" }])
    expect(seen).toContainEqual([
      "external-agent://stderr",
      { agentId: "stub", data: "stub-ready" },
    ])
    expect(seen).toContainEqual([
      "external-agent://exit",
      { agentId: "stub", code: 7, signal: null },
    ])
  })

  it("enforces the preset command and workspace policy before spawning", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-agent-policy-"))
    const backend = new NodeExternalAgentBackend({
      workspacesRoot: workspace,
      resolveLaunch: async (config) => ({ command: config.command, args: config.args ?? [] }),
    })
    await expect(
      backend.invoke("spawn_external_agent", {
        config: { id: "bad", command: "/bin/sh", cwd: workspace },
      })
    ).rejects.toThrow(/bare allowlisted binary/)
    await expect(
      backend.invoke("spawn_external_agent", {
        config: { id: "escape", command: "codex", cwd: os.tmpdir() },
      })
    ).rejects.toThrow(/escapes the workspaces root/)
  })

  it.each([
    ["npx", ["-y", "@agentclientprotocol/claude-agent-acp"]],
    ["npx", ["-y", "@google/gemini-cli", "--acp"]],
    ["npx", ["-y", "@qwen-code/qwen-code", "--acp"]],
    ["npx", ["-y", "pi-acp"]],
    ["copilot", ["--acp"]],
    ["kiro-cli", ["acp"]],
    ["droid", ["exec", "--output-format", "acp"]],
  ])("allows the shipped executable preset %s %j", async (command, args) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-agent-preset-"))
    const backend = new NodeExternalAgentBackend({
      workspacesRoot: workspace,
      resolveLaunch: async () => ({ command: process.execPath, args: ["-e", "process.exit(0)"] }),
    })
    const agentId = await backend.invoke<string>("spawn_external_agent", {
      config: { id: `preset-${command}-${args[1] ?? args[0]}`, command, args, cwd: workspace },
    })
    expect(agentId).toEqual(expect.any(String))
    await backend.invoke("kill_external_agent", { agentId })
  })

  it("checks real and absent commands", async () => {
    const backend = new NodeExternalAgentBackend({ workspacesRoot: process.cwd() })
    await expect(
      backend.invoke("check_command_exists", { command: path.basename(process.execPath) })
    ).resolves.toBe(true)
    await expect(
      backend.invoke("check_command_exists", { command: "cognia-no-such-command-xyz" })
    ).resolves.toBe(false)
  })

  it("waits for process-group teardown before allowing the same id to respawn", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-agent-reclaim-"))
    const stub = fileURLToPath(new URL("./stub-acp-agent.mjs", import.meta.url))
    const backend = new NodeExternalAgentBackend({
      workspacesRoot: workspace,
      allowSmokeAgent: true,
      resolveLaunch: async (config) => ({ command: config.command, args: config.args ?? [] }),
    })
    const config = { id: "reused", command: "node", args: [stub], cwd: workspace }
    await backend.invoke("spawn_external_agent", { config })
    await flush()
    await backend.invoke("kill_external_agent", { agentId: "reused" })
    await expect(backend.invoke("spawn_external_agent", { config })).resolves.toBe("reused")
    await backend.invoke("kill_external_agent", { agentId: "reused" })
  })
})
