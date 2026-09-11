import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { NodeExternalAgentSpawnConfig } from "./node-backend"

const PAYLOAD_ENV = "COGNIA_GATEWAY_TASK_CONFIG"
const ALLOWED_FILES = new Set([
  "codex/config.toml",
  "pi/models.json",
  "pi/settings.json",
  "qwen/settings.json",
])
const ESSENTIAL_ENV = new Set([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "WINDIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
])

export function gatewayRuntimeEnvironment(ambient: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(ambient).filter(([key]) => ESSENTIAL_ENV.has(key)))
}

export function deleteGatewayTask(taskId: string, home = os.homedir()): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) throw new Error("Invalid gateway task id")
  const parent = path.join(home, ".local/share/cognia-agent-tasks")
  const root = path.join(parent, taskId)
  for (const directory of [parent, root]) {
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink())
      throw new Error("Gateway task state must not be a symlink")
  }
  fs.rmSync(root, { recursive: true, force: true })
}

function privateDirectory(directory: string): void {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink())
    throw new Error("Gateway task state must not be a symlink")
  if (!fs.existsSync(path.dirname(directory))) privateDirectory(path.dirname(directory))
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
}

function privateWrite(filename: string, contents: string): void {
  if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink())
    throw new Error("Gateway task file must not be a symlink")
  privateDirectory(path.dirname(filename))
  fs.writeFileSync(filename, contents, { mode: 0o600 })
  fs.chmodSync(filename, 0o600)
}

/** Fixed host-owned paths retain conversation state; config files never contain the lease. */
export function prepareGatewayTask(
  config: NodeExternalAgentSpawnConfig,
  home = os.homedir()
): {
  config: NodeExternalAgentSpawnConfig
  cleanup: () => void
} {
  const raw = config.env?.[PAYLOAD_ENV]
  if (!raw) return { config, cleanup() {} }
  const payload = JSON.parse(raw) as {
    taskId: string
    binding: unknown
    runtime: string
    ownerAccountId: string | null
    files: Record<string, string>
  }
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.taskId) ||
    !["codex", "opencode", "pi", "claude", "qwen"].includes(payload.runtime) ||
    !payload.files ||
    Object.entries(payload.files).some(
      ([name, value]) =>
        !ALLOWED_FILES.has(name) || typeof value !== "string" || value.length > 262144
    )
  ) {
    throw new Error("Invalid gateway task configuration")
  }
  let root = path.join(home, ".local/share/cognia-agent-tasks", payload.taskId)
  privateDirectory(root)
  root = fs.realpathSync(root)
  const bindingPath = path.join(root, "binding.json")
  const binding = JSON.stringify({
    binding: payload.binding,
    runtime: payload.runtime,
    ownerAccountId: payload.ownerAccountId ?? null,
  })
  if (fs.existsSync(bindingPath)) {
    if (fs.readFileSync(bindingPath, "utf8") !== binding)
      throw new Error("This task is bound to a different model or account; start a new task")
  } else privateWrite(bindingPath, binding)
  const files: string[] = []
  const cleanup = () => {
    for (const filename of files) fs.rmSync(filename, { force: true })
  }
  try {
    for (const [name, contents] of Object.entries(payload.files)) {
      const filename = path.join(root, name)
      privateWrite(filename, contents)
      files.push(filename)
    }
    const env = { ...config.env }
    delete env[PAYLOAD_ENV]
    env.COGNIA_GATEWAY_TASK_HOME = root
    for (const [key, relative] of Object.entries({
      HOME: "",
      USERPROFILE: "",
      XDG_CONFIG_HOME: "config",
      XDG_DATA_HOME: "data",
      XDG_CACHE_HOME: "cache",
      XDG_STATE_HOME: "state",
      CODEX_HOME: "codex",
      PI_CODING_AGENT_DIR: "pi",
      CLAUDE_CONFIG_DIR: "claude",
      OPENCODE_CONFIG_DIR: "config/opencode",
    })) {
      const directory = path.join(root, relative)
      privateDirectory(directory)
      env[key] = directory
    }
    if (payload.runtime === "qwen") {
      env.QWEN_HOME = path.join(root, "qwen")
      env.QWEN_RUNTIME_DIR = path.join(root, "qwen-runtime")
      privateDirectory(env.QWEN_RUNTIME_DIR)
      env.QWEN_CODE_SYSTEM_SETTINGS_PATH = path.join(root, "qwen/settings.json")
      env.QWEN_CODE_SYSTEM_DEFAULTS_PATH = env.QWEN_CODE_SYSTEM_SETTINGS_PATH
    }
    return { config: { ...config, env }, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}
