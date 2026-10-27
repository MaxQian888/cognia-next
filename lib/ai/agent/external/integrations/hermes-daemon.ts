/**
 * Hermes ACP is a viewer of a durable gateway. This host module owns the real
 * confined foreground daemon; a Boolean supplied by agent metadata is never
 * accepted as execution ownership. Native sessions share this owned gateway
 * while each ACP viewer keeps its own protocol connection.
 */
import type { AcpClientDeps } from "@cognia/agent-acp/client"
import type { AgentLaunchEnvironmentResolver, AgentProcessHost } from "@cognia/agent-contracts/host"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import { normalizeFsPath } from "@/lib/files/permissions"
import { isPathUnderRoot } from "@/lib/sandbox/policy-bridge"
import { agentInvoke, runsExternalAgentProcessesLocally } from "../agent-transport"
import { buildAgentEnv } from "../config/env-builder"
import { resolveBundledAgentBridge, type BundledAgentBridgeLaunch } from "../host/native-bridge"
import { createAgentTransportProcessHost } from "../host/process-host"
import {
  getExternalAgentStateRootInfo,
  type ExternalAgentStateRootInfo,
} from "../lifecycle/state-root"
import { AGENT_STATE_KEY_ENV, AGENT_STATE_KEY_PATTERN } from "../policy/security-policy"

