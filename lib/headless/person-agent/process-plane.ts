/**
 * The external-agent host a person brain installs (P6e, plan §9b.5).
 *
 * A member's agent runs in the Host's sandbox pool: gVisor, egress off, only
 * the member's personal workspace mounted at `/workspace`, and the org's model
 * access reaching it through the Host gateway. The Host owns every part of
 * that placement. The partition RPC allowlist (`personBrainCommands`) admits
 * only spawn, send, status and kill on this plane, so the shared ACP client
 * must not be told it has workspace files, terminals or MCP plumbing.
 *
 * This plane is the one place the shared client's calls are narrowed to that
 * contract:
 *
 * - **spawn** is admitted only for an agent the runner registered
 *   ({@link PersonProcessPlane.register}). The payload is rebuilt from scratch
 *   to the person contract: top-level `runtimeId`, the catalog command and
 *   args, only the brokered gateway env, and the adapter's stdout framing.
 *   No `cwd` (the Host forces the
 *   personal workspace), no `sandbox`/`sandboxPolicy` (the Host builds the
 *   placement), no `files`.
 * - **send / kill / status** pass through; the Host fences them to this
 *   partition's own runs.
 * - **check_command_exists** is answered here: the bundle ships exactly the
 *   registered runtime's command, and nothing else can be spawned.
 * - **every other command, files, terminals and hooks** are refused before any
 *   request leaves the process.
 *
 * The Host stamps `reason` on `state-change` and `exit` when it stops a run
 * itself (quota, lost org standing). The plane records it so the runner can
 * settle the turn with the Host's code instead of a generic exit.
 */

import type { AcpHostCapabilities } from "@cognia/agent-acp/feature-profile"
import type {
  InstalledExternalAgentHost,
  InstalledExternalAgentTerminalPlane,
} from "@/lib/ai/agent/external/host/installed-host"

/** The env keys a person spawn may carry (the Host allowlist, P6d). */
const SPAWN_ENV_KEYS = new Set([
  "COGNIA_GATEWAY_TOKEN",
  "COGNIA_GATEWAY_TASK_CONFIG",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
])

const PASS_THROUGH = new Set([
  "send_to_external_agent",
  "kill_external_agent",
  "get_external_agent_status",
])

/** The slice of the companion transport this plane uses. */
export interface PersonPlaneTransport {
  call<T>(command: string, args: Record<string, unknown>): Promise<T>
  subscribe<T>(event: string, handler: (payload: T) => void): () => void
  whenSubscribed?(channels: readonly string[]): Promise<void>
}

export interface PersonSpawnRegistration {
  runtimeId: string
  command: string
  args: readonly string[]
}

