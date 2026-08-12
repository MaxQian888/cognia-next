#!/usr/bin/env node

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..")
const CACHE_DIR = path.join(REPO_ROOT, ".cache", "tauri-agent-debug")
const SESSION_FILE = path.join(CACHE_DIR, "session.json")
const TOKEN_HEADER = "X-Cognia-Dev-Token"
export const DEFAULT_LAUNCH_TIMEOUT_MS = 1_200_000
export const AGENT_DEBUG_TAURI_CONFIG = "src-tauri/tauri.agent-debug.conf.json"

export function tauriDevArgs() {
  return ["tauri", "dev", "--features", "agent-debug", "--config", AGENT_DEBUG_TAURI_CONFIG]
}

export function agentDebugEnvironment(baseEnv = process.env, repoRoot = REPO_ROOT) {
  return {
    ...baseEnv,
    COGNIA_AGENT_DEBUG: "1",
    COGNIA_PLUGIN_NODE_PATH: path.join(
      repoRoot,
      "src-tauri/resources/plugin-node/bin",
      process.platform === "win32" ? "node.exe" : "node"
    ),
    COGNIA_VSCODE_EXT_HOST_SCRIPT: path.join(repoRoot, "sidecar/vscode-ext-host/dist/host.js"),
    COGNIA_MCP_SIDECAR_PATH: path.join(repoRoot, "sidecar/cognia-mcp.mjs"),
    COGNIA_CODE_SERVER_AGENT_VSIX: path.join(
      repoRoot,
      "sidecar/codeserver-agent-ext/cognia-agent-bridge.vsix"
    ),
  }
}

export function launchTimeout(value) {
  if (value === undefined) return DEFAULT_LAUNCH_TIMEOUT_MS
  const timeout = Number(value)
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error("--timeout must be a positive number of milliseconds")
  return timeout
}

export function configDir(platform = process.platform, env = process.env, homedir = os.homedir()) {
  if (platform === "win32") return env.APPDATA || path.join(homedir, "AppData", "Roaming")
  if (platform === "darwin") return path.join(homedir, "Library", "Application Support")
  return env.XDG_CONFIG_HOME || path.join(homedir, ".config")
}

export function endpointFilePath(
  platform = process.platform,
  env = process.env,
  homedir = os.homedir()
) {
  return (
    env.COGNIA_CLI_ENDPOINT_FILE?.trim() ||
    path.join(configDir(platform, env, homedir), "cognia", "cli-endpoint.json")
  )
}

export function parseEndpoint(raw) {
  try {
    const value = JSON.parse(raw)
    if (
      typeof value.baseUrl === "string" &&
      /^http:\/\/127\.0\.0\.1:\d+$/.test(value.baseUrl) &&
      typeof value.devToken === "string" &&
      value.devToken.length >= 32
    ) {
      return value
    }
  } catch {}
  return null
}

