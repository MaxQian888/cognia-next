#!/usr/bin/env node

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createHash, randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { setTimeout as delay } from "node:timers/promises"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..")
const CACHE_DIR = path.join(REPO_ROOT, ".cache", "tauri-agent-debug")
const SESSION_FILE = path.join(CACHE_DIR, "session.json")
const TOKEN_HEADER = "X-Cognia-Dev-Token"
export const DEFAULT_LAUNCH_TIMEOUT_MS = 1_200_000
export const AGENT_DEBUG_TAURI_CONFIG = "src-tauri/tauri.agent-debug.conf.json"

/** The OS owns this mutex: a dead launcher cannot leave a stale file lock. */
export async function withLifecycleLock(
  callback,
  { workspace = REPO_ROOT, timeout = DEFAULT_LAUNCH_TIMEOUT_MS, signal } = {}
) {
  const identity = fs.realpathSync(workspace)
  const port = 40000 + (createHash("sha256").update(identity).digest().readUInt32BE(0) % 20000)
  const deadline = performance.now() + launchTimeout(timeout)
  while (true) {
    signal?.throwIfAborted()
    const server = createServer((socket) => socket.destroy())
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve)
      })
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error
      const remaining = deadline - performance.now()
      if (remaining <= 0)
        throw Object.assign(new Error("another workspace lifecycle operation holds the mutex"), {
          code: "debug_lifecycle_busy",
        })
      await delay(Math.min(100, remaining), undefined, { signal })
      continue
    }
    try {
      signal?.throwIfAborted()
      return await callback(Math.max(1, deadline - performance.now()))
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}

export function tauriDevArgs(options = {}) {
  return [
    "tauri",
    "dev",
    "--features",
    "agent-debug",
    "--config",
    AGENT_DEBUG_TAURI_CONFIG,
    ...(options["no-watch"] ? ["--no-watch"] : []),
  ]
}

