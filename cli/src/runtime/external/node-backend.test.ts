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
  validateCommand,
} from "./node-backend"
import {
  EXTERNAL_AGENT_BINARY_ALLOWLIST,
  EXTERNAL_AGENT_NPX_ALLOWLIST,
} from "@/lib/ai/agent/external/policy/security-policy"

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

describe("CLI spawn allowlist", () => {
  const root = os.tmpdir()

  it("admits exactly the security policy's binaries and npx packages", () => {
    for (const command of EXTERNAL_AGENT_BINARY_ALLOWLIST) {
      expect(() => validateCommand({ command }, false, root)).not.toThrow()
      expect(() =>
        validateCommand({ command: `${command.toUpperCase()}.exe` }, false, root)
      ).not.toThrow()
    }
    for (const pkg of EXTERNAL_AGENT_NPX_ALLOWLIST) {
      expect(() =>
        validateCommand({ command: "npx", args: ["-y", pkg] }, false, root)
      ).not.toThrow()
    }
  })

  it("refuses anything the policy does not list", () => {
    // Shells, interpreters and an invented name: none can ever be a policy entry.
    for (const command of ["sh", "bash", "node", "python3", "not-an-agent"]) {
      expect(EXTERNAL_AGENT_BINARY_ALLOWLIST).not.toContain(command)
      expect(() => validateCommand({ command }, false, root)).toThrow(
        /not in the external-agent allowlist/
      )
    }
    expect(() =>
      validateCommand({ command: "npx", args: ["-y", "left-pad"] }, false, root)
    ).toThrow(/npx package left-pad is not in the allowlist/)
    expect(() => validateCommand({ command: "npx", args: ["--yes"] }, false, root)).toThrow(
      /npx package <missing>/
    )
    expect(() => validateCommand({ command: "/usr/bin/codex" }, false, root)).toThrow(
      /bare allowlisted binary/
    )
  })

  it("admits the smoke stub only when smoke agents are enabled", () => {
    const stub = { command: "node", args: ["/opt/cognia/smoke/stub-acp-agent.mjs"] }
    expect(() => validateCommand(stub, true, root)).not.toThrow()
    expect(() => validateCommand(stub, false, root)).toThrow(/not in the external-agent allowlist/)
  })
})

