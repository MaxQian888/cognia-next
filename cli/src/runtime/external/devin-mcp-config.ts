import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { NodeExternalAgentSpawnConfig } from "./node-backend"

export const DEVIN_MCP_SERVERS_ENV = "COGNIA_DEVIN_MCP_SERVERS"
const OWNED_CONFIG_ROOT = Symbol("owned Devin config root")
const ORIGINAL_CONFIG_ROOT = Symbol("original Devin config root")
type PreparedConfig = NodeExternalAgentSpawnConfig & {
  [OWNED_CONFIG_ROOT]?: string
  [ORIGINAL_CONFIG_ROOT]?: string
}
const MAX_JSON_BYTES = 1_048_576
const MAX_COPY_BYTES = 64 * 1_048_576

function fail(): never {
  throw new Error("Invalid Devin MCP configuration")
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** JSONC without rewriting comment-like text or trailing commas inside strings. */
function parseJsonc(raw: string): Record<string, unknown> {
  if (Buffer.byteLength(raw) > MAX_JSON_BYTES) fail()
  let text = ""
  let string = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (string) {
      text += ch
      if (ch === "\\") text += raw[++i] ?? ""
      else if (ch === '"') string = false
    } else if (ch === '"') {
      string = true
      text += ch
    } else if (ch === "/" && raw[i + 1] === "/") {
      while (i + 1 < raw.length && raw[i + 1] !== "\n") i++
      text += " "
    } else if (ch === "/" && raw[i + 1] === "*") {
      const end = raw.indexOf("*/", i + 2)
      if (end < 0) fail()
      i = end + 1
      text += " "
    } else text += ch
  }
  let cleaned = ""
  string = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (string) {
      cleaned += ch
      if (ch === "\\") cleaned += text[++i] ?? ""
      else if (ch === '"') string = false
    } else if (ch === '"') {
      string = true
      cleaned += ch
    } else if (ch !== "," || !/^\s*[}\]]/.test(text.slice(i + 1))) cleaned += ch
  }
  let value: unknown
  try {
    value = JSON.parse(cleaned)
  } catch {
    fail()
  }
  if (!object(value)) fail()
  return value
}

function readConfig(filename: string): Record<string, unknown> {
  if (!fs.existsSync(filename)) return {}
  const stat = fs.statSync(filename)
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) fail()
  return parseJsonc(fs.readFileSync(filename, "utf8"))
}

function serverMap(config: Record<string, unknown>): Record<string, unknown> {
  if (config.mcpServers === undefined) return {}
  if (!object(config.mcpServers)) fail()
  return config.mcpServers
}

function pairs(value: unknown): Record<string, string> {
  if (!Array.isArray(value) || value.length > 256) fail()
  const entries = value.map((entry) => {
    if (
      !object(entry) ||
      typeof entry.name !== "string" ||
      !entry.name ||
      typeof entry.value !== "string" ||
      entry.name.includes("\0") ||
      entry.value.includes("\0")
    )
      fail()
    return [entry.name, entry.value] as [string, string]
  })
  if (new Set(entries.map(([name]) => name)).size !== entries.length) fail()
  return Object.fromEntries(entries)
}

function injectedServers(raw: string): Record<string, unknown> {
  if (Buffer.byteLength(raw) > MAX_JSON_BYTES) fail()
  let values: unknown
  try {
    values = JSON.parse(raw)
  } catch {
    fail()
  }
  if (!Array.isArray(values) || values.length > 64) fail()
  const entries = values.map((value): [string, unknown] => {
    if (
      !object(value) ||
      typeof value.name !== "string" ||
      !value.name ||
      value.name.length > 256 ||
      value.name.includes("\0")
    )
      fail()
    if (value.type === "http" || value.type === "sse") {
      if (typeof value.url !== "string") fail()
      let url: URL
      try {
        url = new URL(value.url)
      } catch {
        fail()
      }
      if (!["http:", "https:"].includes(url.protocol)) fail()
      if (Object.keys(value).some((key) => !["name", "type", "url", "headers"].includes(key)))
        fail()
      return [
        value.name,
        { url: value.url, transport: value.type, headers: pairs(value.headers ?? []) },
      ]
    }
    if (value.type !== undefined && value.type !== "stdio") fail()
    if (Object.keys(value).some((key) => !["name", "type", "command", "args", "env"].includes(key)))
      fail()
    if (
      typeof value.command !== "string" ||
      !value.command.trim() ||
      value.command.includes("\0") ||
      !Array.isArray(value.args) ||
      value.args.length > 512 ||
      value.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
    )
      fail()
    return [value.name, { command: value.command, args: value.args, env: pairs(value.env ?? []) }]
  })
  if (new Set(entries.map(([name]) => name)).size !== entries.length) fail()
  return Object.fromEntries(entries)
}

function assertNoProjectCollision(cwd: string, names: Set<string>): void {
  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    for (const name of [
      "config.json",
      "config.local.json",
      "mcp_config.json",
      "mcp_config.local.json",
    ]) {
      const servers = serverMap(readConfig(path.join(current, ".devin", name)))
      if (Object.keys(servers).some((name) => names.has(name))) {
        throw new Error("Project Devin MCP configuration shadows a Cognia session server")
      }
    }
    if (path.dirname(current) === current) break
  }
}