export function agentDebugEnvironment(baseEnv = process.env, repoRoot = REPO_ROOT, session) {
  return {
    ...baseEnv,
    COGNIA_AGENT_DEBUG: "1",
    COGNIA_AGENT_DEBUG_WORKSPACE: repoRoot,
    ...(session
      ? {
          COGNIA_AGENT_DEBUG_SESSION_ID: session.sessionId,
          COGNIA_AGENT_DEBUG_ENDPOINT_FILE: session.endpointFile,
          COGNIA_AGENT_DEBUG_SHARED: session.shared ? "1" : "0",
        }
      : {}),
    COGNIA_PLUGIN_NODE_PATH: path.join(
      repoRoot,
      "src-tauri/resources/plugin-node/bin",
      process.platform === "win32" ? "node.exe" : "node"
    ),
    COGNIA_VSCODE_EXT_HOST_SCRIPT: path.join(repoRoot, "sidecar/vscode-ext-host/dist/host.js"),
    COGNIA_MCP_SIDECAR_PATH: path.join(repoRoot, "sidecar/cognia-mcp.mjs"),
    COGNIA_CODE_SERVER_AGENT_VSIX: path.join(
      repoRoot,
      "sidecar/codeserver-agent-ext/cognia-managed-broker.vsix"
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

export function detectTerminalTauriFailure(logText) {
  const lines = String(logText || "").split(/\r?\n/)
  const markers = [
    /error: could not compile/i,
    /beforeDevCommand.*terminated/i,
    /ELIFECYCLE.*Command failed/i,
    /failed to run custom build command/i,
    /tauri dev.*exited with/i,
  ]
  for (const marker of markers) {
    const line = [...lines].reverse().find((entry) => marker.test(entry))
    if (line) return line.trim()
  }
  return null
}

function terminalFailureFromFile(logFile) {
  if (!logFile) return null
  try {
    const stat = fs.statSync(logFile)
    const length = Math.min(stat.size, 128 * 1024)
    const descriptor = fs.openSync(logFile, "r")
    try {
      const buffer = Buffer.alloc(length)
      fs.readSync(descriptor, buffer, 0, length, stat.size - length)
      return detectTerminalTauriFailure(buffer.toString("utf8"))
    } finally {
      fs.closeSync(descriptor)
    }
  } catch {
    return null
  }
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
    if (["include-text", "foreground", "no-watch", "shared", "can-write"].includes(name)) {
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

function discoveryFile() {
  if (process.env.COGNIA_CLI_ENDPOINT_FILE?.trim()) return endpointFilePath()
  const session = readJson(SESSION_FILE)
  if (session?.sessionId) {
    if (
      session.workspace !== fs.realpathSync(REPO_ROOT) ||
      typeof session.endpointFile !== "string" ||
      !path.isAbsolute(session.endpointFile)
    )
      throw new Error("the managed discovery record does not belong to this workspace")
    return session.endpointFile
  }
  return endpointFilePath()
}

export function loadEndpoint(file = discoveryFile()) {
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

/** Validate both discovery and the authenticated process before adopting a rebuilt child. */
export function reconcileDebugSession(
  session,
  health,
  endpoint,
  expectedWorkspace = session.workspace
) {
  if (health.agentDebug !== true || !Number.isSafeInteger(health.pid) || health.pid <= 1)
    throw new Error("the endpoint is not an authenticated agent-debug app")
  if (session.sessionId) {
    const live = health.debugSession
    const discovered = endpoint.debugSession
    if (
      typeof session.workspace !== "string" ||
      session.workspace !== expectedWorkspace ||
      !live ||
      !discovered ||
      live.sessionId !== session.sessionId ||
      live.workspace !== session.workspace ||
      discovered.sessionId !== session.sessionId ||
      discovered.workspace !== session.workspace ||
      typeof live.appInstanceId !== "string" ||
      !live.appInstanceId ||
      discovered.appInstanceId !== live.appInstanceId ||
      live.pid !== health.pid ||
      discovered.pid !== health.pid
    )
      throw Object.assign(new Error("debug session ownership does not match the discovered app"), {
        code: "debug_session_mismatch",
      })
    return { ...session, healthPid: health.pid, appInstanceId: live.appInstanceId }
  }
  if (!session.healthPid || health.pid !== session.healthPid)
    throw new Error("legacy session PID changed; relaunch once to enable managed restart recovery")
  return session
}

function saveSession(session, expected) {
  if (expected) {
    const current = readJson(SESSION_FILE)
    if (
      !current ||
      current.pid !== expected.pid ||
      current.startedAt !== expected.startedAt ||
      current.sessionId !== expected.sessionId
    )
      throw new Error("the tracked debug session changed while updating its app instance")
  }
  writePrivateJson(SESSION_FILE, session)
}

export function writePrivateJson(file, value, { exclusive = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const staged = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    if (exclusive) fs.linkSync(staged, file)
    else fs.renameSync(staged, file)
  } finally {
    fs.rmSync(staged, { force: true })
  }
}

function removeSession(expected) {
  const current = readJson(SESSION_FILE)
  if (
    !current ||
    current.pid !== expected?.pid ||
    current.startedAt !== expected?.startedAt ||
    current.sessionId !== expected?.sessionId
  )
    return
  fs.rmSync(SESSION_FILE, { force: true })
}

export async function request(
  route,
  {
    method = "GET",
    body,
    endpoint = loadEndpoint(),
    fetchImpl = fetch,
    signal,
    headers = {},
    timeout = 15_000,
  } = {}
) {
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 120_000)
    throw new TypeError("request timeout must be between 0 and 120000 milliseconds")
  const deadlineSignal = AbortSignal.timeout(Math.max(1, Math.ceil(timeout)))
  const requestSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal
  const response = await fetchImpl(`${endpoint.baseUrl}${route}`, {
    method,
    redirect: "error",
    headers: {
      ...headers,
      [TOKEN_HEADER]: endpoint.devToken,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: requestSignal,
  })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    payload = { ok: false, error: text || `HTTP ${response.status}` }
  }
  if (!response.ok) {
    const error = new Error(`${route} failed (${response.status}): ${payload.error || text}`)
    error.status = response.status
    error.code = payload.code
    // Renderer lifecycle failures (`webview_renderer_restarted` /
    // `webview_renderer_restarting`) say which window's web content process
    // was replaced and at which generation.
    if (typeof payload.window === "string") error.window = payload.window
    if (Number.isSafeInteger(payload.rendererGeneration))
      error.rendererGeneration = payload.rendererGeneration
    if (Number.isSafeInteger(payload.documentEpoch)) error.documentEpoch = payload.documentEpoch
    if (typeof payload.retryable === "boolean") error.retryable = payload.retryable
    if (["not-dispatched", "dispatched", "unknown"].includes(payload.dispatchState))
      error.dispatchState = payload.dispatchState
    throw error
  }
  return payload
}

/** Error codes the bridge uses when a webview's web content process was replaced. */
export const RENDERER_RESTART_CODES = Object.freeze([
  "webview_renderer_restarted",
  "webview_renderer_restarting",
])

export function isRendererRestartError(error) {
  return RENDERER_RESTART_CODES.includes(error?.code)
}

/** Machine-readable CLI failure payload; keeps bridge codes instead of a bare message. */
export function cliErrorPayload(error) {
  return {
    ok: false,
    error: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(error.dispatchState ? { dispatchState: error.dispatchState } : {}),
    ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
    ...(Number.isSafeInteger(error.documentEpoch) ? { documentEpoch: error.documentEpoch } : {}),
    ...(error.window ? { window: error.window } : {}),
    ...(Number.isSafeInteger(error.rendererGeneration)
      ? { rendererGeneration: error.rendererGeneration }
      : {}),
    ...(isRendererRestartError(error)
      ? {
          rendererRestarted: true,
          hint: "the page reloaded and element refs are stale; persisted or external effects may survive — inspect the outcome before retrying a mutation",
        }
      : {}),
  }
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

function processTreeAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  if (processAlive(pid)) return true
  if (process.platform === "win32") return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error.code !== "ESRCH"
  }
}
export function assertResolvedStartup(session) {
  if (session?.startupIntent && !session.pid)
    throw Object.assign(
      new Error(
        `an interrupted startup has an unresolved child identity; inspect ${session.logFile} and ${SESSION_FILE} before changing lifecycle state`
      ),
      { code: "debug_startup_unresolved" }
    )
}

function terminateProcessTree(pid, signal = "SIGTERM") {
  if (!Number.isSafeInteger(pid) || pid <= 1) return
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    return
  }
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error.code !== "ESRCH") throw error
    if (processAlive(pid)) process.kill(pid, signal)
  }
}

async function waitForAgent(startedAt, timeoutMs, childPid, logFile, session, reusing = false) {
  const deadline = Date.now() + timeoutMs
  let lastError = "endpoint not written"
  while (Date.now() < deadline) {
    const terminalFailure = terminalFailureFromFile(logFile)
    if (terminalFailure && !reusing) throw new Error(`Tauri launch failed: ${terminalFailure}`)
    if (childPid && !processAlive(childPid)) {
      throw new Error(`Tauri debug process ${childPid} exited before the bridge was ready`)
    }
    try {
      const file = session?.endpointFile || discoveryFile()
      const stat = fs.statSync(file)
      if (stat.mtimeMs + 1_000 < startedAt) throw new Error("stale endpoint file")
      const endpoint = loadEndpoint(file)
      const health = await request("/api/dev/agent/health", {
        endpoint,
        timeout: Math.max(1, Math.min(15_000, deadline - Date.now())),
      })
      if (session?.sessionId)
        reconcileDebugSession(session, health, endpoint, fs.realpathSync(REPO_ROOT))
      if (
        health.helper?.version !== 3 ||
        !["interactive", "complete"].includes(health.helper.readyState)
      ) {
        throw new Error("agent helper is not ready in the main webview")
      }
      return { endpoint, health }
    } catch (error) {
      if (error.code === "debug_session_mismatch") throw error
      lastError = error.message
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Math.min(500, deadline - Date.now())))
      )
    }
  }
  throw new Error(`timed out waiting for agent-debug bridge: ${lastError}`)
}