describe("NodeExternalAgentBackend", () => {
  it("does not inherit Kimi host model credentials into an isolated Bot", () => {
    const env = buildExternalAgentChildEnv(
      { KIMI_MODEL_API_KEY: "ambient-host-key", KIMI_CODE_HOME: "/host/kimi" },
      {
        COGNIA_BOT_ISOLATION: "1",
        COGNIA_BOT_STATE_DIR: "/work/state",
        KIMI_CODE_HOME: "/work/state/kimi",
        KIMI_MODEL_API_KEY: "explicit-bot-key",
      },
      false,
      false,
      true
    )
    expect(env.KIMI_CODE_HOME).toBe("/work/state/kimi")
    expect(env.KIMI_MODEL_API_KEY).toBe("explicit-bot-key")
    const noCredential = buildExternalAgentChildEnv(
      { KIMI_MODEL_API_KEY: "ambient-host-key" },
      { COGNIA_BOT_ISOLATION: "1", COGNIA_BOT_STATE_DIR: "/work/state" },
      false,
      false,
      true
    )
    expect(noCredential.KIMI_MODEL_API_KEY).toBeUndefined()
  })
  it("forwards Kimi model settings without client identity, OAuth or executable injection", () => {
    const env = buildExternalAgentChildEnv(
      { KIMI_MODEL_NAME: "ambient", KIMI_MODEL_PROVIDER_TYPE: "anthropic" },
      {
        KIMI_MODEL_NAME: "explicit",
        KIMI_MODEL_API_KEY: "synthetic",
        KIMI_CODE_HOME: "/owned/kimi",
        KIMI_MODEL_TEMPERATURE: "0.5",
        KIMI_OAUTH_HOST: "https://untrusted",
        KIMI_CODE_USER_AGENT: "spoofed",
        KIMI_PLUGIN_ROOT: "/scripts",
        KIMI_BIN_PATH: "/injected",
      }
    )
    expect(env).toMatchObject({
      KIMI_MODEL_NAME: "explicit",
      KIMI_MODEL_PROVIDER_TYPE: "anthropic",
      KIMI_MODEL_API_KEY: "synthetic",
      KIMI_CODE_HOME: "/owned/kimi",
      KIMI_MODEL_TEMPERATURE: "0.5",
    })
    for (const key of [
      "KIMI_OAUTH_HOST",
      "KIMI_CODE_USER_AGENT",
      "KIMI_PLUGIN_ROOT",
      "KIMI_BIN_PATH",
    ])
      expect(env[key]).toBeUndefined()
  })
  it("preserves reviewed runtime options from explicit agent configuration", () => {
    const reviewed = {
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      LC_CTYPE: "UTF-8",
      TZ: "Asia/Shanghai",
      TERM: "xterm-256color",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      NO_BROWSER: "1",
      INITIAL_AGENT_MODE: "workspace-write",
      APP_SERVER_LOGS: "./agent logs",
    }
    expect(
      buildExternalAgentChildEnv(
        { NODE_ENV: "test" },
        {
          ...reviewed,
          NODE_OPTIONS: "--require=injected.js",
          UNREVIEWED_RUNTIME_OPTION: "blocked",
        }
      )
    ).toEqual({ NODE_ENV: "test", ...reviewed })
  })

  it("preserves reviewed locale and output options in the isolated DSH environment", () => {
    const reviewed = { LC_CTYPE: "UTF-8", TERM: "xterm-256color", NO_COLOR: "1", FORCE_COLOR: "0" }
    expect(
      buildExternalAgentChildEnv(
        { NODE_ENV: "test" },
        { ...reviewed, NODE_OPTIONS: "--require=injected.js", NO_BROWSER: "unrelated" },
        true
      )
    ).toEqual({ NODE_ENV: "production", ...reviewed })
  })

  it("forwards Cline BYOK and config selectors without binary or storage injection", () => {
    const env = buildExternalAgentChildEnv(
      { CLINE_API_KEY: "ambient", CLINE_PROVIDER: "deepseek" },
      {
        CLINE_API_KEY: "synthetic",
        CLINE_MODEL: "deepseek-flash",
        CLINE_DIR: "/owned/cline",
        CLINE_BIN_PATH: "/injected",
        CLINE_DATA_DIR: "/unscoped",
        CLINE_PROVIDER_SETTINGS_PATH: "/credentials",
      }
    )
    expect(env).toMatchObject({
      CLINE_API_KEY: "synthetic",
      CLINE_PROVIDER: "deepseek",
      CLINE_MODEL: "deepseek-flash",
      CLINE_DIR: "/owned/cline",
    })
    for (const key of ["CLINE_BIN_PATH", "CLINE_DATA_DIR", "CLINE_PROVIDER_SETTINGS_PATH"])
      expect(env[key]).toBeUndefined()
  })

  it("forwards only documented Qoder authentication and config env keys", () => {
    const env = buildExternalAgentChildEnv(
      {
        NODE_ENV: "test",
        QODER_PERSONAL_ACCESS_TOKEN: "ambient-fixture",
        QODER_CONFIG_DIR: "/ambient/qoder",
        QODER_UNRELATED: "blocked",
      },
      {
        QODER_PERSONAL_ACCESS_TOKEN: "explicit-fixture",
        QODER_CONFIG_DIR: "/isolated/qoder",
        QODER_UNRELATED: "blocked",
        NODE_OPTIONS: "--inspect",
      }
    )
    expect(env.QODER_PERSONAL_ACCESS_TOKEN).toBe("explicit-fixture")
    expect(env.QODER_CONFIG_DIR).toBe("/isolated/qoder")
    expect(env.QODER_UNRELATED).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
  })

  it("keeps Aider startup settings out of child env while forwarding explicit model credentials", () => {
    const env = buildExternalAgentChildEnv(
      {
        NODE_ENV: "test",
        AIDER_MODEL: "ambient",
        AIDER_LOAD: "danger",
        DEEPSEEK_API_KEY: "fixture",
      },
      {
        AIDER_MODEL: "deepseek/test",
        AIDER_LOAD: "commands",
        DEEPSEEK_API_KEY: "fixture-explicit",
      },
      false,
      true
    )
    expect(env.AIDER_MODEL).toBe("deepseek/test")
    expect(env.AIDER_LOAD).toBeUndefined()
    expect(env.DEEPSEEK_API_KEY).toBe("fixture-explicit")
    expect(
      buildExternalAgentChildEnv({ NODE_ENV: "test", AIDER_MODEL: "ambient" }, {}, false, true)
        .AIDER_MODEL
    ).toBeUndefined()
  })
  it("derives writable Bot temp and package caches from the owned runtime state", () => {
    const env = buildExternalAgentChildEnv(
      { TMPDIR: "/ambient/tmp", pnpm_config_store_dir: "/ambient/store", NODE_ENV: "test" },
      { COGNIA_BOT_ISOLATION: "1", COGNIA_BOT_STATE_DIR: "/owned/state" }
    )
    expect(env).toMatchObject({
      TMPDIR: "/owned/state/tmp",
      TMP: "/owned/state/tmp",
      TEMP: "/owned/state/tmp",
      npm_config_cache: "/owned/state/cache/npm",
      npm_config_store_dir: "/owned/state/cache/pnpm-store",
      pnpm_config_store_dir: "/owned/state/cache/pnpm-store",
      pnpm_config_cache_dir: "/owned/state/cache/pnpm",
    })
  })

  it.each([undefined, "relative/state"])("rejects an invalid owned state directory %s", (state) => {
    expect(() =>
      buildExternalAgentChildEnv(
        { NODE_ENV: "test" },
        {
          COGNIA_BOT_ISOLATION: "1",
          ...(state ? { COGNIA_BOT_STATE_DIR: state } : {}),
        }
      )
    ).toThrow("Bot isolation requires an owned state directory")
  })

  const nativeBotTest =
    process.env.COGNIA_EXTERNAL_AGENT_LAUNCHER && process.platform === "darwin" ? it : it.skip
  nativeBotTest("launches a real confined child with writable owned caches and temp", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cognia-bot-cache-launch-")))
    const workspace = path.join(root, "checkout")
    const state = path.join(root, "state")
    fs.mkdirSync(workspace)
    const stub = path.join(workspace, "stub-acp-agent.mjs")
    const keys = [
      "TMPDIR",
      "TMP",
      "TEMP",
      "npm_config_cache",
      "npm_config_store_dir",
      "pnpm_config_store_dir",
      "pnpm_config_cache_dir",
    ]
    fs.writeFileSync(
      stub,
      `import fs from "node:fs"; import path from "node:path";
const values = Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]]));
for (const [key, value] of Object.entries(values)) fs.writeFileSync(path.join(value, key + ".txt"), "fixture");
console.log(JSON.stringify({values, githubTokenPresent: !!process.env.GITHUB_TOKEN, botStatePresent: !!process.env.COGNIA_BOT_STATE_DIR}));`
    )
    const backend = new NodeExternalAgentBackend({ workspacesRoot: root, allowSmokeAgent: true })
    const stdout: string[] = []
    const stderr: string[] = []
    backend.listen<{ data: string }>("external-agent://stdout", (event) => stdout.push(event.data))
    backend.listen<{ data: string }>("external-agent://stderr", (event) => stderr.push(event.data))
    const exited = nextEvent(backend, "external-agent://exit")
    try {
      await backend.invoke("spawn_external_agent", {
        config: {
          id: "bot-cache-fixture",
          command: "node",
          args: [stub],
          cwd: workspace,
          env: {
            COGNIA_BOT_ISOLATION: "1",
            COGNIA_BOT_STATE_DIR: state,
            GITHUB_TOKEN: "fixture-not-a-secret",
          },
        },
      })
      await exited
      expect(stderr).toEqual([])
      expect(stdout).toHaveLength(1)
      const result = JSON.parse(stdout[0])
      expect(result.githubTokenPresent).toBe(false)
      expect(result.botStatePresent).toBe(false)
      for (const key of keys) {
        expect(result.values[key]).toMatch(new RegExp(`^${state}/`))
        expect(fs.readFileSync(path.join(result.values[key], `${key}.txt`), "utf8")).toBe("fixture")
      }
    } finally {
      await backend
        .invoke("kill_external_agent", { agentId: "bot-cache-fixture" })
        .catch((error: Error) => {
          if (!error.message.includes("agent not running")) throw error
        })
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects a Devin MCP payload on another runtime before resolving a launch", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-agent-payload-"))
    const resolveLaunch = jest.fn(async () => ({ command: "must-not-run", args: [] }))
    const backend = new NodeExternalAgentBackend({ workspacesRoot: workspace, resolveLaunch })
    try {
      await expect(
        backend.invoke("spawn_external_agent", {
          config: {
            id: "wrong-runtime",
            command: "codex",
            args: ["app-server"],
            cwd: workspace,
            env: { COGNIA_DEVIN_MCP_SERVERS: "[]" },
          },
        })
      ).rejects.toThrow("Invalid Devin MCP configuration")
      expect(resolveLaunch).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it("preserves Goose provider and isolated configuration inputs without loader injection", () => {
    const env = buildExternalAgentChildEnv(
      {
        NODE_ENV: "test",
        OPENAI_API_KEY: "synthetic-goose-key",
        AWS_SECRET_ACCESS_KEY: "unrelated",
      },
      {
        GOOSE_PROVIDER: "openai",
        GOOSE_MODEL: "deepseek-flash",
        GOOSE_MODE: "approve",
        GOOSE_PATH_ROOT: "/work/goose-state",
        OPENAI_BASE_URL: "https://api.deepseek.com/v1",
        LD_PRELOAD: "untrusted",
      }
    )
    expect(env).toMatchObject({
      GOOSE_PROVIDER: "openai",
      GOOSE_MODEL: "deepseek-flash",
      GOOSE_MODE: "approve",
      GOOSE_PATH_ROOT: "/work/goose-state",
      OPENAI_BASE_URL: "https://api.deepseek.com/v1",
      OPENAI_API_KEY: "synthetic-goose-key",
    })
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY")
    expect(env).not.toHaveProperty("LD_PRELOAD")
  })

  it("preserves Devin authentication inputs without admitting unrelated secrets", () => {
    const env = buildExternalAgentChildEnv(
      { NODE_ENV: "test", DEVIN_API_KEY: "ambient-devin", AWS_SECRET_ACCESS_KEY: "unrelated" },
      { WINDSURF_API_KEY: "configured-windsurf", DEVIN_MODEL: "swe-2" }
    )
    expect(env).toMatchObject({
      DEVIN_API_KEY: "ambient-devin",
      WINDSURF_API_KEY: "configured-windsurf",
      DEVIN_MODEL: "swe-2",
    })
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY")
  })

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
        PI_CODING_AGENT_DIR: "/task/pi",
        PI_CODING_AGENT_SESSION_DIR: "/task/pi/sessions",
        PI_UNTRUSTED_OPTION: "blocked",
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
      PI_CODING_AGENT_DIR: "/task/pi",
      PI_CODING_AGENT_SESSION_DIR: "/task/pi/sessions",
    })
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.PATH).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.PI_UNTRUSTED_OPTION).toBeUndefined()
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

  it("launches in an explicitly selected sibling workspace without broadening the root", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-workspace-switch-"))
    const selected = path.join(parent, "selected")
    const sibling = path.join(parent, "unselected")
    fs.mkdirSync(selected)
    fs.mkdirSync(sibling)
    const envRoot = process.env.COGNIA_WORKSPACES_DIR
    delete process.env.COGNIA_WORKSPACES_DIR
    const backend = new NodeExternalAgentBackend({
      allowSmokeAgent: true,
      resolveLaunch: async () => ({ command: "node", args: ["-e", "console.log(process.cwd())"] }),
    })
    if (envRoot !== undefined) process.env.COGNIA_WORKSPACES_DIR = envRoot
    try {
      const config = {
        id: "workspace-test",
        command: "node",
        args: ["stub-acp-agent.mjs"],
        cwd: selected,
      }
      await expect(backend.invoke("spawn_external_agent", { config })).rejects.toThrow(/escapes/)
      backend.selectWorkspace(selected)
      const output = nextEvent<{ data: string }>(
        backend,
        "external-agent://stdout",
        (row) => row.data === fs.realpathSync(selected)
      )
      const exited = nextEvent(backend, "external-agent://exit")
      await backend.invoke("spawn_external_agent", { config })
      await output
      await exited
      await expect(
        backend.invoke("spawn_external_agent", { config: { ...config, cwd: sibling } })
      ).rejects.toThrow(/escapes/)
      expect(() => backend.selectWorkspace(path.join(parent, "missing"))).toThrow()
      await expect(
        backend.invoke("spawn_external_agent", { config: { ...config, command: "/bin/sh" } })
      ).rejects.toThrow(/allowlisted/)
      fs.rmdirSync(selected)
      await expect(backend.invoke("spawn_external_agent", { config })).rejects.toThrow()
      expect(fs.existsSync(selected)).toBe(false)
      fs.symlinkSync(sibling, selected)
      await expect(backend.invoke("spawn_external_agent", { config })).rejects.toThrow(
        /workspace changed/
      )
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  it("preserves environment-configured confinement when selecting a workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-env-workspaces-"))
    const previous = process.env.COGNIA_WORKSPACES_DIR
    try {
      process.env.COGNIA_WORKSPACES_DIR = root
      const backend = new NodeExternalAgentBackend()
      expect(() => backend.selectWorkspace(os.tmpdir())).toThrow(/escapes/)
    } finally {
      if (previous === undefined) delete process.env.COGNIA_WORKSPACES_DIR
      else process.env.COGNIA_WORKSPACES_DIR = previous
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps an explicitly configured workspace confinement during selection", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-fixed-workspaces-"))
    try {
      const backend = new NodeExternalAgentBackend({ workspacesRoot: root })
      expect(() => backend.selectWorkspace(os.tmpdir())).toThrow(/escapes/)
      expect(() => backend.selectWorkspace(root)).not.toThrow()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
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
    ["devin", ["acp"]],
    ["kimi", ["acp"]],
    ["goose", ["acp", "--with-builtin", "developer"]],
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

  // A process group we spawned can refuse our signal with EPERM rather than
  // ESRCH once its leader is a zombie, which is what macOS reports for a child
  // that has just exited. That was rethrown from inside the escalation TIMER,
  // where nothing catches it, so a busy machine turned "the agent already
  // exited" into a crash of the host process.
  it("treats a process group that refuses the signal as already gone", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-agent-eperm-"))
    const stub = fileURLToPath(new URL("./stub-acp-agent.mjs", import.meta.url))
    const backend = new NodeExternalAgentBackend({
      workspacesRoot: workspace,
      allowSmokeAgent: true,
      resolveLaunch: async (config) => ({ command: config.command, args: config.args ?? [] }),
    })
    const config = { id: "eperm", command: "node", args: [stub], cwd: workspace }
    const running = nextEvent<{ state: string }>(
      backend,
      "external-agent://state-change",
      (payload) => payload.state === "Running"
    )
    await backend.invoke("spawn_external_agent", { config })
    await running

    const kill = jest.spyOn(process, "kill").mockImplementationOnce(() => {
      const error = new Error("kill EPERM") as NodeJS.ErrnoException
      error.code = "EPERM"
      throw error
    })
    try {
      await expect(
        backend.invoke("kill_external_agent", { agentId: "eperm" })
      ).resolves.toBeUndefined()
    } finally {
      kill.mockRestore()
      await backend.invoke("kill_external_agent", { agentId: "eperm" }).catch(() => undefined)
      fs.rmSync(workspace, { recursive: true, force: true })
    }
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

  it("admits the canonical host Node path only with a managed composition", async () => {
    const backend = new NodeExternalAgentBackend({
      workspacesRoot,
      resolveLaunch: async (config) => ({ command: config.command, args: config.args ?? [] }),
    })
    const exited = nextEvent(backend, "external-agent://exit")
    await expect(
      backend.invoke("spawn_external_agent", {
        config: {
          id: "dsh",
          command: process.execPath,
          args: [launcher, composition],
          cwd: workspacesRoot,
        },
      })
    ).resolves.toBe("dsh")
    await exited
    await expect(
      backend.invoke("spawn_external_agent", {
        config: {
          id: "evil",
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: workspacesRoot,
        },
      })
    ).rejects.toThrow("bare allowlisted")
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

it("keeps the DSH environment isolated from ambient and configured unrelated secrets", () => {
  const env = buildExternalAgentChildEnv(
    { NODE_ENV: "test", OPENAI_API_KEY: "ambient", HOME: "/personal" },
    {
      HOME: "/managed",
      DSH_HOME: "/managed/dsh-home",
      DEEPSEEK_API_KEY: "deepseek",
      COGNIA_GATEWAY_TASK_CONFIG: "task-fixture",
      COGNIA_GATEWAY_TOKEN: "task-token-fixture",
      COGNIA_DSH_WORKSPACE: "/work",
      ANTHROPIC_API_KEY: "other",
      NODE_OPTIONS: "--inspect",
      LANG: "en_US.UTF-8",
    },
    true
  )
  expect(env).toEqual({
    NODE_ENV: "production",
    HOME: "/managed",
    DSH_HOME: "/managed/dsh-home",
    DEEPSEEK_API_KEY: "deepseek",
    COGNIA_GATEWAY_TASK_CONFIG: "task-fixture",
    COGNIA_GATEWAY_TOKEN: "task-token-fixture",
    COGNIA_DSH_WORKSPACE: "/work",
    LANG: "en_US.UTF-8",
  })
})

it("admits plugin Pi package values under exactly the COGNIA_PIPKG_ prefix (ADR-0210)", () => {
  const env = buildExternalAgentChildEnv(
    { NODE_ENV: "test" },
    {
      COGNIA_PIPKG_TEX_ENGINE: "lualatex",
      COGNIA_PIPKGX: "near-miss",
      COGNIA_PLUGIN_SECRET: "nope",
      NODE_OPTIONS: "--require evil",
    },
    false,
    false,
    false,
    true
  )
  expect(env.COGNIA_PIPKG_TEX_ENGINE).toBe("lualatex")
  expect(env).not.toHaveProperty("COGNIA_PIPKGX")
  expect(env).not.toHaveProperty("COGNIA_PLUGIN_SECRET")
  expect(env).not.toHaveProperty("NODE_OPTIONS")
})

it("keeps plugin Pi package env away from every non-Pi agent, from both sources", () => {
  const ambient = { NODE_ENV: "test", COGNIA_PIPKG_AMBIENT: "a" } as NodeJS.ProcessEnv
  const overrides = {
    COGNIA_PIPKG_MODE: "hosted",
    COGNIA_TOOLHOST_PI_PACKAGE_ROOTS: '["/x"]',
    COGNIA_TOOLHOST_TOKEN: "tok",
  }
  const other = buildExternalAgentChildEnv(ambient, overrides)
  expect(other).not.toHaveProperty("COGNIA_PIPKG_MODE")
  expect(other).not.toHaveProperty("COGNIA_PIPKG_AMBIENT")
  expect(other).not.toHaveProperty("COGNIA_TOOLHOST_PI_PACKAGE_ROOTS")
  // The rest of the reviewed prefix family is untouched.
  expect(other.COGNIA_TOOLHOST_TOKEN).toBe("tok")

  // A gateway task merges its overrides wholesale; the Pi scoping still holds.
  const gatewayOther = buildExternalAgentChildEnv(ambient, {
    ...overrides,
    COGNIA_GATEWAY_TASK_HOME: "/task",
  })
  expect(gatewayOther).not.toHaveProperty("COGNIA_PIPKG_MODE")
  expect(gatewayOther).not.toHaveProperty("COGNIA_TOOLHOST_PI_PACKAGE_ROOTS")

  const pi = buildExternalAgentChildEnv(ambient, overrides, false, false, false, true)
  expect(pi).toMatchObject({
    COGNIA_PIPKG_MODE: "hosted",
    COGNIA_PIPKG_AMBIENT: "a",
    COGNIA_TOOLHOST_PI_PACKAGE_ROOTS: '["/x"]',
  })
})

it("passes only an explicit managed DeepSeek endpoint", () => {
  expect(
    buildExternalAgentChildEnv(
      { NODE_ENV: "test", DEEPSEEK_BASE_URL: "https://ambient.invalid" },
      {},
      true
    )
  ).not.toHaveProperty("DEEPSEEK_BASE_URL")
  expect(
    buildExternalAgentChildEnv(
      { NODE_ENV: "test", DEEPSEEK_BASE_URL: "https://ambient.invalid" },
      { DEEPSEEK_BASE_URL: "http://127.0.0.1:9876" },
      true
    )
  ).toEqual({ NODE_ENV: "production", DEEPSEEK_BASE_URL: "http://127.0.0.1:9876" })
})