type Prepare = NonNullable<AcpClientDeps["prepareControlledDaemon"]>
type Lease = Awaited<ReturnType<Prepare>>
export interface HermesControlledDaemonDeps {
  processHost: AgentProcessHost
  ownsLocalProcesses(): boolean
  stateRootInfo(key: string): Promise<ExternalAgentStateRootInfo | null>
  processInfo(id: string): Promise<unknown>
  resolveBridge(id: "hermes-probe" | "hermes-acp"): Promise<BundledAgentBridgeLaunch>
  resolveEnvironment: AgentLaunchEnvironmentResolver
  startupTimeoutMs?: number
  retryDelayMs?: number
}
interface Owner {
  workspace: string
  authority: string
  root: string
  home: string
  key: string
  env: Record<string, string>
  refs: number
  processIds: Set<string>
  processId?: string
  pid?: number
  startedAt?: number
  endpoint?: { instanceId: string; authorityEpoch: number; apiOrigin: string }
  exited: boolean
  ready: Promise<void>
  stopping?: Promise<void>
  cleanupFailed: boolean
  unlisten?: () => void
}
function hash(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)))
}
export function hermesStateKey(configId: string): string {
  if (!AGENT_STATE_KEY_PATTERN.test(configId))
    throw new Error("Hermes requires a valid original configuration state key")
  return configId
}
const absolute = (value: string | undefined): value is string => !!value && value.startsWith("/")
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** A coordinator is shared by built-in clients, not by unrelated native processes. */
export function createHermesControlledDaemonHost(deps: HermesControlledDaemonDeps): Prepare {
  const owners = new Map<string, Owner>()
  const host = deps.processHost

  async function stop(owner: Owner): Promise<void> {
    if (owner.stopping) return owner.stopping
    owner.stopping = (async () => {
      const results = await Promise.allSettled(
        [...owner.processIds].map(async (id) => {
          await host.kill(id)
          owner.processIds.delete(id)
        })
      )
      const failure = results.find((result) => result.status === "rejected")
      if (failure?.status === "rejected") {
        owner.cleanupFailed = true
        throw failure.reason
      }
      owner.unlisten?.()
      owner.unlisten = undefined
      if (owners.get(owner.root) === owner) owners.delete(owner.root)
    })()
    try {
      await owner.stopping
    } finally {
      owner.stopping = undefined
    }
  }

  async function verifyOwnedPid(owner: Owner): Promise<number> {
    if (owner.exited || !owner.processId) throw new Error("Hermes owned foreground gateway exited")
    const info = record(await deps.processInfo(owner.processId))
    if (
      info.id !== owner.processId ||
      !Number.isSafeInteger(info.pid) ||
      Number(info.pid) <= 0 ||
      /stopped|error|exited|failed/i.test(String(info.state))
    )
      throw new Error("Hermes native host did not confirm its owned foreground PID")
    if (owner.pid !== undefined && owner.pid !== info.pid)
      throw new Error("Hermes foreground PID changed; reconnect the configuration")
    return Number(info.pid)
  }

  async function probe(
    owner: Owner,
    config: ExternalAgentConfig,
    launch: BundledAgentBridgeLaunch,
    startedAt: number
  ): Promise<void> {
    const pid = await verifyOwnedPid(owner)
    const requestedId = `${config.id}:hermes-probe:${crypto.randomUUID()}`
    let processId = requestedId
    let releaseLine: (() => void) | undefined, releaseExit: (() => void) | undefined
    let resolve!: (value: void) => void, reject!: (error: Error) => void
    let settled = false
    const answer = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    void answer.catch(() => undefined)
    const timer = setTimeout(() => reject(new Error("Hermes readiness probe timed out")), 3000)
    try {
      releaseLine = await host.onStdoutLine((event) => {
        if (event.processId !== processId || settled) return
        settled = true
        try {
          if (new TextEncoder().encode(event.data).length > 16384)
            throw new Error("oversized_control_response")
          const response = record(JSON.parse(event.data))
          if (response.ready !== true)
            throw new Error(
              `Hermes readiness rejected: ${typeof response.code === "string" && /^[a-z_]{1,80}$/.test(response.code) ? response.code : "invalid_probe_reply"}`
            )
          const endpoint = record(response.endpoint)
          if (
            endpoint.profileId !== owner.home ||
            endpoint.runtimeProtocol !== 1 ||
            typeof endpoint.instanceId !== "string" ||
            !/^[a-f0-9]{32}$/.test(endpoint.instanceId) ||
            !Number.isSafeInteger(endpoint.authorityEpoch) ||
            Number(endpoint.authorityEpoch) <= 0
          )
            throw new Error("Hermes probe returned an invalid owned runtime identity")
          owner.pid = pid
          if (typeof endpoint.apiOrigin !== "string") throw new Error("invalid_probe_reply")
          owner.endpoint = {
            instanceId: endpoint.instanceId,
            authorityEpoch: Number(endpoint.authorityEpoch),
            apiOrigin: endpoint.apiOrigin,
          }
          resolve()
        } catch (error) {
          reject(error instanceof Error ? error : new Error("invalid_probe_reply"))
        }
      })
      releaseExit = await host.onExit((event) => {
        if (event.processId === processId && !settled) {
          settled = true
          reject(new Error("Hermes readiness probe exited without a verified ready response"))
        }
      })
      owner.processIds.add(requestedId)
      processId = await host.spawn({
        id: requestedId,
        command: launch.command,
        args: [...launch.args],
        cwd: owner.workspace,
        env: {
          [AGENT_STATE_KEY_ENV]: owner.key,
          HERMES_HOME: owner.home,
          HERMES_TUI_GATEWAY_URL: "",
        },
        sandboxPolicy: config.sandboxPolicy,
        framing: "line",
      })
      if (processId !== requestedId) {
        owner.processIds.delete(requestedId)
        owner.processIds.add(processId)
      }
      await host.send(
        processId,
        JSON.stringify({
          configKey: owner.key,
          ownedStateRoot: owner.root,
          expectedHome: owner.home,
          expectedPid: pid,
          expectedStartupTime: startedAt,
          profile: "default",
        })
      )
      await answer
    } finally {
      clearTimeout(timer)
      releaseLine?.()
      releaseExit?.()
      try {
        await host.kill(processId)
      } catch (error) {
        owner.cleanupFailed = true
        throw error
      }
      owner.processIds.delete(processId)
    }
  }

  async function start(owner: Owner, config: ExternalAgentConfig): Promise<void> {
    const process = config.process!
    const launch = await deps.resolveBridge("hermes-probe")
    const startedAt = Date.now()
    owner.startedAt = startedAt
    const deadline = startedAt + (deps.startupTimeoutMs ?? 30000)
    owner.processId = `${config.id}:hermes-gateway:${crypto.randomUUID()}`
    owner.unlisten = await host.onExit((event) => {
      if (event.processId === owner.processId) owner.exited = true
    })
    const env = await deps.resolveEnvironment(config, process.env ?? {})
    owner.processIds.add(owner.processId)
    const requested = owner.processId
    owner.processId = await host.spawn({
      id: requested,
      command: process.command,
      args: [
        "--profile",
        "default",
        "gateway",
        "run",
        "--quiet",
        "--no-supervise",
        "--external-supervisor",
      ],
      cwd: owner.workspace,
      env: { ...env, ...owner.env },
      sandboxPolicy: config.sandboxPolicy,
    })
    if (owner.processId !== requested) {
      owner.processIds.delete(requested)
      owner.processIds.add(owner.processId)
    }
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        await probe(owner, config, launch, startedAt)
        return
      } catch (error) {
        lastError = error
        if (
          owner.exited ||
          owner.cleanupFailed ||
          /mismatch|unsafe_|invalid_|incompatible|session_authority_unavailable/.test(String(error))
        )
          throw error
        await new Promise((resolve) => setTimeout(resolve, deps.retryDelayMs ?? 100))
      }
    }
    throw new Error(
      `Hermes owned gateway was not ready before its startup deadline: ${lastError instanceof Error ? lastError.message : "unavailable"}`
    )
  }

  return async (config) => {
    if (config.stateIsolation !== "isolated")
      throw new Error(
        "Hermes requires isolated state; configure provider credentials with native setup in its Cognia-owned HERMES_HOME"
      )
    if (!deps.ownsLocalProcesses() || !host.available)
      throw new Error(
        "Hermes requires a configured native Host that owns its foreground gateway; connect this agent on that Host"
      )
    const process = config.process
    if (!process || config.transport !== "stdio" || !absolute(process.cwd))
      throw new Error("Hermes requires an absolute configured workspace before gateway launch")
    if (
      !/(?:^|\/)hermes$/.test(process.command.replaceAll("\\", "/")) ||
      !['["acp"]', '["--profile","default","acp"]'].includes(JSON.stringify(process.args ?? []))
    )
      throw new Error(
        "Hermes controlled mode requires the native hermes executable with acp and the default profile"
      )
    if (
      process.env?.COGNIA_BOT_ISOLATION ||
      process.env?.COGNIA_GATEWAY_TASK_CONFIG ||
      process.env?.COGNIA_GATEWAY_TASK_HOME
    )
      throw new Error("Hermes controlled gateway requires its own host-managed private state")
    const suppliedKey = process.env?.[AGENT_STATE_KEY_ENV]
    const key = suppliedKey ? hermesStateKey(suppliedKey) : hermesStateKey(config.id)
    const info = await deps.stateRootInfo(key)
    const root = info?.path
    if (!absolute(root) || !root.endsWith(`/cognia/external-agents/${key}`))
      throw new Error("Hermes host did not resolve its own private state root")
    const authority = hash(
      JSON.stringify({
        policy: config.sandboxPolicy ?? null,
        command: process.command,
        env: Object.entries(process.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      })
    )
    let owner = owners.get(root)
    if (owner?.stopping) {
      await owner.stopping
      owner = owners.get(root)
    }
    if (owner?.cleanupFailed && owner.refs === 0) {
      await stop(owner)
      owner = undefined
    }
    if (owner && (!isPathUnderRoot(process.cwd, owner.workspace) || owner.authority !== authority))
      throw new Error(
        "Hermes active gateway workspace or policy differs; close its viewers before changing authority"
      )
    if (!owner) {
      owner = {
        workspace: normalizeFsPath(process.cwd),
        authority,
        root,
        key,
        home: `${root}/hermes`,
        env: {
          [AGENT_STATE_KEY_ENV]: key,
          HERMES_HOME: `${root}/hermes`,
          HERMES_TUI_GATEWAY_URL: "",
          HERMES_GATEWAY_NO_SUPERVISE: "1",
        },
        refs: 0,
        processIds: new Set(),
        exited: false,
        cleanupFailed: false,
        ready: Promise.resolve(),
      }
      owners.set(root, owner)
      const selected = owner
      owner.ready = start(owner, config).catch(async (error) => {
        try {
          await stop(selected)
        } catch {
          selected.cleanupFailed = true
        }
        throw error
      })
    }
    owner.refs++
    let viewer: BundledAgentBridgeLaunch
    try {
      await owner.ready
      await verifyOwnedPid(owner)
      viewer = await deps.resolveBridge("hermes-acp")
    } catch (error) {
      owner.refs--
      if (!owner.refs) await stop(owner).catch(() => undefined)
      throw error
    }
    const selected = owner
    let released = false
    const lease: Lease = {
      env: {
        ...owner.env,
        COGNIA_HERMES_ACP_BOOTSTRAP: JSON.stringify({
          executable: process.command,
          configKey: owner.key,
          ownedStateRoot: owner.root,
          expectedHome: owner.home,
          expectedPid: owner.pid,
          expectedStartupTime: owner.startedAt,
          profile: "default",
          ...owner.endpoint,
        }),
      },
      launch: { command: viewer.command, args: [...viewer.args] },
      release: async () => {
        if (!released) {
          released = true
          selected.refs--
        }
        if (!selected.refs) await stop(selected)
      },
    }
    return lease
  }
}

let defaultPrepare: Prepare | undefined
export function prepareHermesControlledDaemon(config: ExternalAgentConfig): ReturnType<Prepare> {
  defaultPrepare ??= createHermesControlledDaemonHost({
    processHost: createAgentTransportProcessHost("local"),
    ownsLocalProcesses: runsExternalAgentProcessesLocally,
    stateRootInfo: getExternalAgentStateRootInfo,
    processInfo: (id) => agentInvoke("get_external_agent_info", { agentId: id }),
    resolveBridge: resolveBundledAgentBridge,
    resolveEnvironment: buildAgentEnv,
  })
  return defaultPrepare(config)
}