async function launch(options) {
  const existing = readJson(SESSION_FILE)
  assertResolvedStartup(existing)
  if (existing && (processTreeAlive(existing.pid) || processAlive(existing.healthPid))) {
    if (Boolean(options.shared) !== Boolean(existing.shared))
      throw new Error(
        "the existing run has a different shared-mode policy; stop that owned run before relaunching"
      )
    if (options["no-watch"] && !existing.noWatch)
      throw new Error(
        "the existing debug run watches Rust changes; stop and relaunch to select --no-watch"
      )
    const ready = await waitForAgent(
      Date.parse(existing.startedAt),
      launchTimeout(options.timeout),
      processAlive(existing.pid) ? existing.pid : undefined,
      existing.logFile,
      existing,
      true
    )
    const updated = reconcileDebugSession(
      existing,
      ready.health,
      ready.endpoint,
      fs.realpathSync(REPO_ROOT)
    )
    saveSession(updated, existing)
    return output({ ok: true, reused: true, session: updated, health: ready.health })
  }

  const startedAt = Date.now()
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-")
  const artifactDir = path.join(CACHE_DIR, stamp)
  fs.mkdirSync(artifactDir, { recursive: true })
  const logFile = path.join(artifactDir, "tauri-dev.log")
  const stdout = fs.openSync(logFile, "a")
  const stderr = fs.openSync(logFile, "a")
  const session = {
    sessionId: randomUUID(),
    workspace: fs.realpathSync(REPO_ROOT),
    endpointFile: path.join(artifactDir, "cli-endpoint.json"),
    noWatch: options["no-watch"] === true,
    shared: options.shared === true,
    startedAt: new Date(startedAt).toISOString(),
    artifactDir,
    logFile,
  }
  // Persist intent before spawn: a launcher killed in the registration gap must
  // never make a successor believe it is safe to create a second app.
  session.startupIntent = true
  session.launcherPid = process.pid
  saveSession(session)
  const child = spawn("pnpm", tauriDevArgs(options), {
    cwd: REPO_ROOT,
    detached: true,
    env: agentDebugEnvironment(process.env, session.workspace, session),
    stdio: ["ignore", stdout, stderr],
    windowsHide: false,
  })
  fs.closeSync(stdout)
  fs.closeSync(stderr)
  if (!child.pid) throw new Error("failed to start pnpm tauri dev")
  session.pid = child.pid
  session.startupIntent = false
  saveSession(session)
  if (options.foreground !== true) child.unref()

  let rejectOnExit
  const childExit = new Promise((_, reject) => {
    rejectOnExit = (code, signal) => {
      const terminalFailure = terminalFailureFromFile(logFile)
      reject(
        new Error(
          terminalFailure
            ? `Tauri launch failed: ${terminalFailure}`
            : `Tauri debug process exited before the bridge was ready (code=${code ?? "null"}, signal=${signal ?? "none"})`
        )
      )
    }
    child.once("exit", rejectOnExit)
  })
  try {
    const ready = await Promise.race([
      waitForAgent(startedAt, launchTimeout(options.timeout), child.pid, logFile, session),
      childExit,
    ])
    child.off("exit", rejectOnExit)
    const readySession = reconcileDebugSession(
      session,
      ready.health,
      ready.endpoint,
      fs.realpathSync(REPO_ROOT)
    )
    saveSession(readySession, session)
    output({
      ok: true,
      reused: false,
      session: readySession,
      endpointFile: ready.endpoint.file,
      health: ready.health,
    })
  } catch (error) {
    child.off("exit", rejectOnExit)
    terminateProcessTree(child.pid)
    for (let attempt = 0; attempt < 20 && processAlive(child.pid); attempt++) await delay(100)
    if (processAlive(child.pid)) terminateProcessTree(child.pid, "SIGKILL")
    for (let attempt = 0; attempt < 20 && processAlive(child.pid); attempt++) await delay(100)
    // A failed startup may already have a native app. Keep its record unless
    // both recorded processes are confirmed gone.
    let nativePid = session.healthPid
    try {
      nativePid = loadEndpoint(session.endpointFile).debugSession?.pid || nativePid
    } catch {}
    if (!processTreeAlive(child.pid) && !processAlive(nativePid)) removeSession(session)
    throw new Error(`${error.message}; Tauri log: ${logFile}`)
  }
}

