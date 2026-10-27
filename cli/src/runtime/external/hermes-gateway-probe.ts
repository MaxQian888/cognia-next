/**
 * Narrow Node-only readiness helper for an already owned foreground Hermes
 * gateway. It never starts a gateway, reads credentials, issues HTTP requests,
 * or accepts an arbitrary control socket. Wire/path contract pinned in
 * .cache/agent-support-audit-2026-10-27/hermes-upstream/SOURCES.json.
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"

const RESPONSE_LIMIT = 512 * 1024
const FILE_LIMIT = 64 * 1024
const INPUT_LIMIT = 8192
const DEADLINE_MS = 2000

export interface HermesGatewayProbeRequest {
  configKey: string
  ownedStateRoot: string
  expectedHome: string
  expectedPid: number
  /** UNIX milliseconds recorded by the host immediately before foreground launch. */
  expectedStartupTime: number
  profile: "default"
}
export interface HermesGatewayProbeResult {
  ready: true
  endpoint: {
    profileId: string
    instanceId: string
    authorityEpoch: number
    apiOrigin: string
    runtimeProtocol: 1
  }
}
export interface HermesGatewayProcessIdentity {
  pid: number
  uid: number
  /** Matches Hermes' Linux clock-tick / macOS epoch-centisecond fingerprint. */
  startFingerprint: number
  startedAtMs?: number
}
export interface HermesGatewayProbeDeps {
  readProcessIdentity?(pid: number): Promise<HermesGatewayProcessIdentity>
}
export class HermesGatewayProbeError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "HermesGatewayProbeError"
  }
}
function refuse(code: string): never {
  throw new HermesGatewayProbeError(code)
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    refuse("invalid_control_response")
  return value as Record<string, unknown>
}
function validateRequest(value: unknown): HermesGatewayProbeRequest {
  const request = object(value)
  const keys = [
    "configKey",
    "ownedStateRoot",
    "expectedHome",
    "expectedPid",
    "expectedStartupTime",
    "profile",
  ]
  if (Object.keys(request).some((key) => !keys.includes(key))) refuse("invalid_probe_request")
  if (
    typeof request.configKey !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(request.configKey) ||
    typeof request.ownedStateRoot !== "string" ||
    !path.isAbsolute(request.ownedStateRoot) ||
    !request.ownedStateRoot.endsWith(`/cognia/external-agents/${request.configKey}`) ||
    path.normalize(request.ownedStateRoot) !== request.ownedStateRoot
  )
    refuse("invalid_owned_root")
  if (request.expectedHome !== path.join(request.ownedStateRoot, "hermes"))
    refuse("invalid_owned_home")
  if (
    !Number.isSafeInteger(request.expectedPid) ||
    Number(request.expectedPid) <= 0 ||
    typeof request.expectedStartupTime !== "number" ||
    !Number.isFinite(request.expectedStartupTime) ||
    request.expectedStartupTime <= 0 ||
    request.expectedStartupTime > Date.now() + 2000 ||
    request.profile !== "default"
  )
    refuse("invalid_probe_request")
  return request as unknown as HermesGatewayProbeRequest
}
async function privateNode(
  file: string,
  kind: "directory" | "socket" | "file",
  privateMode = true
) {
  const metadata = await fs.lstat(file)
  const isKind =
    kind === "directory"
      ? metadata.isDirectory()
      : kind === "socket"
        ? metadata.isSocket()
        : metadata.isFile()
  if (!isKind || metadata.isSymbolicLink() || metadata.uid !== process.getuid!())
    refuse("unsafe_control_path")
  if (metadata.mode & (privateMode ? 0o077 : 0o022)) refuse("unsafe_control_permissions")
  return metadata
}
async function readPrivateFile(file: string, limit: number, privateMode = true): Promise<string> {
  await privateNode(file, "file", privateMode)
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    const metadata = await handle.stat()
    if (
      !metadata.isFile() ||
      metadata.uid !== process.getuid!() ||
      metadata.nlink !== 1 ||
      metadata.mode & (privateMode ? 0o077 : 0o022)
    )
      refuse("unsafe_control_path")
    if (metadata.size > limit) refuse("oversized_control_file")
    const data = Buffer.alloc(limit + 1)
    const { bytesRead } = await handle.read(data, 0, data.length, 0)
    if (bytesRead > limit) refuse("oversized_control_file")
    return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}
