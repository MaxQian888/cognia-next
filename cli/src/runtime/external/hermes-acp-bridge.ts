/** Fixed-purpose native helper: official Hermes ACP bound to an owned gateway. */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Transform } from "node:stream"
import { finished as finishedStream } from "node:stream/promises"
import { agentSearchDirs, defaultAgentPathRuntime } from "./agent-path"

export const HERMES_ACP_BOOTSTRAP_ENV = "COGNIA_HERMES_ACP_BOOTSTRAP"
export interface HermesAcpBootstrap {
  configKey: string
  executable: string
  ownedStateRoot: string
  expectedHome: string
  expectedPid: number
  expectedStartupTime: number
  profile: "default"
  instanceId: string
  authorityEpoch: number
  apiOrigin: string
}
export function validateHermesAcpBootstrap(
  raw: string | undefined,
  home: string | undefined
): HermesAcpBootstrap {
  if (!raw || Buffer.byteLength(raw) > 8192)
    throw new Error("Hermes controlled ACP bootstrap is missing or oversized")
  const value = JSON.parse(raw) as Record<string, unknown>
  const keys = [
    "configKey",
    "executable",
    "ownedStateRoot",
    "expectedHome",
    "expectedPid",
    "expectedStartupTime",
    "profile",
    "instanceId",
    "authorityEpoch",
    "apiOrigin",
  ]
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    typeof value.executable !== "string" ||
    !/(?:^|\/)hermes$/.test(value.executable) ||
    (value.executable !== "hermes" && !path.isAbsolute(value.executable)) ||
    typeof value.configKey !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.configKey) ||
    typeof value.ownedStateRoot !== "string" ||
    !path.isAbsolute(value.ownedStateRoot) ||
    !value.ownedStateRoot.endsWith(`/cognia/external-agents/${value.configKey}`) ||
    path.normalize(value.ownedStateRoot) !== value.ownedStateRoot ||
    value.expectedHome !== `${value.ownedStateRoot}/hermes` ||
    value.expectedHome !== home ||
    !Number.isSafeInteger(value.expectedPid) ||
    Number(value.expectedPid) <= 0 ||
    typeof value.expectedStartupTime !== "number" ||
    !Number.isFinite(value.expectedStartupTime) ||
    value.expectedStartupTime <= 0 ||
    value.expectedStartupTime > Date.now() + 2000 ||
    value.profile !== "default" ||
    typeof value.instanceId !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.instanceId) ||
    !Number.isSafeInteger(value.authorityEpoch) ||
    Number(value.authorityEpoch) <= 0 ||
    typeof value.apiOrigin !== "string"
  )
    throw new Error("Hermes controlled ACP bootstrap does not identify an owned native runtime")
  const url = new URL(value.apiOrigin)
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value.apiOrigin !== url.origin ||
    !(host === "::1" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host))
  )
    throw new Error("Hermes controlled ACP endpoint must be a fixed loopback origin")
  return value as unknown as HermesAcpBootstrap
}