export async function shutdownTrackedSession(
  session,
  endpoint,
  {
    send = request,
    alive = processAlive,
    terminate = terminateProcessTree,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    workspace = fs.realpathSync(REPO_ROOT),
  } = {}
) {
  if (session?.pid && (alive(session.pid) || alive(session.healthPid))) {
    let health
    try {
      // Ownership must remain verifiable when the GUI thread cannot evaluate JS.
      health = await send("/api/dev/agent/health?nativeOnly=true", { endpoint, timeout: 3_000 })
      reconcileDebugSession(session, health, endpoint, workspace)
    } catch (error) {
      throw new Error(
        `cannot validate tracked-session ownership; refusing to stop PID ${session.pid}: ${error.message}; session: ${SESSION_FILE}; log: ${session.logFile || "unknown"}`
      )
    }
    const exited = () => !alive(session.pid) && !alive(health.pid)
    const waitForExit = async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        if (exited()) return true
        await delay(100)
      }
      return exited()
    }
    try {
      await send("/api/dev/agent/shutdown", { method: "POST", body: {}, endpoint, timeout: 2_000 })
    } catch {
      // Identity was authenticated above; a wedged GUI may never handle exit().
    }
    // Even a graceful app exit leaves the dev server/launcher to clean up.
    if (await waitForExit()) return
    terminate(session.pid, "SIGTERM")
    if (await waitForExit()) return
    terminate(session.pid, "SIGKILL")
    if (!(await waitForExit())) throw new Error(`tracked Tauri process ${health.pid} did not stop`)
  }
}

