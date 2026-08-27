/** @jest-environment node */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  buildExternalAgentChildEnv,
  commandExists,
  isDshLauncherInvocation,
  NodeExternalAgentBackend,
} from "./node-backend"

/**
 * Wait for a real backend event instead of sleeping. Everything the backend
 * emits is driven by child-process I/O (spawn / readline lines / exit), so a
 * fixed delay races the OS: on a loaded machine the stub needs well past 25ms
 * to boot, echo a line, or reap. Resolving on the emission itself makes the
 * assertions deterministic.
 */
function nextEvent<T>(
  backend: NodeExternalAgentBackend,
  channel: string,
  match: (payload: T) => boolean = () => true
): Promise<T> {
  return new Promise<T>((resolve) => {
    let off = () => {}
    let settled = false
    off = backend.listen<T>(channel, (payload) => {
      if (settled || !match(payload)) return
      settled = true
      off()
      resolve(payload)
    })
  })
}

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

    // Arm every wait BEFORE the action that triggers it — `spawn` fires
    // synchronously inside `invoke`, so a listener attached afterwards misses it.
    const running = nextEvent<{ state: string }>(
      backend,
      "external-agent://state-change",
      (payload) => payload.state === "Running"
    )
    const ready = nextEvent<{ data: string }>(
      backend,
      "external-agent://stderr",
      (payload) => payload.data === "stub-ready"
    )
    await expect(
      backend.invoke<string>("spawn_external_agent", {
        config: { id: "stub", command: "node", args: [stub], cwd: workspace },
      })
    ).resolves.toBe("stub")
    await Promise.all([running, ready])

    const echoed = nextEvent<{ data: string }>(
      backend,
      "external-agent://stdout",
      (payload) => payload.data === "hello"
    )
    await backend.invoke("send_to_external_agent", { agentId: "stub", message: "hello" })
    await echoed

    const exited = nextEvent(backend, "external-agent://exit")
    await backend.invoke("send_to_external_agent", { agentId: "stub", message: "exit" })
    await exited

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

  /**
   * The reason `framing: "raw"` exists. `readline` treats U+2028 / U+2029 as
   * line terminators and `JSON.stringify` does not escape them, so a single
   * valid JSONL frame carrying one arrives split. Asserting the corruption in
   * line mode and its absence in raw mode keeps the two claims honest — if
   * Node ever fixes `readline`, the first expectation fails loudly rather than
   * leaving `pi-rpc` on a raw path it no longer needs.
   */
  describe("stdout framing", () => {
    // U+2028 written as an escape, not a literal: an invisible character in
    // source is unreadable in review and silently mangled by tooling.
    const SEP = "\u2028"
    const frame = JSON.stringify({ type: "message_update", text: `A${SEP}B` })

    async function collect(
      framing: "line" | "raw" | undefined,
      channel: string
    ): Promise<string[]> {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-framing-"))
      // The smoke exception in `validateCommand` is pinned to this basename,
      // so the emitter has to be written under it rather than passed to `-e`.
      const stub = path.join(workspace, "stub-acp-agent.mjs")
      fs.writeFileSync(stub, `process.stdout.write(${JSON.stringify(frame + "\n")})\n`)

      const backend = new NodeExternalAgentBackend({
        workspacesRoot: workspace,
        allowSmokeAgent: true,
        resolveLaunch: async (config) => ({ command: config.command, args: config.args ?? [] }),
      })
      const chunks: string[] = []
      backend.listen<{ data: string }>(channel, (payload) => chunks.push(payload.data))
      const exited = nextEvent(backend, "external-agent://exit")
      await backend.invoke("spawn_external_agent", {
        config: {
          id: `framing-${framing ?? "default"}-${channel}`,
          command: "node",
          args: [stub],
          cwd: workspace,
          framing,
        },
      })
      await exited
      return chunks
    }

    it("shreds a U+2028-bearing frame in line mode", async () => {
      const lines = await collect("line", "external-agent://stdout")
      expect(lines.length).toBeGreaterThan(1)
      expect(() => JSON.parse(lines[0])).toThrow()
    })

    it("keeps the frame intact in raw mode", async () => {
      const raw = await collect("raw", "external-agent://stdout-raw")
      const decoded = raw.map((b64) => Buffer.from(b64, "base64")).join("")
      expect(decoded).toBe(frame + "\n")
      expect(JSON.parse(decoded.trimEnd())).toEqual({ type: "message_update", text: `A${SEP}B` })
    })

    it("leaves every other agent on the line channel by default", async () => {
      const lines = await collect(undefined, "external-agent://stdout")
      expect(lines.length).toBeGreaterThan(0)
      // Nothing opted in, so the raw channel must stay silent.
      const raw = await collect(undefined, "external-agent://stdout-raw")
      expect(raw).toEqual([])
    })
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
    ["pi", ["--mode", "rpc"]],
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

  it("finds a binary in a fallback install root that PATH omits", async () => {
    const cargoHome = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-agent-cargo-"))
    const bin = path.join(cargoHome, "bin")
    fs.mkdirSync(bin, { recursive: true })
    const tool = path.join(bin, "faux-agent")
    fs.writeFileSync(tool, "#!/bin/sh\n")
    fs.chmodSync(tool, 0o755)
    // PATH is empty; the binary is reachable only through the CARGO_HOME fallback.
    const runtime = { platform: process.platform, home: undefined, env: { CARGO_HOME: cargoHome } }
    try {
      await expect(commandExists("faux-agent", runtime)).resolves.toBe(true)
      await expect(commandExists("faux-agent", { ...runtime, env: {} })).resolves.toBe(false)
    } finally {
      fs.rmSync(cargoHome, { recursive: true, force: true })
    }
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
    const running = nextEvent<{ state: string }>(
      backend,
      "external-agent://state-change",
      (payload) => payload.state === "Running"
    )
    await backend.invoke("spawn_external_agent", { config })
    await running
    await backend.invoke("kill_external_agent", { agentId: "reused" })
    await expect(backend.invoke("spawn_external_agent", { config })).resolves.toBe("reused")
    await backend.invoke("kill_external_agent", { agentId: "reused" })
  })
})

