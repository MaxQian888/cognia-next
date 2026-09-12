/** @jest-environment node */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DEVIN_MCP_SERVERS_ENV,
  devinOwnedConfigRoot,
  prepareDevinMcpConfig,
} from "./devin-mcp-config"
import { NodeExternalAgentBackend } from "./node-backend"
import { buildSandboxLauncherArgs } from "./sandbox-launcher"

describe("isolated Devin MCP configuration", () => {
  let home: string
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "devin-config-test-"))
  })
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })
  const servers = (token = "one") => [
    {
      name: "cognia-tools",
      command: "node",
      args: ["bridge.mjs"],
      env: [{ name: "TOKEN", value: token }],
    },
  ]
  const config = (raw = JSON.stringify(servers())) => ({
    id: "test",
    command: "devin",
    args: ["acp"],
    cwd: home,
    env: { [DEVIN_MCP_SERVERS_ENV]: raw },
  })
  const runtime = () => ({ home, temp: home })
  const write = (relative: string, value: string) => {
    const filename = path.join(home, relative)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, value)
  }
  const read = (root: string) =>
    JSON.parse(fs.readFileSync(path.join(root, "devin/mcp_config.json"), "utf8"))

  it("copies only Devin credentials into Bot state and excludes inherited publication MCPs", () => {
    write(".local/share/devin/credentials.toml", 'token = "model-token"')
    write(
      ".config/devin/config.json",
      JSON.stringify({
        mcpServers: { github: { command: "gh", env: { GH_TOKEN: "secret" } } },
        agent: { model: "swe-2-medium" },
      })
    )
    write(".config/gh/hosts.yml", "github secret")
    const state = path.join(home, "bot-state")
    const prepared = prepareDevinMcpConfig(
      {
        ...config(),
        env: { ...config().env, COGNIA_BOT_ISOLATION: "1", COGNIA_BOT_STATE_DIR: state },
      },
      runtime()
    )
    expect(read(prepared.root!).mcpServers.github).toBeUndefined()
    expect(fs.existsSync(path.join(prepared.root!, "gh"))).toBe(false)
    expect(fs.readFileSync(path.join(state, "data/devin/credentials.toml"), "utf8")).toBe(
      'token = "model-token"'
    )
    const args = buildSandboxLauncherArgs(prepared.config, home)
    expect(args.filter((_, i) => args[i - 1] === "--readable")).not.toContain(
      path.join(home, ".config")
    )
    prepared.cleanup()
  })

  it("merges current and legacy MCP config while preserving settings, rules and original files", () => {
    write(
      ".config/devin/config.json",
      '{// comment\n "permissions":{"deny":["shell(*)"]},"mcpServers":{"legacy":{"command":"legacy"}},}'
    )
    write(
      ".config/devin/mcp_config.json",
      JSON.stringify({
        extra: "retain",
        mcpServers: { existing: { command: "existing", env: { XDG_CONFIG_HOME: "/explicit" } } },
      })
    )
    write(".config/devin/rules/a.md", "permission rules")
    write(".config/other/config.json", "untouched")
    const original = fs.readFileSync(path.join(home, ".config/devin/config.json"), "utf8")
    const prepared = prepareDevinMcpConfig(config(), runtime())
    const root = prepared.root!
    expect(read(root)).toMatchObject({
      extra: "retain",
      mcpServers: {
        legacy: { command: "legacy", env: { XDG_CONFIG_HOME: path.join(home, ".config") } },
        existing: { command: "existing", env: { XDG_CONFIG_HOME: "/explicit" } },
        "cognia-tools": {
          command: "node",
          env: { TOKEN: "one", XDG_CONFIG_HOME: path.join(home, ".config") },
        },
      },
    })
    expect(fs.readFileSync(path.join(root, "devin/config.json"), "utf8")).toBe(original)
    expect(fs.readFileSync(path.join(root, "devin/rules/a.md"), "utf8")).toBe("permission rules")
    expect(fs.readFileSync(path.join(root, "other/config.json"), "utf8")).toBe("untouched")
    expect(fs.statSync(root).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(root, "devin/mcp_config.json")).mode & 0o777).toBe(0o600)
    expect(prepared.config.env).not.toHaveProperty(DEVIN_MCP_SERVERS_ENV)
    expect(prepared.config.env).not.toHaveProperty("HOME")
    expect(buildSandboxLauncherArgs(prepared.config, home)).toContain(root)
    expect(
      devinOwnedConfigRoot({ ...config(), env: { XDG_CONFIG_HOME: "/forged" } })
    ).toBeUndefined()
    prepared.cleanup()
    expect(fs.existsSync(root)).toBe(false)
    expect(fs.readFileSync(path.join(home, ".config/devin/config.json"), "utf8")).toBe(original)
  })

  it("isolates concurrent tokens, handles empty arrays, and restores explicit original XDG for subprocesses", () => {
    const xdgConfigHome = path.join(home, "custom")
    fs.mkdirSync(xdgConfigHome)
    const first = prepareDevinMcpConfig(config(), { ...runtime(), xdgConfigHome })
    const second = prepareDevinMcpConfig(config(JSON.stringify(servers("two"))), {
      ...runtime(),
      xdgConfigHome,
    })
    const empty = prepareDevinMcpConfig(config("[]"), runtime())
    expect(first.root).not.toBe(second.root)
    expect(read(first.root!).mcpServers["cognia-tools"].env).toEqual({
      TOKEN: "one",
      XDG_CONFIG_HOME: xdgConfigHome,
    })
    expect(read(second.root!).mcpServers["cognia-tools"].env.TOKEN).toBe("two")
    expect(read(empty.root!).mcpServers).toEqual({})
    first.cleanup()
    expect(fs.existsSync(second.root!)).toBe(true)
    second.cleanup()
    empty.cleanup()
  })

  it("maps ACP HTTP/SSE headers and transports without exposing them in errors", () => {
    const prepared = prepareDevinMcpConfig(
      config(
        JSON.stringify([
          {
            name: "http",
            type: "http",
            url: "https://example.com/mcp",
            headers: [{ name: "Authorization", value: "secret" }],
          },
          { name: "sse", type: "sse", url: "http://localhost:3000/sse", headers: [] },
        ])
      ),
      runtime()
    )
    expect(read(prepared.root!).mcpServers).toEqual({
      http: {
        url: "https://example.com/mcp",
        transport: "http",
        headers: { Authorization: "secret" },
      },
      sse: { url: "http://localhost:3000/sse", transport: "sse", headers: {} },
    })
    prepared.cleanup()
  })

  it.each([
    "secret malformed",
    "{}",
    '[{"name":"bad","type":"channel"}]',
    JSON.stringify(servers().concat(servers())),
    " ".repeat(1_048_577),
  ])("rejects malformed payload without echoing it (%#)", (raw) => {
    expect(() => prepareDevinMcpConfig(config(raw), runtime())).toThrow(
      "Invalid Devin MCP configuration"
    )
    expect(fs.readdirSync(home)).toEqual([])
  })

  it("rejects wrong commands and project shadowing, including JSONC ancestor configuration", () => {
    expect(() => prepareDevinMcpConfig({ ...config(), command: "codex" }, runtime())).toThrow()
    write(
      ".devin/mcp_config.local.json",
      '{/* project */ "mcpServers":{"cognia-tools":{"command":"other",},},}'
    )
    const nested = path.join(home, "nested")
    fs.mkdirSync(nested)
    expect(() => prepareDevinMcpConfig({ ...config(), cwd: nested }, runtime())).toThrow("shadows")
  })

  it.each([
    { name: "bad\0name", command: "node", args: [] },
    { name: "empty-command", command: "", args: [] },
    { name: "bad-args", command: "node", args: [false] },
    { name: "bad-env", command: "node", args: [], env: [{ name: "TOKEN", value: false }] },
    {
      name: "duplicate-env",
      command: "node",
      args: [],
      env: [
        { name: "A", value: "1" },
        { name: "A", value: "2" },
      ],
    },
    { name: "bad-url", type: "http", url: "file:///secret", headers: [] },
    { name: "invalid-url", type: "sse", url: "not a URL", headers: [] },
    { name: "bad-headers", type: "http", url: "https://example.com", headers: {} },
    { name: "unknown-field", command: "node", args: [], channel: true },
  ])("rejects invalid standard server fields (%#)", (server) => {
    expect(() => prepareDevinMcpConfig(config(JSON.stringify([server])), runtime())).toThrow(
      "Invalid Devin MCP configuration"
    )
  })

  it("rejects malformed user server maps and restores the initial state after copy failure", () => {
    for (const contents of [
      '{"mcpServers":[]}',
      '{"mcpServers":{"bad":null}}',
      '{"mcpServers":{"bad":{"command":"node","env":{"TOKEN":false}}}}',
      "/* unclosed",
    ]) {
      write(".config/devin/mcp_config.json", contents)
      expect(() => prepareDevinMcpConfig(config(), runtime())).toThrow(
        "Invalid Devin MCP configuration"
      )
      expect(fs.readdirSync(home).some((name) => name.startsWith("cognia-devin-config-"))).toBe(
        false
      )
    }
    expect(() =>
      prepareDevinMcpConfig(config(), { ...runtime(), xdgConfigHome: "relative" })
    ).toThrow("must be absolute")
    const plain = { id: "plain", command: "codex" }
    expect(prepareDevinMcpConfig(plain, runtime()).config).toBe(plain)
  })

  it("copies symlinked configuration safely, rejects cycles and malformed user settings with cleanup", () => {
    write("real-config/config.json", '{"text":"a,} // retain", "permissions":{"mode":"ask"}}')
    fs.mkdirSync(path.join(home, ".config"))
    fs.symlinkSync(path.join(home, "real-config"), path.join(home, ".config/devin"))
    const prepared = prepareDevinMcpConfig(config(), runtime())
    expect(fs.lstatSync(path.join(prepared.root!, "devin")).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(prepared.root!, "devin/config.json"), "utf8")).toContain(
      "a,} // retain"
    )
    prepared.cleanup()
    fs.symlinkSync(path.join(home, "real-config"), path.join(home, "real-config/loop"))
    expect(() => prepareDevinMcpConfig(config(), runtime())).toThrow("cycle")
    fs.unlinkSync(path.join(home, "real-config/loop"))
    write("real-config/config.json", "{invalid token-secret")
    expect(() => prepareDevinMcpConfig(config(), runtime())).toThrow(
      "Invalid Devin MCP configuration"
    )
    expect(fs.readdirSync(home).some((name) => name.startsWith("cognia-devin-config-"))).toBe(false)
  })

  it.each(["exit", "kill", "failure", "spawn-error"])(
    "cleans the real backend overlay on %s",
    async (kind) => {
      let root: string | undefined
      const backend = new NodeExternalAgentBackend({
        workspacesRoot: home,
        resolveLaunch: async (input) => {
          root = devinOwnedConfigRoot(input)
          expect(root).toBeDefined()
          if (kind === "failure") throw new Error("fixture launch failure")
          if (kind === "spawn-error")
            return { command: path.join(home, "missing-launcher"), args: [] }
          return {
            command: process.execPath,
            args: ["-e", kind === "exit" ? "process.exit(0)" : "setInterval(()=>{},1000)"],
          }
        },
      })
      if (kind === "failure") {
        await expect(backend.invoke("spawn_external_agent", { config: config() })).rejects.toThrow(
          "fixture launch failure"
        )
      } else {
        const exited = new Promise<void>((resolve) => {
          const off = backend.listen(
            kind === "spawn-error" ? "external-agent://state-change" : "external-agent://exit",
            (event) => {
              if (kind === "spawn-error" && (event as { state: string }).state !== "Failed") return
              off()
              resolve()
            }
          )
        })
        await backend.invoke("spawn_external_agent", { config: config() })
        if (kind === "kill") await backend.invoke("kill_external_agent", { agentId: "test" })
        await exited
      }
      expect(fs.existsSync(root!)).toBe(false)
    }
  )

  it("reaps only the Devin launch group when its leader leaves an MCP descendant behind", async () => {
    if (process.platform === "win32") return
    let root: string | undefined
    let pid: number | undefined
    const pidFile = path.join(home, "descendant.pid")
    const backend = new NodeExternalAgentBackend({
      workspacesRoot: home,
      resolveLaunch: async (input) => {
        root = devinOwnedConfigRoot(input)
        return {
          command: process.execPath,
          args: [
            "-e",
            [
              'const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});',
              'require("node:fs").writeFileSync(process.argv[1],String(child.pid));',
              "child.unref();process.exit(0);",
            ].join(""),
            pidFile,
          ],
        }
      },
    })
    const exited = new Promise<void>((resolve) => {
      const off = backend.listen("external-agent://exit", () => {
        off()
        resolve()
      })
    })
    try {
      await backend.invoke("spawn_external_agent", { config: config() })
      await exited
      pid = Number(fs.readFileSync(pidFile, "utf8"))
      const alive = () => {
        try {
          process.kill(pid!, 0)
          if (
            process.platform === "linux" &&
            fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z")
          )
            return false
          return true
        } catch {
          return false
        }
      }
      const deadline = Date.now() + 2_000
      while (alive() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20))
      expect(alive()).toBe(false)
      expect(fs.existsSync(root!)).toBe(false)
    } finally {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          /* Already reaped. */
        }
      }
    }
  })
})