async function socketPath(home: string): Promise<string> {
  const direct = path.join(home, "gateway.sock")
  try {
    await privateNode(direct, "socket")
    return direct
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const target = (await readPrivateFile(path.join(home, "gateway.sock.path"), 4096)).trim()
  const hash = createHash("sha256").update(home).digest("hex").slice(0, 16)
  if (
    !path.isAbsolute(target) ||
    path.basename(target) !== "control.sock" ||
    path.basename(path.dirname(target)) !== `hermes-gw-${hash}` ||
    path.normalize(target) !== target
  )
    refuse("invalid_control_pointer")
  await privateNode(path.dirname(target), "directory")
  if ((await fs.realpath(path.dirname(target))) !== path.dirname(target))
    refuse("unsafe_control_path")
  await privateNode(target, "socket")
  return target
}

/** Independently establish PID incarnation; no caller-selected executable is run. */
export async function readHermesGatewayProcessIdentity(
  pid: number
): Promise<HermesGatewayProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) refuse("invalid_process_identity")
  process.kill(pid, 0)
  if (process.platform === "linux") {
    const proc = `/proc/${pid}`
    const owner = await fs.stat(proc)
    const stat = await fs.readFile(`${proc}/stat`, "utf8")
    const afterComm = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/)
    const fingerprint = Number(afterComm[19])
    if (!Number.isSafeInteger(fingerprint) || fingerprint <= 0) refuse("invalid_process_identity")
    return { pid, uid: owner.uid, startFingerprint: fingerprint }
  }
  if (process.platform === "darwin") {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        "/bin/ps",
        ["-p", String(pid), "-o", "uid=", "-o", "lstart="],
        { timeout: 500, maxBuffer: 1024, env: { ...process.env, LC_ALL: "C" } },
        (error, stdout) => (error ? reject(error) : resolve(stdout))
      )
    })
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(output)
    const startedAtMs = match ? Date.parse(match[2]) : NaN
    if (!match || !Number.isFinite(startedAtMs)) refuse("invalid_process_identity")
    return { pid, uid: Number(match[1]), startFingerprint: startedAtMs / 10, startedAtMs }
  }
  return refuse("unsupported_control_authentication")
}

function identify(
  controlPath: string,
  before: Awaited<ReturnType<typeof privateNode>>
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: controlPath })
    let size = 0
    const chunks: Buffer[] = []
    let settled = false
    const finish = (error?: unknown, value?: Record<string, unknown>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(value!)
    }
    const timer = setTimeout(
      () => finish(new HermesGatewayProbeError("control_timeout")),
      DEADLINE_MS
    )
    socket.once("connect", () => {
      // Node has no public SO_PEERCRED/getpeereid API. Authenticate the private
      // owner-only path and unchanged socket inode, then bind the reply to the
      // independently verified owned PID. Never claim a kernel peer-UID check.
      void privateNode(controlPath, "socket")
        .then((after) => {
          if (after.dev !== before.dev || after.ino !== before.ino) refuse("unsafe_control_peer")
          socket.write('{"protocol":1,"verb":"identify","id":1}\n')
        })
        .catch((error: unknown) => finish(error))
    })
    socket.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > RESPONSE_LIMIT)
        return finish(new HermesGatewayProbeError("oversized_control_response"))
      chunks.push(chunk)
      if (!chunk.includes(10)) return
      try {
        const all = Buffer.concat(chunks)
        const line = all.subarray(0, all.indexOf(10))
        const response = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)))
        if (response.ok !== true || response.protocol !== 1 || response.id !== 1)
          refuse("invalid_control_response")
        finish(undefined, object(response.result))
      } catch {
        finish(new HermesGatewayProbeError("invalid_control_response"))
      }
    })
    socket.once("error", () => finish(new HermesGatewayProbeError("control_unavailable")))
    socket.once("end", () => finish(new HermesGatewayProbeError("incomplete_control_response")))
    socket.once("close", () => finish(new HermesGatewayProbeError("incomplete_control_response")))
  })
}
function ownerMatches(
  value: Record<string, unknown>,
  request: HermesGatewayProbeRequest,
  identity: HermesGatewayProcessIdentity
) {
  if (
    value.kind !== "hermes-gateway" ||
    value.pid !== request.expectedPid ||
    value.hermes_home !== request.expectedHome ||
    typeof value.start_time !== "number" ||
    !Number.isSafeInteger(value.start_time) ||
    value.start_time <= 0 ||
    Math.abs(value.start_time - identity.startFingerprint) >
      (process.platform === "darwin" ? 200 : 0)
  )
    refuse("runtime_owner_mismatch")
}