async function stop() {
  const session = readJson(SESSION_FILE)
  assertResolvedStartup(session)
  const endpoint =
    session && (processAlive(session.pid) || processAlive(session.healthPid))
      ? loadEndpoint(session.endpointFile || discoveryFile())
      : undefined
  await shutdownTrackedSession(session, endpoint, { alive: processTreeAlive })
  if (processTreeAlive(session?.pid))
    throw Object.assign(
      new Error("tracked startup process group still exists; preserving its session record"),
      { code: "debug_shutdown_unconfirmed" }
    )
  removeSession(session)
  output({ ok: true, stoppedPid: session?.pid || null })
}

export async function run(parsed) {
  if (parsed.options.client) return runScoped(parsed)
  const window = parsed.options.window || "main"
  switch (parsed.command) {
    case "launch":
      return withLifecycleLock((timeout) => launch({ ...parsed.options, timeout }), {
        timeout: launchTimeout(parsed.options.timeout),
      })
    case "stop":
      return withLifecycleLock(() => stop(), { timeout: launchTimeout(parsed.options.timeout) })
    case "status": {
      let session = readJson(SESSION_FILE)
      const paths = {
        endpoint: session?.endpointFile || discoveryFile(),
        session: SESSION_FILE,
        log: session?.logFile,
      }
      if (session?.pid && !processAlive(session.pid) && !processAlive(session.healthPid))
        return output({ ok: false, status: "tracked_process_exited", session, paths })
      let endpoint
      try {
        endpoint = loadEndpoint(paths.endpoint)
      } catch (error) {
        return output({
          ok: false,
          status: "missing_endpoint",
          error: error.message,
          session,
          paths,
        })
      }
      if (session?.startedAt) {
        const endpointMtime = fs.statSync(endpoint.file).mtimeMs
        if (endpointMtime + 1_000 < Date.parse(session.startedAt))
          return output({ ok: false, status: "stale_endpoint", session, paths })
      }
      try {
        const health = await request("/api/dev/agent/health", { endpoint })
        if (health.agentDebug !== true)
          return output({ ok: false, status: "normal_non_agent_build", health, session, paths })
        if (session) {
          try {
            const updated = reconcileDebugSession(
              session,
              health,
              endpoint,
              fs.realpathSync(REPO_ROOT)
            )
            session = updated
          } catch (error) {
            return output({
              ok: false,
              status: "ownership_mismatch",
              error: error.message,
              health,
              session,
              paths,
            })
          }
        }
        if (
          !health.helper ||
          health.renderers?.main?.documentLoading ||
          health.renderers?.main?.awaitingLoad
        )
          return output({ ok: false, status: "waiting_for_page", health, session, paths })
        if (health.helper.version !== 3)
          return output({ ok: false, status: "helper_mismatch", health, session, paths })
        const windows = await request("/api/dev/agent/windows", { endpoint })
        return output({
          ok: true,
          status: "ready",
          health,
          windows: windows.windows,
          session,
          paths,
        })
      } catch (error) {
        const status =
          error.status === 401 || error.status === 403
            ? "authentication_failure"
            : error.status === 404
              ? "normal_non_agent_build"
              : session?.sessionId && processAlive(session.pid)
                ? "waiting_for_app"
                : "bridge_unavailable"
        const message = ["bridge_unavailable", "waiting_for_app"].includes(status)
          ? `endpoint exists but the bridge is unreachable: ${endpoint.baseUrl}`
          : error.message
        return output({ ok: false, status, error: message, session, paths })
      }
    }
    case "attach": {
      if (!parsed.options.output)
        throw new Error("attach requires --output <private descriptor path>")
      const { connectTauriSession } = await import("./agent-debug-client.mjs")
      const session = await connectTauriSession({
        windows: (parsed.options.windows || window).split(","),
        canWrite: parsed.options["can-write"] === true,
        idleTimeoutMs:
          parsed.options["idle-timeout"] === undefined
            ? undefined
            : Number(parsed.options["idle-timeout"]),
      })
      const file = path.resolve(parsed.options.output)
      if (fs.existsSync(file)) {
        await session.detach()
        throw new Error("descriptor already exists; choose a new --output path")
      }
      try {
        writePrivateJson(file, session.toJSON(), { exclusive: true })
      } catch (error) {
        await session.detach().catch(() => {})
        throw error
      }
      return output({
        ok: true,
        clientSessionId: session.clientSessionId,
        windows: session.windows,
        canWrite: session.canWrite,
        path: file,
      })
    }
    case "sessions":
      return output(await request("/api/dev/agent/sessions"))
    case "revoke": {
      const [id] = parsed.positional
      if (!id) throw new Error("revoke requires a clientSessionId")
      return output(
        await request(`/api/dev/agent/sessions/${encodeURIComponent(id)}`, { method: "DELETE" })
      )
    }
    case "recover":
      return output(
        await request("/api/dev/agent/recover", { method: "POST", body: {}, timeout: 35_000 })
      )
    case "lease":
    case "detach":
      throw new Error("this command requires --client <descriptor>")
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

async function runScoped(parsed) {
  const allowed = new Set([
    "status",
    "capabilities",
    "windows",
    "snapshot",
    "page.snapshot",
    "act",
    "inspect",
    "page.url",
    "page.title",
    "page.content",
    "goto",
    "page.goto",
    "reload",
    "page.reload",
    "console",
    "page.console",
    "network",
    "page.network",
    "screenshot",
    "page.screenshot",
    "lease",
    "detach",
  ])
  if (!allowed.has(parsed.command))
    throw Object.assign(new Error("command is unavailable with a scoped client descriptor"), {
      code: "owner_command_denied",
    })
  const file = fs.realpathSync(path.resolve(parsed.options.client))
  return withLifecycleLock(
    async () => {
      const { TauriClientSession } = await import("./agent-debug-client.mjs")
      const session = new TauriClientSession(readJson(file) || {})
      const page = session.page(parsed.options.window || session.windows[0])
      const options = { timeout: Number(parsed.options.timeout || 10_000) }
      let result
      try {
        switch (parsed.command) {
          case "status": {
            const status = await session.status()
            result = {
              ok: status.ok,
              control: status.control,
              writerActive: Boolean(status.lease),
              fence: status.lease?.fence,
            }
            break
          }
          case "windows":
            result = { ok: true, windows: session.windows }
            await session.verifyIdentity(options)
            break
          case "capabilities":
            result = await page.capabilities()
            break
          case "snapshot":
          case "page.snapshot":
            result = await page.snapshot({
              includeText: parsed.options["include-text"] === true,
              ...options,
            })
            break
          case "act": {
            const [ref, action, positionalValue] = parsed.positional
            const value = parsed.options.value ?? positionalValue
            if (!ref || !action) throw new Error("act requires a ref and action")
            result = await page.act(
              ref,
              action,
              parsed.options.args
                ? JSON.parse(parsed.options.args)
                : {
                    ...(value === undefined ? {} : { value }),
                    ...(parsed.options.key ? { key: parsed.options.key } : {}),
                  },
              options
            )
            break
          }
          case "inspect":
            result = await page.inspect(
              parsed.positional[0],
              parsed.positional[1],
              parsed.options.args ? JSON.parse(parsed.options.args) : {},
              options
            )
            break
          case "page.url":
            result = await page.url()
            break
          case "page.title":
            result = await page.title()
            break
          case "page.content":
            result = await page.content()
            break
          case "goto":
          case "page.goto":
            result = await page.goto(parsed.positional[0], options)
            break
          case "reload":
          case "page.reload":
            result = await page.reload(options)
            break
          case "console":
          case "page.console":
            result = await page.consoleMessages()
            break
          case "network":
          case "page.network":
            result = await page.networkEvents()
            break
          case "screenshot":
          case "page.screenshot": {
            const target = path.resolve(
              parsed.positional[0] || path.join(CACHE_DIR, `screenshot-${Date.now()}.png`)
            )
            await page.screenshot({ path: target, ...options })
            result = { ok: true, path: target }
            break
          }
          case "lease": {
            const [operation] = parsed.positional
            if (!["acquire", "renew", "release"].includes(operation))
              throw new Error("lease requires acquire, renew or release")
            await session[`${operation}Writer`](options)
            result = { ok: true, writerActive: Boolean(session.lease), fence: session.lease?.fence }
            break
          }
          case "detach":
            await session.detach()
            result = { ok: true }
            break
        }
      } finally {
        if (session.closed) fs.rmSync(file, { force: true })
        else writePrivateJson(file, session.toJSON())
      }
      output(result)
    },
    { workspace: file, timeout: launchTimeout(parsed.options.timeout) }
  )
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  run(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${JSON.stringify(cliErrorPayload(error), null, 2)}\n`)
    process.exitCode = 1
  })
}