/** A call the person plane refuses, with the code the runner settles on. */
export class PersonPlaneRefusal extends Error {
  readonly code: string
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`)
    this.name = "PersonPlaneRefusal"
    this.code = code
  }
}

export interface PersonProcessPlane {
  readonly host: InstalledExternalAgentHost
  /** Admit exactly one spawn of `agentId`, as this runtime. */
  register(agentId: string, registration: PersonSpawnRegistration): void
  /** Forget an agent: its spawn is no longer admitted and its exit reason is dropped. */
  release(agentId: string): void
  /** The Host's stop reason for an agent, when the Host stopped it. */
  stopReason(agentId: string): string | undefined
  /** Notified when the Host reports a run stopped or exited. */
  onStopped(listener: (agentId: string, reason: string | undefined) => void): () => void
  /** Subscribe once to the Host's stop channels; resolves when they are live. */
  watchStops(): Promise<() => void>
}

/** What the shared ACP client may offer the agent: nothing beyond prompts. */
export const PERSON_ACP_HOST_CAPABILITIES: AcpHostCapabilities = Object.freeze({
  kind: "headless",
  fs: { read: false, write: false },
  terminal: false,
  terminalAuth: false,
  elicitation: { form: false, url: false, durableInteraction: false },
  preview: {
    compaction: true,
    notices: false,
    providers: false,
    dynamicMcp: false,
    nes: false,
    identifiedPlans: true,
    previewToolNames: true,
    sessionFork: false,
  },
}) as AcpHostCapabilities

function refuseFiles(): never {
  throw new PersonPlaneRefusal(
    "host_surface_forbidden",
    "a member agent's files stay inside its sandbox"
  )
}

function refuseTerminal(): never {
  throw new PersonPlaneRefusal(
    "host_surface_forbidden",
    "a member agent runs its own commands inside its sandbox"
  )
}

const terminals: InstalledExternalAgentTerminalPlane = {
  create: async () => refuseTerminal(),
  output: async () => refuseTerminal(),
  kill: async () => refuseTerminal(),
  release: async () => refuseTerminal(),
  waitForExit: async () => refuseTerminal(),
  write: async () => refuseTerminal(),
  sessionTerminals: async () => [],
  killSessionTerminals: async () => {},
  isRunning: async () => false,
  info: async () => refuseTerminal(),
  list: async () => [],
}

function spawnEnv(env: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!env || typeof env !== "object") return out
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value !== "string") continue
    if (SPAWN_ENV_KEYS.has(key)) out[key] = value
  }
  return out
}

export function createPersonProcessPlane(transport: PersonPlaneTransport): PersonProcessPlane {
  const registrations = new Map<string, PersonSpawnRegistration>()
  const spawned = new Set<string>()
  const reasons = new Map<string, string>()
  const stopListeners = new Set<(agentId: string, reason: string | undefined) => void>()

  const recordStop = (payload: unknown, exited: boolean) => {
    if (!payload || typeof payload !== "object") return
    const { agentId, reason } = payload as { agentId?: unknown; reason?: unknown }
    if (typeof agentId !== "string" || !registrations.has(agentId)) return
    if (typeof reason === "string" && reason) reasons.set(agentId, reason)
    if (exited || typeof reason === "string")
      for (const listener of stopListeners) listener(agentId, reasons.get(agentId))
  }

  const listenReady = async <T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<() => void> => {
    const off = transport.subscribe<T>(event, handler)
    try {
      // Every external-agent channel is off until subscribed; the first
      // spawn must not outrun its own output stream.
      await transport.whenSubscribed?.([event])
    } catch (error) {
      off()
      throw error
    }
    return off
  }

  const spawn = async (args: Record<string, unknown>): Promise<unknown> => {
    const config = (args.config ?? {}) as Record<string, unknown>
    const id = typeof config.id === "string" ? config.id : ""
    const registration = registrations.get(id)
    if (!registration || spawned.has(id))
      throw new PersonPlaneRefusal("host_surface_forbidden", "this agent was not prepared to run")
    if (config.command !== registration.command)
      throw new PersonPlaneRefusal("org_agent_not_allowed", "the launch is not the bundled runtime")
    spawned.add(id)
    return transport.call("spawn_external_agent", {
      runtimeId: registration.runtimeId,
      config: {
        id,
        command: registration.command,
        args: [...registration.args],
        env: spawnEnv(config.env),
        // How the adapter reads stdout (Pi's raw RPC stream); not placement.
        ...(config.framing === "line" || config.framing === "raw"
          ? { framing: config.framing }
          : {}),
      },
    })
  }

  const host: InstalledExternalAgentHost = {
    kind: "person-brain",
    process: {
      supportsExternalAgents: () => true,
      runsExternalAgentProcessesLocally: () => true,
      supportsAgentFs: () => false,
      supportsAgentTerminal: () => false,
      getAcpHostCapabilities: () => PERSON_ACP_HOST_CAPABILITIES,
      invoke: async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
        if (name === "spawn_external_agent") return (await spawn(args)) as T
        if (name === "check_command_exists") {
          const command = args.command
          return [...registrations.values()].some(
            (registration) => registration.command === command
          ) as T
        }
        if (PASS_THROUGH.has(name)) return transport.call<T>(name, args)
        throw new PersonPlaneRefusal("host_surface_forbidden", `${name} is not a member agent call`)
      },
      listen: async <T>(event: string, handler: (payload: T) => void) => {
        return listenReady(event, handler)
      },
      readTextFile: async () => refuseFiles(),
      writeTextFile: async () => refuseFiles(),
      deleteTextFile: async () => refuseFiles(),
      readBinaryFile: async () => refuseFiles(),
      writeBinaryFile: async () => refuseFiles(),
      listFiles: async () => refuseFiles(),
    },
    terminals,
    hooks: { run: async () => null, pluginHooks: null },
  }

  return {
    host,
    register(agentId, registration) {
      registrations.set(agentId, { ...registration, args: [...registration.args] })
    },
    release(agentId) {
      registrations.delete(agentId)
      spawned.delete(agentId)
      reasons.delete(agentId)
    },
    stopReason: (agentId) => reasons.get(agentId),
    onStopped(listener) {
      stopListeners.add(listener)
      return () => stopListeners.delete(listener)
    },
    async watchStops() {
      const offs = await Promise.all([
        listenReady<unknown>("external-agent://state-change", (payload) =>
          recordStop(payload, false)
        ),
        listenReady<unknown>("external-agent://exit", (payload) => recordStop(payload, true)),
      ])
      return () => {
        for (const off of offs) off()
      }
    },
  }
}