export function parseArgs(argv) {
  const [command = "status", ...tokens] = argv
  const positional = []
  const options = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith("--")) {
      positional.push(token)
      continue
    }
    const name = token.slice(2)
    if (["include-text", "foreground"].includes(name)) {
      options[name] = true
      continue
    }
    const value = tokens[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`)
    options[name] = value
    index += 1
  }
  return { command, positional, options }
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

export function loadEndpoint() {
  const file = endpointFilePath()
  let raw
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch (error) {
    throw new Error(`Cognia endpoint is unavailable at ${file}: ${error.message}`)
  }
  const endpoint = parseEndpoint(raw)
  if (!endpoint) throw new Error(`Cognia endpoint file is invalid: ${file}`)
  return { ...endpoint, file }
}

export async function request(
  route,
  { method = "GET", body, endpoint = loadEndpoint(), fetchImpl = fetch } = {}
) {
  const response = await fetchImpl(`${endpoint.baseUrl}${route}`, {
    method,
    headers: {
      [TOKEN_HEADER]: endpoint.devToken,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = { ok: false, error: text || `HTTP ${response.status}` }
  }
  if (!response.ok)
    throw new Error(`${route} failed (${response.status}): ${payload.error || text}`)
  return payload
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function terminateProcessTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch (error) {
    if (error.code !== "ESRCH") throw error
  }
}

async function waitForAgent(startedAt, timeoutMs, childPid) {
  const deadline = Date.now() + timeoutMs
  let lastError = "endpoint not written"
  while (Date.now() < deadline) {
    if (childPid && !processAlive(childPid)) {
      throw new Error(`Tauri debug process ${childPid} exited before the bridge was ready`)
    }
    try {
      const file = endpointFilePath()
      const stat = fs.statSync(file)
      if (stat.mtimeMs + 1_000 < startedAt) throw new Error("stale endpoint file")
      const endpoint = loadEndpoint()
      const health = await request("/api/dev/agent/health", { endpoint })
      if (
        health.helper?.version !== 2 ||
        !["interactive", "complete"].includes(health.helper.readyState)
      ) {
        throw new Error("agent helper is not ready in the main webview")
      }
      return { endpoint, health }
    } catch (error) {
      lastError = error.message
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error(`timed out waiting for agent-debug bridge: ${lastError}`)
}

async function launch(options) {
  const existing = readJson(SESSION_FILE)
  if (existing?.pid && processAlive(existing.pid)) {
    try {
      const health = await request("/api/dev/agent/health")
      return output({ ok: true, reused: true, session: existing, health })
    } catch {
      throw new Error(
        `tracked Tauri debug process ${existing.pid} is alive but its agent bridge is unavailable; run stop first`
      )
    }
  }

  const startedAt = Date.now()
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-")
  const artifactDir = path.join(CACHE_DIR, stamp)
  fs.mkdirSync(artifactDir, { recursive: true })
  const logFile = path.join(artifactDir, "tauri-dev.log")
  const stdout = fs.openSync(logFile, "a")
  const stderr = fs.openSync(logFile, "a")
  const child = spawn("pnpm", tauriDevArgs(), {
    cwd: REPO_ROOT,
    detached: options.foreground !== true,
    env: agentDebugEnvironment(),
    stdio: ["ignore", stdout, stderr],
    windowsHide: false,
  })
  fs.closeSync(stdout)
  fs.closeSync(stderr)
  if (!child.pid) throw new Error("failed to start pnpm tauri dev")
  const session = {
    pid: child.pid,
    startedAt: new Date(startedAt).toISOString(),
    artifactDir,
    logFile,
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.writeFileSync(SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
  if (options.foreground !== true) child.unref()

  let rejectOnExit
  const childExit = new Promise((_, reject) => {
    rejectOnExit = (code, signal) => {
      reject(
        new Error(
          `Tauri debug process exited before the bridge was ready (code=${code ?? "null"}, signal=${signal ?? "none"})`
        )
      )
    }
    child.once("exit", rejectOnExit)
  })
  try {
    const ready = await Promise.race([
      waitForAgent(startedAt, launchTimeout(options.timeout), child.pid),
      childExit,
    ])
    child.off("exit", rejectOnExit)
    output({
      ok: true,
      reused: false,
      session,
      endpointFile: ready.endpoint.file,
      health: ready.health,
    })
  } catch (error) {
    child.off("exit", rejectOnExit)
    terminateProcessTree(child.pid)
    try {
      fs.unlinkSync(SESSION_FILE)
    } catch (unlinkError) {
      if (unlinkError.code !== "ENOENT") throw unlinkError
    }
    throw new Error(`${error.message}; Tauri log: ${logFile}`)
  }
}

async function stop() {
  const session = readJson(SESSION_FILE)
  try {
    await request("/api/dev/agent/shutdown", { method: "POST", body: {} })
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 750))
  if (session?.pid && processAlive(session.pid)) terminateProcessTree(session.pid)
  try {
    fs.unlinkSync(SESSION_FILE)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  output({ ok: true, stoppedPid: session?.pid || null })
}

async function run(parsed) {
  const window = parsed.options.window || "main"
  switch (parsed.command) {
    case "launch":
      return launch(parsed.options)
    case "stop":
      return stop()
    case "status": {
      const health = await request("/api/dev/agent/health")
      const windows = await request("/api/dev/agent/windows")
      return output({ ok: true, health, windows: windows.windows, session: readJson(SESSION_FILE) })
    }
    case "capabilities": {
      const health = await request("/api/dev/agent/health")
      return output({ ok: true, capabilities: health.helper?.capabilities || {} })
    }
    case "windows":
      return output(await request("/api/dev/agent/windows"))
    case "snapshot":
    case "page.snapshot":
      return output(
        await request("/api/dev/agent/snapshot", {
          method: "POST",
          body: { window, includeText: parsed.options["include-text"] === true },
        })
      )
    case "act": {
      const [reference, action, positionalValue] = parsed.positional
      if (!reference || !action)
        throw new Error("usage: act <ref> <action> [value] [--window main]")
      const value = parsed.options.value ?? positionalValue
      const args = parsed.options.args
        ? JSON.parse(parsed.options.args)
        : {
            ...(value === undefined ? {} : { value }),
            ...(parsed.options.key ? { key: parsed.options.key } : {}),
          }
      return output(
        await request("/api/dev/agent/act", {
          method: "POST",
          body: { window, reference, action, args },
        })
      )
    }
    case "inspect": {
      const [reference, operation] = parsed.positional
      if (!reference || !operation)
        throw new Error("usage: inspect <ref> <operation> [--args JSON] [--window main]")
      const args = parsed.options.args ? JSON.parse(parsed.options.args) : {}
      return output(
        await request("/api/dev/agent/inspect", {
          method: "POST",
          body: { window, reference, operation, args },
        })
      )
    }
    case "evaluate":
    case "page.evaluate": {
      const expression = parsed.positional.join(" ")
      if (!expression) throw new Error("usage: evaluate <javascript expression> [--window main]")
      return output(
        await request("/api/dev/agent/evaluate", { method: "POST", body: { window, expression } })
      )
    }
    case "page.url":
      return output(
        await request("/api/dev/agent/evaluate", {
          method: "POST",
          body: { window, expression: "location.href" },
        })
      )
    case "page.title":
      return output(
        await request("/api/dev/agent/evaluate", {
          method: "POST",
          body: { window, expression: "document.title" },
        })
      )
    case "page.content":
      return output(
        await request("/api/dev/agent/evaluate", {
          method: "POST",
          body: { window, expression: "document.documentElement.outerHTML" },
        })
      )
    case "goto":
    case "page.goto": {
      const [url] = parsed.positional
      if (!url) throw new Error("usage: page.goto <url> [--window main]")
      return output(
        await request("/api/dev/agent/navigate", { method: "POST", body: { window, url } })
      )
    }
    case "console":
    case "page.console":
      return output(await request(`/api/dev/agent/console?window=${encodeURIComponent(window)}`))
    case "network":
    case "page.network":
      return output(await request(`/api/dev/agent/network?window=${encodeURIComponent(window)}`))
    case "reload":
    case "page.reload":
      return output(await request("/api/dev/agent/reload", { method: "POST", body: { window } }))
    case "logs":
      return output(
        await request(
          `/api/dev/agent/logs?lines=${encodeURIComponent(parsed.options.lines || "400")}`
        )
      )
    case "screenshot":
    case "page.screenshot": {
      const payload = await request(
        `/api/dev/agent/screenshot?window=${encodeURIComponent(window)}`
      )
      const target = path.resolve(
        parsed.positional[0] || path.join(CACHE_DIR, `screenshot-${Date.now()}.png`)
      )
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, Buffer.from(payload.screenshot.bytes, "base64"))
      return output({
        ok: true,
        window,
        path: target,
        width: payload.screenshot.width,
        height: payload.screenshot.height,
        capturedAt: payload.screenshot.capturedAt,
      })
    }
    default:
      throw new Error(`unknown command: ${parsed.command}`)
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  run(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`)
    process.exitCode = 1
  })
}
