import { spawn, spawnSync } from "node:child_process"
import { constants } from "node:fs"
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { homedir } from "node:os"

export const APP_PATH = "/Applications/ChatGPT.app"
export const APP_EXECUTABLE = `${APP_PATH}/Contents/MacOS/ChatGPT`
export const APP_BUNDLE_ID = "com.openai.codex"
export const DEFAULT_REAL_CLI = `${APP_PATH}/Contents/Resources/codex`
export const DEFAULT_PORT = 4318
export const DEFAULT_CDP_PORT = 9229
export const RELAUNCH_LABEL_PREFIX = "com.cognia.codex-relay-poc.relaunch"
export const ROLLBACK_LABEL_PREFIX = "com.cognia.codex-relay-poc.rollback"
export const DAEMON_LABEL_PREFIX = "com.cognia.codex-shared-runtime-poc.daemon"
export const DAEMON_RELAUNCH_LABEL_PREFIX = "com.cognia.codex-shared-runtime-poc.relaunch"
export const DAEMON_ROLLBACK_LABEL_PREFIX = "com.cognia.codex-shared-runtime-poc.rollback"
export const CDP_ONLY_RELAUNCH_LABEL_PREFIX = "com.cognia.codex-app-control.relaunch"
export const CDP_WEB_LABEL_PREFIX = "com.cognia.codex-cdp-web-poc"

export function relayRoot() {
  return resolve(import.meta.dirname)
}

export function prototypeRoot() {
  return resolve(relayRoot(), "..")
}

export function defaultStateDir() {
  return join(homedir(), ".cognia", "codex-app-control")
}

export function relayPaths(stateDir = process.env.CODEX_RELAY_STATE_DIR ?? defaultStateDir()) {
  const root = resolve(stateDir)
  return {
    root,
    token: join(root, "token"),
    state: join(root, "state.json"),
    log: join(root, "relay.log"),
    arm: join(root, "armed.json"),
    relaunchResult: join(root, "relaunch-result.json"),
    liveTestResult: join(root, "live-test-result.json"),
    relaunchStdout: join(root, "relaunch-worker.stdout.log"),
    relaunchStderr: join(root, "relaunch-worker.stderr.log"),
    rollbackResult: join(root, "rollback-result.json"),
    rollbackStdout: join(root, "rollback-worker.stdout.log"),
    rollbackStderr: join(root, "rollback-worker.stderr.log"),
    daemonState: join(root, "daemon-state.json"),
    daemonRelaunchResult: join(root, "daemon-relaunch-result.json"),
    daemonRelaunchStdout: join(root, "daemon-relaunch-worker.stdout.log"),
    daemonRelaunchStderr: join(root, "daemon-relaunch-worker.stderr.log"),
    daemonStdout: join(root, "shared-app-server.stdout.log"),
    daemonStderr: join(root, "shared-app-server.stderr.log"),
    daemonRollbackResult: join(root, "daemon-rollback-result.json"),
    daemonRollbackStdout: join(root, "daemon-rollback-worker.stdout.log"),
    daemonRollbackStderr: join(root, "daemon-rollback-worker.stderr.log"),
    cdpOnlyRelaunchResult: join(root, "cdp-only-relaunch-result.json"),
    cdpOnlyRelaunchStdout: join(root, "cdp-only-relaunch-worker.stdout.log"),
    cdpOnlyRelaunchStderr: join(root, "cdp-only-relaunch-worker.stderr.log"),
    cdpWebDescriptor: join(root, "cdp-web-descriptor.json"),
    cdpWebStdout: join(root, "cdp-web.stdout.log"),
    cdpWebStderr: join(root, "cdp-web.stderr.log"),
  }
}

export async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

export async function assertExecutable(path) {
  await access(path, constants.X_OK)
}

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(path, value, mode = 0o600) {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode })
  await chmod(temporary, mode)
  await rename(temporary, path)
}

export async function writeSecret(path, value) {
  await writeFile(path, `${value}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

export async function readSecret(path) {
  return (await readFile(path, "utf8")).trim()
}

export function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))
}

export function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  })
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    error: result.error?.message ?? null,
  }
}

export function runDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    ...options,
  })
  child.unref()
  return child.pid
}

export function appProcessIds() {
  const result = commandResult("/bin/ps", ["-axo", "pid=,command="])
  if (!result.ok) {
    throw new Error(result.stderr || result.error || "Unable to inspect ChatGPT process")
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter((match) => {
      const command = match?.[2] ?? ""
      return command === APP_EXECUTABLE || command.startsWith(`${APP_EXECUTABLE} `)
    })
    .map((match) => Number(match[1]))
    .filter((value) => Number.isSafeInteger(value) && value > 0)
}

export function launchctlDomain() {
  return `gui/${process.getuid()}`
}

export function launchctlJobExists(label) {
  return commandResult("/bin/launchctl", ["print", `${launchctlDomain()}/${label}`]).ok
}

export async function waitFor(predicate, { timeoutMs, intervalMs = 250, description }) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  throw new Error(
    `${description ?? "Condition"} did not become ready within ${timeoutMs}ms${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`
  )
}

export async function fetchRelay(path, { port, token, method = "GET", body, timeoutMs = 5000 }) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(payload?.error ?? `${method} ${path} failed with HTTP ${response.status}`)
  }
  return payload
}

export function corsHeadersForOrigin(allowedOrigins, origin) {
  if (typeof origin !== "string" || !allowedOrigins.has(origin)) return {}
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers":
      "Authorization, Content-Type, X-Cognia-Pairing-Code, X-Attachment-Name, X-Attachment-Size, X-Attachment-Relative-Path",
    "access-control-max-age": "600",
    vary: "Origin",
  }
}

export function relayShimPath() {
  return join(relayRoot(), "relay-shim.mjs")
}

export function workerPath(name) {
  return join(relayRoot(), name)
}

export function parseCommonOptions(argv) {
  const options = {
    port: DEFAULT_PORT,
    stateDir: defaultStateDir(),
    realCli: DEFAULT_REAL_CLI,
    appPath: APP_PATH,
    cdpPort: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = argv[index + 1]
    if (argument === "--port" && next) {
      options.port = Number(next)
      index += 1
    } else if (argument === "--state-dir" && next) {
      options.stateDir = resolve(next)
      index += 1
    } else if (argument === "--real-cli" && next) {
      options.realCli = resolve(next)
      index += 1
    } else if (argument === "--app-path" && next) {
      options.appPath = resolve(next)
      index += 1
    } else if (argument === "--cdp-port" && next) {
      options.cdpPort = Number(next)
      index += 1
    }
  }
  if (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error(`Invalid relay port: ${options.port}`)
  }
  if (
    options.cdpPort != null &&
    (!Number.isSafeInteger(options.cdpPort) ||
      options.cdpPort < 1024 ||
      options.cdpPort > 65535 ||
      options.cdpPort === options.port)
  ) {
    throw new Error(`Invalid CDP port: ${options.cdpPort}`)
  }
  return options
}
