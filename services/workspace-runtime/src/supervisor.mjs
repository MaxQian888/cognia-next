import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

const INHERITED_AGENT_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "USER",
  "LOGNAME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
]

function agentBaseEnv(hostEnv) {
  return Object.fromEntries(
    INHERITED_AGENT_ENV_KEYS.flatMap((key) =>
      typeof hostEnv[key] === "string" ? [[key, hostEnv[key]]] : []
    )
  )
}

export class AgentSupervisor {
  constructor({ workspaceRoot = process.cwd(), onEvent = () => {}, hostEnv = process.env } = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot)
    this.onEvent = onEvent
    this.baseEnv = agentBaseEnv(hostEnv)
    this.agents = new Map()
  }

  async spawn({ id, command, args = [], env = {}, cwd = this.workspaceRoot }) {
    if (this.agents.get(id)?.state === "running") throw new Error(`agent ${id} already running`)
    const resolvedCwd = path.resolve(cwd)
    if (!isWithin(this.workspaceRoot, resolvedCwd))
      throw new Error("agent cwd is outside workspace")
    const [realWorkspaceRoot, realCwd] = await Promise.all([
      fs.realpath(this.workspaceRoot),
      fs.realpath(resolvedCwd),
    ])
    if (!isWithin(realWorkspaceRoot, realCwd)) throw new Error("agent cwd is outside workspace")
    const child = spawn(command, args, {
      cwd: resolvedCwd,
      // Runtime authentication and orchestration variables must never cross
      // into an untrusted external-agent process. Agent-specific credentials
      // are supplied explicitly by the spawn request.
      env: { ...this.baseEnv, ...env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const record = { id, child, state: "starting", pid: child.pid ?? null, exitCode: null }
    this.agents.set(id, record)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (data) => this.onEvent({ type: "stdout", agentId: id, data }))
    child.stderr.on("data", (data) => this.onEvent({ type: "stderr", agentId: id, data }))
    child.once("exit", (code, signal) => {
      record.state = "stopped"
      record.exitCode = code
      this.onEvent({ type: "exit", agentId: id, code, signal })
    })
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve)
      child.once("error", reject)
    })
    record.state = "running"
    this.onEvent({ type: "state", agentId: id, state: "running" })
    return this.status(id)
  }

  async send(id, message) {
    const record = this.requireRunning(id)
    await new Promise((resolve, reject) => {
      record.child.stdin.write(message, (error) => (error ? reject(error) : resolve()))
    })
  }

  async kill(id) {
    const record = this.agents.get(id)
    if (!record || record.state === "stopped") return
    await new Promise((resolve) => {
      record.child.once("exit", resolve)
      record.child.kill("SIGTERM")
      const timer = setTimeout(() => record.child.kill("SIGKILL"), 5_000)
      timer.unref()
    })
  }

  async killAll() {
    await Promise.all([...this.agents.keys()].map((id) => this.kill(id)))
  }

  status(id) {
    const record = this.agents.get(id)
    if (!record) return { id, state: "not_found", pid: null, exitCode: null }
    return { id, state: record.state, pid: record.pid, exitCode: record.exitCode }
  }

  list() {
    return [...this.agents.keys()].map((id) => this.status(id))
  }

  requireRunning(id) {
    const record = this.agents.get(id)
    if (!record || record.state !== "running") throw new Error(`agent ${id} is not running`)
    return record
  }
}