/** Copy configuration rather than symlink it: Devin may migrate or rewrite it. */
function copyPrivate(
  source: string,
  destination: string,
  budget: { bytes: number; files: number },
  ancestors = new Set<string>()
): void {
  const canonical = fs.realpathSync(source)
  if (ancestors.has(canonical)) throw new Error("Devin configuration contains a symlink cycle")
  const stat = fs.statSync(canonical)
  if (++budget.files > 10_000 || (budget.bytes += stat.isFile() ? stat.size : 0) > MAX_COPY_BYTES) {
    throw new Error("Devin configuration exceeds the isolated copy limit")
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { mode: 0o700 })
    const next = new Set(ancestors).add(canonical)
    for (const name of fs.readdirSync(canonical))
      copyPrivate(path.join(canonical, name), path.join(destination, name), budget, next)
  } else if (stat.isFile()) {
    fs.copyFileSync(canonical, destination, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(destination, 0o600)
  } else throw new Error("Devin configuration contains an unsupported file type")
}

export function devinOwnedConfigRoot(config: NodeExternalAgentSpawnConfig): string | undefined {
  return (config as PreparedConfig)[OWNED_CONFIG_ROOT]
}

export function devinOriginalConfigRoot(config: NodeExternalAgentSpawnConfig): string | undefined {
  return (config as PreparedConfig)[ORIGINAL_CONFIG_ROOT]
}

/** Host-owned per-process overlay; the payload and capability never reach the child. */
export function prepareDevinMcpConfig(
  config: NodeExternalAgentSpawnConfig,
  runtime: { home: string; temp: string; xdgConfigHome?: string } = {
    home: os.homedir(),
    temp: os.tmpdir(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
  }
): { config: NodeExternalAgentSpawnConfig; cleanup: () => void; root?: string } {
  const raw = config.env?.[DEVIN_MCP_SERVERS_ENV]
  if (raw === undefined) return { config, cleanup() {} }
  if (
    config.command.toLowerCase().replace(/\.(exe|cmd|bat)$/, "") !== "devin" ||
    config.args?.[0] !== "acp"
  )
    fail()
  const injected = injectedServers(raw)
  assertNoProjectCollision(config.cwd ?? process.cwd(), new Set(Object.keys(injected)))
  const original = runtime.xdgConfigHome || path.join(runtime.home, ".config")
  const botIsolation = config.env?.COGNIA_BOT_ISOLATION === "1"
  if (botIsolation) {
    const state = config.env?.COGNIA_BOT_STATE_DIR
    if (!state || !path.isAbsolute(state))
      throw new Error("Bot isolation requires an owned state directory")
    const credential = path.join(runtime.home, ".local/share/devin/credentials.toml")
    const destination = path.join(state, "data/devin/credentials.toml")
    if (fs.existsSync(credential) && !fs.existsSync(destination)) {
      if (!fs.lstatSync(credential).isFile())
        throw new Error("Devin credential must be a regular file")
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
      fs.copyFileSync(credential, destination, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(destination, 0o600)
    }
  }
  if (!path.isAbsolute(original)) throw new Error("Devin XDG_CONFIG_HOME must be absolute")
  const root = fs.realpathSync(fs.mkdtempSync(path.join(runtime.temp, "cognia-devin-config-")))
  fs.chmodSync(root, 0o700)
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true })
  try {
    if (fs.existsSync(original)) {
      for (const name of fs.readdirSync(original)) {
        if (name === "devin" && botIsolation) {
          const source = path.join(original, "devin/config.json")
          const current = readConfig(source)
          const selected: Record<string, unknown> = {}
          if (typeof current.version === "number") selected.version = current.version
          if (object(current.devin) && typeof current.devin.org_id === "string")
            selected.devin = { org_id: current.devin.org_id }
          selected.shell = { setup_complete: true }
          fs.mkdirSync(path.join(root, "devin"), { recursive: true, mode: 0o700 })
          fs.writeFileSync(path.join(root, "devin/config.json"), JSON.stringify(selected), {
            mode: 0o600,
          })
        } else if (name === "devin")
          copyPrivate(path.join(original, name), path.join(root, name), { bytes: 0, files: 0 })
        else if (!botIsolation) fs.symlinkSync(path.join(original, name), path.join(root, name))
      }
    }
    const directory = path.join(root, "devin")
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const filename = path.join(directory, "mcp_config.json")
    const dedicated = readConfig(filename)
    const primaryFile = path.join(directory, "config.json")
    const primary = readConfig(primaryFile)
    if (botIsolation) {
      delete primary.mcpServers
      delete dedicated.mcpServers
      fs.writeFileSync(primaryFile, JSON.stringify(primary), { mode: 0o600 })
    }
    const servers = {
      ...serverMap(primary),
      ...serverMap(dedicated),
      ...injected,
    }
    for (const server of Object.values(servers)) {
      if (!object(server)) fail()
      if (typeof server.command === "string") {
        if (
          server.env !== undefined &&
          (!object(server.env) ||
            Object.values(server.env).some((value) => typeof value !== "string"))
        )
          fail()
        server.env = {
          XDG_CONFIG_HOME: original,
          ...(server.env as Record<string, string> | undefined),
        }
      }
    }
    fs.writeFileSync(filename, JSON.stringify({ ...dedicated, mcpServers: servers }), {
      mode: 0o600,
    })
    fs.chmodSync(filename, 0o600)
    const env: Record<string, string> = { ...config.env, XDG_CONFIG_HOME: root }
    delete env[DEVIN_MCP_SERVERS_ENV]
    const prepared: PreparedConfig = {
      ...config,
      env,
      [OWNED_CONFIG_ROOT]: root,
      [ORIGINAL_CONFIG_ROOT]: fs.existsSync(original) ? original : undefined,
    }
    return { config: prepared, cleanup, root }
  } catch (error) {
    cleanup()
    throw error
  }
}