/** One read-only identify exchange, bounded independently of the caller's retry loop. */
export async function probeHermesGateway(
  input: HermesGatewayProbeRequest,
  deps: HermesGatewayProbeDeps = {}
): Promise<HermesGatewayProbeResult> {
  if (process.platform !== "linux" && process.platform !== "darwin")
    refuse("unsupported_control_authentication")
  const request = validateRequest(input)
  await privateNode(request.ownedStateRoot, "directory")
  await privateNode(request.expectedHome, "directory")
  if (
    (await fs.realpath(request.ownedStateRoot)) !== request.ownedStateRoot ||
    (await fs.realpath(request.expectedHome)) !== request.expectedHome
  )
    refuse("unsafe_control_path")
  const identity = await (deps.readProcessIdentity ?? readHermesGatewayProcessIdentity)(
    request.expectedPid
  )
  if (
    identity.pid !== request.expectedPid ||
    identity.uid !== process.getuid!() ||
    (identity.startedAtMs !== undefined &&
      identity.startedAtMs < request.expectedStartupTime - 2000)
  )
    refuse("runtime_owner_mismatch")
  const state = object(
    JSON.parse(
      await readPrivateFile(
        path.join(request.expectedHome, "gateway_state.json"),
        FILE_LIMIT,
        false
      )
    )
  )
  ownerMatches(state, request, identity)
  const updatedAt = typeof state.updated_at === "string" ? Date.parse(state.updated_at) : NaN
  if (
    !Number.isFinite(updatedAt) ||
    updatedAt < request.expectedStartupTime - 2000 ||
    updatedAt < Date.now() - 120000 ||
    updatedAt > Date.now() + 2000
  )
    refuse("stale_runtime_state")
  if (
    ["stopped", "startup_failed", "failed", "draining", "conflict"].includes(
      String(state.gateway_state)
    )
  )
    refuse("runtime_not_ready")
  const control = await socketPath(request.expectedHome)
  const reply = await identify(control, await privateNode(control, "socket"))
  ownerMatches(reply, request, identity)
  if (reply.start_time !== state.start_time || reply.profile !== request.profile)
    refuse("runtime_owner_mismatch")
  if (reply.protocol !== 1 || reply.runtime_protocol !== 1) refuse("incompatible_runtime_protocol")
  if (reply.state !== "ready") refuse("runtime_not_ready")
  if (reply.supervisor !== "external") refuse("runtime_owner_mismatch")
  if (
    typeof reply.instance_id !== "string" ||
    !/^[0-9a-f]{32}$/.test(reply.instance_id) ||
    !Number.isSafeInteger(reply.authority_epoch) ||
    Number(reply.authority_epoch) <= 0
  )
    refuse("invalid_runtime_identity")
  if (
    !Array.isArray(reply.capabilities) ||
    !reply.capabilities.every((item) => typeof item === "string") ||
    !reply.capabilities.includes("session-authority-v1")
  )
    refuse("session_authority_unavailable")
  if (!Array.isArray(reply.served_profiles)) refuse("profile_mismatch")
  const profiles = reply.served_profiles.filter((value) => {
    const profile = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
    return profile.home === request.expectedHome && profile.profile_id === request.expectedHome
  })
  if (profiles.length !== 1) refuse("profile_mismatch")
  if (typeof reply.api_origin !== "string") refuse("invalid_api_origin")
  let url: URL
  try {
    url = new URL(reply.api_origin)
  } catch {
    return refuse("invalid_api_origin")
  }
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !(host === "::1" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)) ||
    reply.api_origin !== url.origin
  )
    refuse("invalid_api_origin")
  // Recheck incarnation after the exchange rather than accepting a dead owner.
  const current = await (deps.readProcessIdentity ?? readHermesGatewayProcessIdentity)(
    request.expectedPid
  )
  ownerMatches(reply, request, current)
  return {
    ready: true,
    endpoint: {
      profileId: request.expectedHome,
      instanceId: reply.instance_id,
      authorityEpoch: Number(reply.authority_epoch),
      apiOrigin: reply.api_origin,
      runtimeProtocol: 1,
    },
  }
}

/** Gated entry point for the bundled helper; errors expose stable codes only. */
export function runHermesGatewayProbe(): void {
  let input = Buffer.alloc(0)
  let consumed = false
  const respond = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
  const stop = (code: string) => {
    if (consumed) return
    consumed = true
    clearTimeout(timer)
    process.stdin.destroy()
    respond({ ready: false, code })
    process.exitCode = 1
  }
  const timer = setTimeout(() => stop("probe_input_timeout"), DEADLINE_MS)
  process.stdin.on("data", (chunk: Buffer) => {
    if (consumed) return
    if (input.length + chunk.length > INPUT_LIMIT) return stop("oversized_probe_request")
    input = Buffer.concat([input, chunk])
    const newline = input.indexOf(10)
    if (newline < 0) return
    consumed = true
    clearTimeout(timer)
    process.stdin.destroy()
    void (async () => {
      try {
        respond(await probeHermesGateway(JSON.parse(input.subarray(0, newline).toString("utf8"))))
      } catch (error) {
        respond({
          ready: false,
          code: error instanceof HermesGatewayProbeError ? error.code : "probe_unavailable",
        })
        process.exitCode = 1
      }
    })()
  })
  process.stdin.once("end", () => {
    clearTimeout(timer)
    stop("incomplete_probe_request")
  })
  process.stdin.once("error", () => {
    clearTimeout(timer)
    stop("probe_input_error")
  })
}
if (process.argv[2] === "--hermes-gateway-probe" && process.argv.length === 3)
  runHermesGatewayProbe()