/** Only the official ACP module's connector changes; every dial is authenticated and owned. */
export const hermesOwnedEndpointBootstrap = `
import asyncio, json, os, stat, sys, time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

def _run_owned_acp():
    cfg = json.loads(os.environ["COGNIA_HERMES_ACP_BOOTSTRAP"])
    home = Path(cfg["expectedHome"])
    root = Path(cfg["ownedStateRoot"])
    if root.name != cfg["configKey"] or home != root / "hermes" or home != Path(os.environ.get("HERMES_HOME", "")) or home.resolve() != home or root.resolve() != root:
        raise RuntimeError("Hermes owned home mismatch")
    for node in (root, home):
        info = node.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError("Hermes owned state permissions are unsafe")
    from hermes_cli.gateway_runtime import discover_gateway_endpoint
    from hermes_cli.gateway_runtime_discovery import query_identify
    from hermes_cli.gateway_client import connect_gateway as original_connect
    from gateway.status import get_process_start_time
    import acp_adapter.gateway_server as gateway_server
    from acp_adapter.entry import main

    def verified_endpoint():
        identity = query_identify(home, timeout=2)
        live_start = get_process_start_time(cfg["expectedPid"])
        descriptor = os.open(home / "gateway_state.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 65536 or info.st_mode & 0o022:
                raise RuntimeError("Hermes owned status is unsafe")
            raw = os.read(descriptor, 65537)
            if len(raw) > 65536:
                raise RuntimeError("Hermes owned status is oversized")
            state = json.loads(raw)
        finally:
            os.close(descriptor)
        recorded = identity.get("start_time")
        if (identity.get("pid") != cfg["expectedPid"] or identity.get("hermes_home") != str(home)
                or identity.get("kind") != "hermes-gateway" or type(recorded) is not int or live_start is None
                or abs(recorded - live_start) > (200 if sys.platform == "darwin" else 0)
                or state.get("pid") != cfg["expectedPid"] or state.get("hermes_home") != str(home)
                or state.get("start_time") != recorded):
            raise RuntimeError("Hermes owned gateway incarnation changed")
        updated = datetime.fromisoformat(state["updated_at"].replace("Z", "+00:00")).timestamp() * 1000
        if updated < cfg["expectedStartupTime"] - 2000 or abs(time.time() * 1000 - updated) > 120000:
            raise RuntimeError("Hermes owned gateway status is stale")
        discovery = discover_gateway_endpoint(home, timeout=2)
        endpoint = discovery.endpoint
        if (discovery.state != "ready" or endpoint is None or endpoint.profile_id != str(home)
                or endpoint.runtime_protocol != 1 or endpoint.instance_id != cfg["instanceId"]
                or endpoint.authority_epoch != cfg["authorityEpoch"] or endpoint.api_origin != cfg["apiOrigin"]
                or identity.get("instance_id") != cfg["instanceId"]
                or identity.get("authority_epoch") != cfg["authorityEpoch"]):
            raise RuntimeError("Hermes owned gateway authority changed")
        return endpoint

    @asynccontextmanager
    async def controlled_connect(endpoint=None, subject=None, *, max_size=8 * 1024 * 1024):
        endpoint = await asyncio.to_thread(verified_endpoint)
        async with original_connect(endpoint=endpoint, subject=subject, max_size=max_size) as client:
            yield client

    gateway_server.connect_gateway = controlled_connect
    sys.argv = ["hermes-acp"]
    main()

try:
    _run_owned_acp()
except SystemExit:
    raise
except BaseException:
    sys.stderr.write("Hermes controlled ACP requires the compatible official runtime and its unchanged owned gateway; reconnect or update/reinstall Hermes.\\n")
    raise SystemExit(1)
`

