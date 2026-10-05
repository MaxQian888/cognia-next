/** @jest-environment node */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  agentStateDataDir,
  agentStateRoot,
  applyStateIsolation,
  hostAgentStateDataDir,
  launchOwnsPrivateHome,
  removeStateRoot,
  stateKeyValid,
  stateRootInfo,
  type StateIsolationHost,
  type StateIsolationPlan,
} from "./state-isolation"
import { buildSandboxLauncherArgs, resolveSandboxedExternalAgentLaunch } from "./sandbox-launcher"
import { NodeExternalAgentBackend } from "./node-backend"

const KEY = "COGNIA_AGENT_STATE_KEY"

function tempHost(): { host: StateIsolationHost; base: string; data: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-state-iso-"))
  const data = path.join(base, "data")
  return {
    base,
    data,
    host: { platform: "linux", homedir: path.join(base, "home"), env: { XDG_DATA_HOME: data } },
  }
}

function pairs(args: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length - 1; i++) if (args[i] === flag) out.push(args[i + 1])
  return out
}

describe("agent state isolation (CLI host)", () => {
  const cleanup: string[] = []
  afterEach(() => {
    for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })
  function host() {
    const made = tempHost()
    cleanup.push(made.base)
    return made
  }

  it("accepts configuration ids and refuses anything path-like", () => {
    for (const key of ["cfg-1", "A_b-9", "x".repeat(128)]) expect(stateKeyValid(key)).toBe(true)
    for (const key of ["", "x".repeat(129), "../x", "a/b", "a\\b", ".", "a b", "ключ"]) {
      expect(stateKeyValid(key)).toBe(false)
    }
  })

  it("resolves the data directory by platform convention", () => {
    expect(agentStateDataDir("darwin", "/Users/dev")).toBe("/Users/dev/Library/Application Support")
    expect(agentStateDataDir("linux", "/home/dev")).toBe("/home/dev/.local/share")
    expect(agentStateDataDir("linux", "/home/dev", "/xdg")).toBe("/xdg")
    expect(agentStateDataDir("linux", "/home/dev", "relative")).toBe("/home/dev/.local/share")
    expect(agentStateDataDir("darwin", "/Users/dev", "/xdg")).toBe(
      "/Users/dev/Library/Application Support"
    )
    expect(agentStateDataDir("win32", "C:\\Users\\dev", undefined, "C:\\Users\\dev\\AppData")).toBe(
      "C:\\Users\\dev\\AppData"
    )
    expect(agentStateDataDir("win32", "C:\\Users\\dev")).toBeUndefined()
    expect(agentStateDataDir("linux", undefined)).toBeUndefined()
    expect(agentStateDataDir("freebsd", "/home/dev")).toBeUndefined()
    expect(
      hostAgentStateDataDir({ platform: "linux", homedir: "/h", env: { XDG_DATA_HOME: "" } })
    ).toBe("/h/.local/share")
    expect(agentStateRoot("/data", "cfg")).toBe("/data/cognia/external-agents/cfg")
  })

  it("leaves a config without a key untouched", () => {
    const { host: h } = host()
    const config = { id: "a", command: "codex", env: { CODEX_HOME: "/mine" } }
    expect(applyStateIsolation(config, h)).toEqual({ config, plan: null })
  })

  it("maps the runtime's homes into a private root and strips the key", () => {
    const { host: h, data } = host()
    const input = {
      id: "a",
      command: "npx",
      args: ["-y", "@zed-industries/codex-acp"],
      env: { [KEY]: "cfg-1", CODEX_HOME: "/caller", OPENAI_API_KEY: "sk" },
    }
    const { config, plan } = applyStateIsolation(input, h)
    const root = path.join(data, "cognia/external-agents/cfg-1")
    expect(plan).toEqual({
      root,
      env: { CODEX_HOME: path.join(root, "codex") },
      sharedRoots: [path.join(h.homedir, ".codex")],
      denyReadable: [path.join(h.homedir, ".codex")],
    })
    expect(config.env).toEqual({ CODEX_HOME: path.join(root, "codex"), OPENAI_API_KEY: "sk" })
    // The caller's config object is never mutated.
    expect(input.env[KEY]).toBe("cfg-1")
    for (const dir of [root, path.join(root, "codex")]) {
      expect(fs.statSync(dir).isDirectory()).toBe(true)
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    }
  })

  it("creates nested and XDG homes for OpenCode", () => {
    const { host: h, data } = host()
    const { config } = applyStateIsolation(
      { id: "o", command: "opencode", env: { [KEY]: "oc" } },
      h
    )
    const root = path.join(data, "cognia/external-agents/oc")
    expect(config.env).toEqual({
      OPENCODE_CONFIG_DIR: path.join(root, "config/opencode"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
    })
    for (const dir of ["config/opencode", "data", "state", "cache"]) {
      expect(fs.existsSync(path.join(root, dir))).toBe(true)
    }
  })

  it("resolves rules exactly like the renderer: Pi by base command, Copilot by target", () => {
    const { host: h } = host()
    const env = (command: string, args: string[] = []) =>
      Object.keys(
        applyStateIsolation({ id: "x", command, args, env: { [KEY]: "k" } }, h).config.env!
      )
    expect(env("pi")).toEqual(["PI_CODING_AGENT_DIR"])
    expect(env("copilot")).toEqual(["COPILOT_HOME"])
    expect(env("claude-agent-acp")).toEqual(["CLAUDE_CONFIG_DIR"])
    expect(() => env("npx", ["pi-something"])).toThrow("state isolation unsupported for npx")
  })

  it("refuses bad keys, unsupported runtimes and an unknown data directory", () => {
    const { host: h, data } = host()
    expect(() =>
      applyStateIsolation({ id: "x", command: "codex", env: { [KEY]: "../x" } }, h)
    ).toThrow(/invalid COGNIA_AGENT_STATE_KEY/)
    expect(() =>
      applyStateIsolation({ id: "x", command: "gemini", env: { [KEY]: "g" } }, h)
    ).toThrow("state isolation unsupported for gemini")
    expect(() =>
      applyStateIsolation(
        { id: "x", command: "codex", env: { [KEY]: "c" } },
        { platform: "win32", homedir: "C:\\h", env: {} }
      )
    ).toThrow(/data directory/)
    expect(fs.existsSync(path.join(data, "cognia"))).toBe(false)
  })

  it.each([
    [{ COGNIA_BOT_ISOLATION: "1", COGNIA_BOT_STATE_DIR: "/state" }],
    [{ COGNIA_GATEWAY_TASK_CONFIG: "{}" }],
    [{ COGNIA_GATEWAY_TASK_HOME: "/task" }],
  ])("a launch with its own private home ignores the key (%j)", (owner) => {
    const { host: h, data } = host()
    expect(launchOwnsPrivateHome(owner)).toBe(true)
    const { config, plan } = applyStateIsolation(
      { id: "x", command: "codex", env: { [KEY]: "c", ...owner } },
      h
    )
    expect(plan).toBeNull()
    expect(config.env).toEqual(owner)
    expect(fs.existsSync(path.join(data, "cognia"))).toBe(false)
  })

  it("refuses a state directory that a previous run swapped for a symlink", () => {
    const { host: h, data, base } = host()
    const root = path.join(data, "cognia/external-agents/c")
    fs.mkdirSync(root, { recursive: true })
    fs.mkdirSync(path.join(base, "outside"))
    fs.symlinkSync(path.join(base, "outside"), path.join(root, "codex"))
    expect(() =>
      applyStateIsolation({ id: "x", command: "codex", env: { [KEY]: "c" } }, h)
    ).toThrow(/symlink/)
  })

  it("reports size and removes idempotently without touching siblings or link targets", () => {
    const { host: h, data, base } = host()
    expect(stateRootInfo("cfg", h)).toEqual({
      path: path.join(data, "cognia/external-agents/cfg"),
      exists: false,
      bytes: 0,
    })
    expect(() => removeStateRoot("cfg", h)).not.toThrow()
    const root = path.join(data, "cognia/external-agents/cfg")
    fs.mkdirSync(path.join(root, "codex/sessions"), { recursive: true })
    fs.writeFileSync(path.join(root, "codex/auth.json"), "0123456789")
    fs.writeFileSync(path.join(root, "codex/sessions/a.jsonl"), "abc")
    expect(stateRootInfo("cfg", h)).toEqual({ path: root, exists: true, bytes: 13 })
    const sibling = path.join(data, "cognia/external-agents/other")
    fs.mkdirSync(sibling)
    removeStateRoot("cfg", h)
    expect(fs.existsSync(root)).toBe(false)
    expect(fs.existsSync(sibling)).toBe(true)

    const outside = path.join(base, "outside")
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, "keep"), "x")
    fs.symlinkSync(outside, root)
    removeStateRoot("cfg", h)
    expect(fs.existsSync(path.join(outside, "keep"))).toBe(true)
    expect(() => fs.lstatSync(root)).toThrow()
    expect(() => stateRootInfo("../x", h)).toThrow("invalid agent state key")
    expect(() => removeStateRoot("", h)).toThrow("invalid agent state key")
  })

  describe("sandbox launcher scope", () => {
    const home = "/home/user"
    const plan = (overrides: Partial<StateIsolationPlan> = {}): StateIsolationPlan => ({
      root: "/data/cognia/external-agents/c",
      env: { CODEX_HOME: "/data/cognia/external-agents/c/codex" },
      sharedRoots: [`${home}/.codex`],
      denyReadable: [`${home}/.codex`],
      ...overrides,
    })

    it("writes the private root, not the shared login, and hides the login", () => {
      const args = buildSandboxLauncherArgs(
        {
          id: "c",
          command: "npx",
          args: ["-y", "@zed-industries/codex-acp"],
          cwd: "/work",
          env: { CODEX_HOME: "/data/cognia/external-agents/c/codex" },
        },
        home,
        plan()
      )
      const writable = pairs(args, "--writable")
      expect(writable).toContain("/data/cognia/external-agents/c")
      expect(writable).not.toContain(`${home}/.codex`)
      expect(writable).toContain(`${home}/.npm`)
      expect(pairs(args, "--deny-readable")).toContain(`${home}/.codex`)
      expect(args.slice(args.indexOf("--") + 1)).toEqual(["npx", "-y", "@zed-industries/codex-acp"])
    })

    it("without a plan the shared login stays writable (shared configurations)", () => {
      const args = buildSandboxLauncherArgs({ id: "c", command: "codex", cwd: "/work" }, home)
      expect(pairs(args, "--writable")).toContain(`${home}/.codex`)
      expect(pairs(args, "--deny-readable")).not.toContain(`${home}/.codex`)
    })

    it("rebases Kimi onto the isolated home it reads from the config env", () => {
      const own = "/data/cognia/external-agents/k/kimi"
      const args = buildSandboxLauncherArgs(
        { id: "k", command: "kimi", args: ["acp"], cwd: "/work", env: { KIMI_CODE_HOME: own } },
        home,
        plan({
          root: "/data/cognia/external-agents/k",
          env: { KIMI_CODE_HOME: own },
          sharedRoots: [`${home}/.kimi-code`],
          denyReadable: [`${home}/.kimi-code`, `${home}/.kimi`],
        })
      )
      const writable = pairs(args, "--writable")
      expect(writable).toContain(own)
      expect(writable).not.toContain(`${home}/.kimi-code`)
      expect(pairs(args, "--deny-readable")).toEqual(
        expect.arrayContaining([`${home}/.kimi-code`, `${home}/.kimi`])
      )
    })

    it("never pre-creates the shared Claude files for an isolated launch", async () => {
      const ensureDir = jest.fn()
      const ensureFile = jest.fn()
      await resolveSandboxedExternalAgentLaunch(
        {
          id: "c",
          command: "claude-agent-acp",
          cwd: "/work",
          env: { CLAUDE_CONFIG_DIR: "/data/cognia/external-agents/c/claude" },
        },
        {
          platform: "darwin",
          homedir: home,
          candidates: ["/launcher"],
          isExecutable: () => true,
          ensureDir,
          ensureFile,
        },
        plan({
          sharedRoots: [`${home}/.claude`, `${home}/.claude.json`, `${home}/.claude.json.backup`],
          denyReadable: [`${home}/.claude`, `${home}/.claude.json`, `${home}/.claude.json.backup`],
        })
      )
      expect(ensureFile).not.toHaveBeenCalled()
      expect(ensureDir).not.toHaveBeenCalledWith(`${home}/.claude`)
    })
  })

  describe("node backend", () => {
    it("spawns with the isolated env and never hands the key to the child", async () => {
      const { host: h, data } = host()
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-state-iso-ws-"))
      cleanup.push(workspace)
      const resolveLaunch = jest.fn(async () => ({
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({codex:process.env.CODEX_HOME,key:process.env.COGNIA_AGENT_STATE_KEY ?? null})+'\\n')",
        ],
      }))
      const backend = new NodeExternalAgentBackend({
        workspacesRoot: workspace,
        resolveLaunch,
        stateIsolationHost: h,
      })
      const lines: string[] = []
      const exited = new Promise<void>((resolve) => {
        backend.listen("external-agent://exit", () => resolve())
      })
      backend.listen<{ data: string }>("external-agent://stdout", ({ data: line }) =>
        lines.push(line)
      )
      const previous = process.env[KEY]
      process.env[KEY] = "ambient-key"
      try {
        await backend.invoke("spawn_external_agent", {
          config: { id: "iso", command: "codex", cwd: workspace, env: { [KEY]: "cfg" } },
        })
        await exited
      } finally {
        if (previous === undefined) delete process.env[KEY]
        else process.env[KEY] = previous
      }
      const root = path.join(data, "cognia/external-agents/cfg")
      const [config, context] = resolveLaunch.mock.calls[0] as unknown as [
        { env: Record<string, string> },
        { stateIsolation: StateIsolationPlan },
      ]
      expect(config.env[KEY]).toBeUndefined()
      expect(context.stateIsolation.root).toBe(root)
      expect(JSON.parse(lines[0])).toEqual({ codex: path.join(root, "codex"), key: null })
    })

    it("refuses an isolated spawn of a runtime that cannot be isolated", async () => {
      const { host: h } = host()
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-state-iso-ws-"))
      cleanup.push(workspace)
      const resolveLaunch = jest.fn(async () => ({ command: "must-not-run", args: [] }))
      const backend = new NodeExternalAgentBackend({
        workspacesRoot: workspace,
        resolveLaunch,
        stateIsolationHost: h,
      })
      await expect(
        backend.invoke("spawn_external_agent", {
          config: { id: "g", command: "gemini", cwd: workspace, env: { [KEY]: "g" } },
        })
      ).rejects.toThrow("state isolation unsupported for gemini")
      expect(resolveLaunch).not.toHaveBeenCalled()
    })

    it("serves the state root info and remove commands", async () => {
      const { host: h, data } = host()
      const backend = new NodeExternalAgentBackend({ stateIsolationHost: h })
      const root = path.join(data, "cognia/external-agents/cfg")
      fs.mkdirSync(root, { recursive: true })
      fs.writeFileSync(path.join(root, "f"), "12345")
      await expect(
        backend.invoke("external_agent_state_root_info", { key: "cfg" })
      ).resolves.toEqual({ path: root, exists: true, bytes: 5 })
      await backend.invoke("external_agent_state_root_remove", { key: "cfg" })
      expect(fs.existsSync(root)).toBe(false)
      await expect(
        backend.invoke("external_agent_state_root_remove", { key: "../x" })
      ).rejects.toThrow("invalid agent state key")
    })
  })
})