describe("isDshLauncherInvocation", () => {
  let dataRoot: string
  let workspacesRoot: string
  let launcher: string
  let composition: string

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-allow-"))
    workspacesRoot = path.join(dataRoot, "workspaces")
    const runtimeHome = path.join(dataRoot, "deepseek-harness")
    fs.mkdirSync(workspacesRoot, { recursive: true })
    fs.mkdirSync(runtimeHome, { recursive: true })
    launcher = path.join(runtimeHome, "launcher.mjs")
    composition = path.join(runtimeHome, "host.sdk-readonly.yml")
    fs.writeFileSync(launcher, "")
    fs.writeFileSync(composition, "")
  })

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true })
  })

  it("admits the managed launcher inside the runtime home", () => {
    expect(isDshLauncherInvocation([launcher, composition], workspacesRoot)).toBe(true)
  })

  it("rejects a launcher an agent planted in its own workspace", () => {
    // The workspaces dir sits under the same data root as the runtime home, and
    // every agent cwd is confined into it — so it is agent-writable. Rooting
    // the check at the data root would turn the one `node` exception into
    // arbitrary code execution.
    const workspace = path.join(workspacesRoot, "ws1")
    fs.mkdirSync(workspace, { recursive: true })
    const planted = path.join(workspace, "launcher.mjs")
    const plantedYml = path.join(workspace, "host.acp.yml")
    fs.writeFileSync(planted, "")
    fs.writeFileSync(plantedYml, "")
    expect(isDshLauncherInvocation([planted, plantedYml], workspacesRoot)).toBe(false)
  })

  it("rejects a composition an agent planted in its own workspace", () => {
    // The launcher is genuine here; only the composition is attacker-chosen.
    const workspace = path.join(workspacesRoot, "ws2")
    fs.mkdirSync(workspace, { recursive: true })
    const plantedYml = path.join(workspace, "host.acp.yml")
    fs.writeFileSync(plantedYml, "")
    expect(isDshLauncherInvocation([launcher, plantedYml], workspacesRoot)).toBe(false)
  })

  it("rejects a launcher outside the data root", () => {
    // Otherwise `node` would become a universal escape from the allowlist.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-evil-"))
    const evil = path.join(outside, "launcher.mjs")
    fs.writeFileSync(evil, "")
    expect(isDshLauncherInvocation([evil, composition], workspacesRoot)).toBe(false)
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it("rejects a differently named script", () => {
    const other = path.join(path.dirname(launcher), "evil.mjs")
    fs.writeFileSync(other, "")
    expect(isDshLauncherInvocation([other, composition], workspacesRoot)).toBe(false)
  })

  it("rejects a non-yml second argument", () => {
    const notYml = path.join(path.dirname(launcher), "payload.js")
    fs.writeFileSync(notYml, "")
    expect(isDshLauncherInvocation([launcher, notYml], workspacesRoot)).toBe(false)
  })

  it("rejects extra arguments", () => {
    // Exactly two: anything more could carry a flag the launcher does not vet.
    expect(isDshLauncherInvocation([launcher, composition, "--inspect"], workspacesRoot)).toBe(
      false
    )
    expect(isDshLauncherInvocation([launcher], workspacesRoot)).toBe(false)
  })

  it("rejects a path that does not exist", () => {
    const missing = path.join(path.dirname(launcher), "launcher.mjs.missing")
    expect(isDshLauncherInvocation([missing, composition], workspacesRoot)).toBe(false)
  })

  it("rejects a symlink escaping the data root", () => {
    // Canonicalization is the whole point: a lexical prefix check would pass.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-target-"))
    const target = path.join(outside, "launcher.mjs")
    fs.writeFileSync(target, "")
    const link = path.join(path.dirname(launcher), "link-launcher.mjs")
    fs.symlinkSync(target, link)
    // Renamed to the expected basename so only canonicalization can reject it.
    const staged = path.join(path.dirname(launcher), "sub")
    fs.mkdirSync(staged)
    const linked = path.join(staged, "launcher.mjs")
    fs.symlinkSync(target, linked)
    expect(isDshLauncherInvocation([linked, composition], workspacesRoot)).toBe(false)
    fs.rmSync(outside, { recursive: true, force: true })
  })
})