/** Current official launcher machine boundary, pinned _launchers.runtime_command. */
export function replaceHermesRuntimeEntry(value: unknown): { command: string; args: string[] } {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((part) => typeof part === "string") ||
    !path.isAbsolute(value[0]) ||
    !/^python(?:\d+(?:\.\d+)*)?$/.test(path.basename(value[0])) ||
    value[1] !== "-I" ||
    value[2] !== "-c" ||
    Buffer.byteLength(value[3]) > 128 * 1024
  )
    throw new Error("Hermes installation returned an incompatible runtime command")
  const suffix =
    /runpy\.run_module\((?:"acp_adapter\.entry"|'acp_adapter\.entry'),\s*run_name=(?:'__main__'|"__main__"),\s*alter_sys=True\)\s*$/
  if (!suffix.test(value[3]) || !value[3].includes("hermes_bootstrap"))
    throw new Error("Hermes installation returned an incompatible runtime command")
  return {
    command: value[0],
    args: [
      "-I",
      "-c",
      value[3].replace(suffix, `exec(${JSON.stringify(hermesOwnedEndpointBootstrap)})`),
    ],
  }
}
export function boundedHermesFrames(limit = 4 * 1024 * 1024): Transform {
  let pending = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      for (const byte of chunk) {
        pending = byte === 10 ? 0 : pending + 1
        if (pending > limit)
          return callback(new Error("Hermes ACP frame exceeds the supported size limit"))
      }
      callback(null, chunk)
    },
  })
}
async function installedFile(file: string): Promise<string> {
  const resolved = await fs.realpath(file)
  const info = await fs.lstat(resolved)
  if (!info.isFile() || (info.uid !== process.getuid!() && info.uid !== 0) || info.mode & 0o022)
    throw new Error("Hermes executable or interpreter is not a trusted installed file")
  await fs.access(resolved, constants.X_OK)
  return resolved
}
async function resolveHermes(command: string): Promise<string> {
  if (path.isAbsolute(command)) return installedFile(command)
  for (const dir of agentSearchDirs(defaultAgentPathRuntime())) {
    try {
      return await installedFile(path.join(dir, "hermes"))
    } catch {
      /* next installed root */
    }
  }
  throw new Error("Hermes native executable is not installed on this Host")
}
export async function resolveHermesPythonCommand(
  executable: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ command: string; args: string[] }> {
  const installed = await resolveHermes(executable)
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        installed,
        ["--print-runtime-command", "--module", "acp_adapter.entry"],
        { env, timeout: 3000, maxBuffer: 128 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout))
      )
    })
    const launch = replaceHermesRuntimeEntry(JSON.parse(output))
    await installedFile(launch.command)
    return launch
  } catch {
    // Genuine legacy console scripts retain their installed Python interpreter.
    // Shell launchers must expose the official machine boundary; do not parse
    // arbitrary shell source or select a global Python fallback.
    const file = await fs.open(installed, "r")
    let source: string
    try {
      const info = await file.stat()
      if (info.size > 128 * 1024)
        throw new Error("Hermes native launcher requires the official runtime command boundary")
      source = await file.readFile("utf8")
    } finally {
      await file.close()
    }
    const match = /^#!\s*(\/[^\r\n ]*python(?:\d+(?:\.\d+)*)?)(?:\s+-s)?\s*$/.exec(
      source.split("\n", 1)[0]
    )
    if (!match || !/from\s+hermes_cli\.main\s+import\s+main/.test(source))
      throw new Error(
        "Hermes launcher cannot expose its compatible isolated Python runtime; update/reinstall Hermes"
      )
    const interpreter = await installedFile(match[1])
    return { command: interpreter, args: ["-I", "-c", hermesOwnedEndpointBootstrap] }
  }
}
/** stdin/stdout remain ACP; only the verified environment carries setup. */
export async function runHermesAcpBridge(): Promise<number> {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error("Hermes controlled ACP requires a supported native Host")
  const bootstrap = validateHermesAcpBootstrap(
    process.env[HERMES_ACP_BOOTSTRAP_ENV],
    process.env.HERMES_HOME
  )
  const launch = await resolveHermesPythonCommand(bootstrap.executable)
  const child: ChildProcessWithoutNullStreams = spawn(launch.command, launch.args, {
    cwd: process.cwd(),
    env: { ...process.env, HERMES_HOME: bootstrap.expectedHome, HERMES_TUI_GATEWAY_URL: "" },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const inbound = boundedHermesFrames(),
    outbound = boundedHermesFrames()
  return new Promise((resolve, reject) => {
    let finished = false
    const cleanup = () => {
      process.stdin.unpipe(inbound)
      process.stdin.pause()
      inbound.unpipe(child.stdin)
      inbound.destroy()
      child.stdout.unpipe(outbound)
      outbound.unpipe(process.stdout)
      process.off("SIGTERM", stop)
      process.off("SIGINT", stop)
    }
    const fail = (error: Error) => {
      if (!finished) {
        finished = true
        child.kill("SIGKILL")
        cleanup()
        reject(error)
      }
    }
    const stop = () => {
      child.kill("SIGTERM")
    }
    process.on("SIGTERM", stop)
    process.on("SIGINT", stop)
    inbound.on("error", fail)
    outbound.on("error", fail)
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") fail(error)
    })
    child.on("error", fail)
    child.once("close", (code) => {
      void finishedStream(outbound, { cleanup: true }).then(() => {
        if (!finished) {
          finished = true
          cleanup()
          resolve(code ?? 1)
        }
      }, fail)
    })
    process.stdin.pipe(inbound).pipe(child.stdin)
    child.stdout.pipe(outbound).pipe(process.stdout, { end: false })
    child.stderr.pipe(process.stderr, { end: false })
  })
}
if (process.argv[2] === "--cognia-hermes-acp" && process.argv.length === 3) {
  void runHermesAcpBridge().then(
    (code) => {
      process.exitCode = code
    },
    () => {
      process.stderr.write(
        "Hermes controlled ACP could not start; verify its native installation and owned gateway.\n"
      )
      process.exitCode = 1
    }
  )
}
