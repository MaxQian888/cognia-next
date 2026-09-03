/**
 * Pi native RPC adapter (`pi --mode rpc`) — ADR-0119.
 *
 * Replaced the community `pi-acp` bridge (since removed) with a direct client for Pi's own
 * protocol, so thinking levels, the steering/follow-up queues, the compaction
 * lifecycle, session forks and usage detail survive instead of being flattened
 * onto ACP's smaller vocabulary.
 *
 * Structural choices worth knowing before editing:
 *
 * - **Host access goes through `./agent-transport`**, like `acp-client.ts` and
 *   unlike `codex-app-server-client.ts` (which imports the Tauri-only native
 *   module directly and only works in the CLI thanks to a tsconfig alias).
 *   That keeps this adapter working on desktop, headless and CLI alike. The
 *   host is injectable so tests need no Tauri at all.
 * - **One Pi process per Cognia session.** Pi *can* switch sessions inside one
 *   process, but sharing a process would interleave two conversations' events
 *   and permission answers on one stream. Isolation is worth the memory.
 * - **Framing is raw.** The shared line-framing host splits on U+2028, which
 *   corrupts valid Pi frames, so this adapter opts into `framing: "raw"` and
 *   frames the bytes itself (see `pi-rpc-peer.ts`).
 */

import type { ExternalAgentCompactionCapability } from "./session-capabilities"
import type {
  AcpConfigOption,
  AcpElicitationResponse,
  AcpPermissionResponse,
  AcpSessionModelState,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentExecutionOptions,
  ExternalAgentMessage,
  ExternalAgentSession,
  ExternalAgentTokenUsage,
} from "@/types/agent/external-agent"

import { hasNoLeakingPiiDeep } from "@cognia/redact"

import { agentInvoke, agentListen } from "./agent-transport"
import {
  buildPiAuthCheckArgs,
  classifyPiAuthProbe,
  parsePiModelProviders,
  type PiAuthVerdict,
  type PiProviderListing,
} from "./pi-auth"
import { parsePiModelListing, type PiModelListing } from "./pi-auth"
import { mapPiEvent, piStatsToTokenUsage, type PiEvent, type PiSessionStats } from "./pi-rpc-events"
import { hasNoLeakingExternalAgentPromptInput } from "./outbound-prompt-pii"
import { PI_TOOL_POLICY_ENV, encodePiToolPolicy, resolvePiToolPolicy } from "./pi-permission"
import { PiRpcPeer, type PiFrameError } from "./pi-rpc-peer"
import {
  BaseProtocolAdapter,
  type SessionCreateOptions,
  type SessionListOptions,
} from "./protocol-adapter"

// ============================================================================
// Version policy
// ============================================================================

/** The one version this integration is certified against (ADR-0119). */
export const PI_CERTIFIED_VERSION = "0.84.3"

export type PiVersionVerdict =
  /** Exactly the certified version. */
  | { status: "certified"; version: string }
  /**
   * Newer than certified. Allowed to run so a Pi upgrade degrades to a
   * warning rather than an outage, but reported so the user knows why an
   * unexpected behaviour is not necessarily a Cognia bug.
   */
  | { status: "unverified"; version: string }
  /** Older than certified, or unparseable. Refused. */
  | { status: "unsupported"; version: string | null; reason: string }

/** Compare dotted numeric versions. Non-numeric suffixes sort before release. */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split(".").map((part) => Number.parseInt(part, 10))
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (Number.isNaN(l) || Number.isNaN(r)) return Number.NaN
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/**
 * Classify a `pi --version` string.
 *
 * A version below the floor is refused rather than warned about, because the
 * failure it produces otherwise is a silent protocol mismatch — Pi renamed
 * fields between minor releases, and a missing field reads as an empty turn.
 */
export function classifyPiVersion(raw: string | null | undefined): PiVersionVerdict {
  const version = raw?.trim().replace(/^v/, "")
  if (!version) {
    return { status: "unsupported", version: null, reason: "no_version_reported" }
  }
  if (!/^\d+(\.\d+)*/.test(version)) {
    return { status: "unsupported", version, reason: "unparseable_version" }
  }
  const delta = compareVersions(version, PI_CERTIFIED_VERSION)
  if (Number.isNaN(delta)) {
    return { status: "unsupported", version, reason: "unparseable_version" }
  }
  if (delta === 0) return { status: "certified", version }
  if (delta > 0) return { status: "unverified", version }
  return { status: "unsupported", version, reason: "below_certified_version" }
}

// ============================================================================
// Thinking levels
// ============================================================================

/** Pi's ordered thinking levels; the per-model subset comes from the runtime. */
export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number]

/**
 * Pick the closest supported thinking level.
 *
 * Pi accepts an unsupported level, answers `success: true`, and silently
 * clamps to `off` — verified against 0.84.1. Sending an unvalidated level
 * therefore turns "think hard" into "don't think" with no error anywhere, so
 * the clamp has to happen here.
 */
export function clampThinkingLevel(
  requested: string,
  available: readonly string[]
): string | undefined {
  if (available.length === 0) return undefined
  if (available.includes(requested)) return requested

  const wanted = PI_THINKING_LEVELS.indexOf(requested as PiThinkingLevel)
  if (wanted < 0) return undefined

  // Step down to the nearest supported level rather than up: silently
  // spending more reasoning budget than asked for is worse than less.
  const ordered = PI_THINKING_LEVELS.filter((level) => available.includes(level))
  if (ordered.length === 0) return undefined
  let best = ordered[0]
  for (const level of ordered) {
    if (PI_THINKING_LEVELS.indexOf(level) <= wanted) best = level
  }
  return best
}

/** Split Pi's `provider/modelId` form; a bare id keeps the active provider. */
export function parsePiModel(model: string): { provider?: string; modelId: string } {
  const slash = model.indexOf("/")
  if (slash <= 0) return { modelId: model }
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }
}

// ============================================================================
// Extension isolation
// ============================================================================

export type PiExtensionPolicy = "isolated" | "global" | "trusted-project"

/**
 * Flags that make `extensionPolicy` mean what it says.
 *
 * `--no-extensions` alone is NOT isolation: verified against 0.84.1, skills
 * under `~/.agents/skills/` and Pi's built-in inline extensions still load.
 * Context files (`AGENTS.md` / `CLAUDE.md`) are deliberately left enabled —
 * they are data, not executable code, and they materially improve results.
 */
export function extensionPolicyArgs(policy: PiExtensionPolicy): string[] {
  switch (policy) {
    case "isolated":
      return ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-approve"]
    case "global":
      // User extensions load; project-local ones stay untrusted.
      return ["--no-approve"]
    case "trusted-project":
      // Explicitly trusts project-local files, which can execute arbitrary
      // code. The UI must say so before offering this.
      return ["--approve"]
  }
}

const PI_READ_ONLY_FLOOR = ["read", "grep", "find", "ls"]
const PI_BUILTIN_TOOL_NAMES = new Set([...PI_READ_ONLY_FLOOR, "edit", "write", "bash"])

/**
 * Tools Pi may keep loaded, per permission mode. Empty means "no restriction".
 *
 * `interceptionAvailable` is load-bearing, not a hint. Pi ships NO permission
 * prompts of its own — its tools run with the full rights of the process — so
 * the modes that are defined by asking (`default`, `acceptEdits`) only mean
 * anything while the bundled extension is intercepting `tool_call`. Without it
 * they would silently permit `edit` / `write` / `bash`, which is the exact
 * silent bypass this layer exists to prevent.
 *
 * So when interception is unavailable those modes collapse to the read-only
 * floor: unable to ask, Cognia refuses rather than assumes consent.
 * `bypassPermissions` is untouched — the user explicitly opted out of prompts,
 * and the strict sandbox still contains the process — and `plan` / `dontAsk`
 * never needed to ask in the first place.
 */
export function processToolFloor(
  permissionMode: string | undefined,
  allowedTools: readonly string[] | undefined,
  options: { interceptionAvailable?: boolean } = {}
): string[] {
  const intercepted = options.interceptionAvailable ?? true

  if (permissionMode === "plan") return [...PI_READ_ONLY_FLOOR]
  if (permissionMode === "dontAsk") {
    return (allowedTools ?? []).filter((tool) => PI_BUILTIN_TOOL_NAMES.has(tool))
  }
  if (permissionMode === "bypassPermissions") return []
  // `default` / `acceptEdits` / anything unrecognised.
  return intercepted ? [] : [...PI_READ_ONLY_FLOOR]
}

// ============================================================================
// Adapter
// ============================================================================

/** Host seam, injectable so tests need no Tauri/companion transport. */
export interface PiRpcHost {
  invoke<T>(name: string, args: Record<string, unknown>): Promise<T>
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>
}

const defaultHost: PiRpcHost = { invoke: agentInvoke, listen: agentListen }

/**
 * The host's answer to "is the bundled Pi extension the one Cognia shipped?".
 *
 * One contract, two implementations that cannot be shared: the CLI's
 * `verifyPiExtension` (Node, filesystem) and the desktop's
 * `pi_extension::resolve_pi_extension` (Rust, Tauri resource dir). The adapter
 * itself runs in the renderer under static export and has no filesystem, so it
 * asks rather than looks.
 */
export type PiExtensionVerdict =
  | { status: "ok"; path: string; sha256: string }
  | { status: "missing" }
  | { status: "unreadable"; path: string; detail: string }
  | { status: "tampered"; path: string; expected: string; actual: string }
  | { status: "unpinned"; path: string; sha256: string }

/**
 * One Pi session as the host found it on disk (`list_pi_sessions`).
 *
 * The adapter cannot read `~/.pi/agent/sessions/` itself — it runs in the
 * renderer under static export — and Pi's RPC has no listing command
 * (`switch_session` takes a path it expects you to already know). So the host
 * reads each file's header line, the way Pi's own `SessionManager.list` does,
 * and answers with ids only: the id is what `--session-id` needs to resume,
 * and no absolute path has to cross a device boundary.
 */
export interface PiSessionRecord {
  id: string
  cwd?: string
  name?: string
  createdAt?: string
  updatedAt?: string
}

/** Why a verdict refuses the session, phrased for the user. */
export function piExtensionVerdictReason(verdict: PiExtensionVerdict): string {
  switch (verdict.status) {
    case "ok":
      return ""
    case "missing":
      return "The bundled Cognia Pi extension was not found. Reinstall Cognia — without it Pi's native tools would run unintercepted."
    case "unreadable":
      return `The bundled Cognia Pi extension at ${verdict.path} could not be read: ${verdict.detail}`
    case "tampered":
      return `The bundled Cognia Pi extension at ${verdict.path} does not match its pinned digest. Reinstall Cognia.`
    case "unpinned":
      return `The bundled Cognia Pi extension at ${verdict.path} has no integrity manifest, so it cannot be verified. Reinstall Cognia.`
  }
}

/** Concurrent Pi processes per host before `resource_limit`. */
export const PI_MAX_CONCURRENT_PROCESSES = 4

export interface PiRpcAdapterOptions {
  host?: PiRpcHost
  maxProcesses?: number
  /** Overrides the session-id generator so tests get deterministic ids. */
  generateSessionId?: () => string
}

interface PiProcess {
  /** Host-level process id (what `spawn_external_agent` was given). */
  agentId: string
  /** Pi's own session id — the value passed to `--session-id`. */
  piSessionId: string
  peer: PiRpcPeer
  cwd?: string
  unlisten: Array<() => void>
  /**
   * Which stdout framing this host turned out to speak. Latches to `"raw"` on
   * the first `stdout-raw` frame; see the listener wiring in `startSession`.
   */
  framing: "unknown" | "raw" | "line"
  /** Consumers waiting on `prompt()`. */
  queues: Set<EventQueue>
  busy: boolean
  lastUsedAt: number
  exited: boolean
  /** Resolves when the bundled extension reports itself ready. */
  handshake: Promise<void>
  settleHandshake?: () => void
  /**
   * Events that arrived while a `done` was being held for its usage query.
   *
   * `done` is the terminal event a consumer returns on, so anything dispatched
   * during that round-trip must not overtake it — it would reach the iterator
   * after the caller has already stopped reading, or ahead of the terminal
   * event it precedes. Buffered here and flushed straight after `done`.
   */
  deferredWhileSettling?: ExternalAgentEvent[]
}

/**
 * Bridges callback-delivered events onto an async iterator, with backpressure
 * handled by buffering rather than dropping — losing a `done` would hang the
 * consumer forever.
 */
class EventQueue {
  private readonly buffer: ExternalAgentEvent[] = []
  private resolve?: (value: IteratorResult<ExternalAgentEvent>) => void
  private ended = false
  private failure?: Error

  push(event: ExternalAgentEvent): void {
    if (this.ended) return
    if (this.resolve) {
      const resolve = this.resolve
      this.resolve = undefined
      resolve({ value: event, done: false })
      return
    }
    this.buffer.push(event)
  }

  end(error?: Error): void {
    if (this.ended) return
    this.ended = true
    this.failure = error
    if (this.resolve) {
      const resolve = this.resolve
      this.resolve = undefined
      resolve({ value: undefined as never, done: true })
    }
  }

  async *drain(): AsyncGenerator<ExternalAgentEvent> {
    for (;;) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!
        continue
      }
      if (this.ended) {
        if (this.failure) throw this.failure
        return
      }
      const next = await new Promise<IteratorResult<ExternalAgentEvent>>((resolve) => {
        this.resolve = resolve
      })
      if (next.done) {
        if (this.failure) throw this.failure
        return
      }
      yield next.value
    }
  }
}

export class PiRpcClientAdapter extends BaseProtocolAdapter {
  readonly protocol = "pi-rpc"

  private readonly host: PiRpcHost
  private readonly maxProcesses: number
  private readonly newSessionId: () => string
  private readonly processes = new Map<string, PiProcess>()

  private versionVerdict?: PiVersionVerdict
  private extensionVerdict?: PiExtensionVerdict
  /**
   * Open Pi dialogs, by request id. The session routes the answer back (the
   * canonical `respondToElicitation` carries only a request id); the method
   * decides which of Pi's three mutually exclusive response shapes to use.
   */
  private readonly pendingDialogs = new Map<string, { sessionId: string; method?: string }>()

  constructor(options: PiRpcAdapterOptions = {}) {
    super()
    this.host = options.host ?? defaultHost
    this.maxProcesses = options.maxProcesses ?? PI_MAX_CONCURRENT_PROCESSES
    this.newSessionId =
      options.generateSessionId ??
      (() =>
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `pi-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  }

  /** The version verdict from the last `connect()`, for diagnostics/UI. */
  get versionStatus(): PiVersionVerdict | undefined {
    return this.versionVerdict
  }

  // --------------------------------------------------------------- lifecycle

  async connect(config: ExternalAgentConfig): Promise<void> {
    this._config = config
    this._connectionStatus = "connecting"
    try {
      const verdict = await this.probeVersion(config)
      this.versionVerdict = verdict
      if (verdict.status === "unsupported") {
        this._connectionStatus = "error"
        throw new PiVersionError(verdict)
      }
      // Ask the host to resolve + hash the bundled extension once per
      // connection rather than per session: the answer is a property of the
      // installation, and re-hashing on every session start would put a
      // filesystem read on the session-open path for no new information.
      //
      // A host that does not implement the command (an older CLI, a stub in a
      // test) leaves the verdict undefined; `assertExtensionReady` then falls
      // back to whatever a host-side resolver already put on the config, and
      // refuses if there is nothing.
      this.extensionVerdict = await this.resolveExtension()
      this._connectionStatus = "connected"
    } catch (error) {
      this._connectionStatus = "error"
      throw error
    }
  }

  private async resolveExtension(): Promise<PiExtensionVerdict | undefined> {
    try {
      return await this.host.invoke<PiExtensionVerdict>("resolve_pi_extension", {})
    } catch {
      return undefined
    }
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.processes.keys()].map((id) => this.closeSession(id)))
    this._connectionStatus = "disconnected"
  }

  /**
   * Run `pi --version` through the same sandboxed spawn path as a session.
   *
   * Deliberately not inferred from an RPC handshake: `get_state` reports the
   * session-format version, not the Pi release, and a mismatched binary must
   * be caught before it can start a session.
   */
  private async probeVersion(config: ExternalAgentConfig): Promise<PiVersionVerdict> {
    const { stdout } = await this.runCliProbe(config, ["--version"], "version", 15000)
    return classifyPiVersion(stdout.trim().split("\n").filter(Boolean).pop() ?? null)
  }

  /**
   * Run a short-lived, non-RPC `pi` invocation through the same sandboxed spawn
   * path a session uses, and return what it printed.
   *
   * Shared by the version probe and the credential diagnostic. Both need the
   * identical thing — spawn, collect stdout, wait for exit, always unsubscribe —
   * and the version probe's original inline copy leaked its exit listener: it
   * pushed the unsubscribe onto a shared array from inside a `.then()`, so a
   * probe that finished first ran its cleanup against an empty array and left
   * the listener attached for the life of the adapter. Awaiting the listen
   * handle in `finally` closes that without moving the spawn.
   *
   * `stderr` is deliberately not captured. Pi writes prose there on its error
   * paths, and the only consumer of this output classifies stdout; forwarding
   * stderr would create the one path on which CLI text could reach a log.
   */
  private async runCliProbe(
    config: ExternalAgentConfig,
    args: string[],
    label: string,
    timeoutMs: number
  ): Promise<{ stdout: string; exitCode: number | null }> {
    const command = config.process?.command ?? "pi"
    const probeId = `${config.id}:${label}-probe:${Date.now()}`
    let stdout = ""
    let exitCode: number | null = null

    const offStdout = await this.host.listen<{ agentId: string; data: string }>(
      "external-agent://stdout",
      (payload) => {
        if (payload.agentId === probeId) stdout += `${payload.data}\n`
      }
    )
    let resolveExit: () => void = () => {}
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    // Started but deliberately NOT awaited before the spawn. The `stdout`
    // subscription above is the one that has to be live first, and awaiting it
    // now also waits for the host to acknowledge the channel, which leaves the
    // socket open: this `add` frame goes out on an open socket and is processed
    // long before a spawned process can exit. Awaiting it as well would push
    // the spawn another turn down the microtask queue, which is timing the
    // adapter's callers are entitled not to have shift under them.
    const exitHandle = this.host.listen<{ agentId: string; code?: number | null }>(
      "external-agent://exit",
      (payload) => {
        if (payload.agentId !== probeId) return
        exitCode = payload.code ?? null
        resolveExit()
      }
    )

    try {
      await this.host.invoke("spawn_external_agent", {
        config: { id: probeId, command, args, cwd: config.process?.cwd },
      })
      await Promise.race([exited, delay(timeoutMs)])
      return { stdout, exitCode }
    } finally {
      offStdout()
      // Await the handle rather than reading it out of a shared array. The
      // original pushed the unsubscribe from inside a `.then()`, so a probe
      // that finished first ran its cleanup against an empty array and left the
      // listener attached for the life of the adapter.
      await exitHandle.then((off) => off()).catch(() => {})
    }
  }

  // ---------------------------------------------------------------- sessions

  async createSession(options: SessionCreateOptions = {}): Promise<ExternalAgentSession> {
    return this.startSession(this.newSessionId(), options)
  }

  /**
   * Resume by re-launching with the same `--session-id`.
   *
   * Pi treats that flag as "use this exact id, creating it if missing", so the
   * persisted link needs nothing but the id — no absolute session-file path
   * ever has to cross a device boundary.
   */
  async resumeSession(sessionId: string): Promise<ExternalAgentSession> {
    const existing = this.processes.get(sessionId)
    if (existing && !existing.exited) return this.requireSession(sessionId)
    return this.startSession(sessionId, this.lastCreateOptions ?? {})
  }

  /** Branch an existing Pi session into a fresh one via `--fork`. */
  async forkSession(sessionId: string): Promise<ExternalAgentSession> {
    const source = this.processes.get(sessionId)
    const sourcePiId = source?.piSessionId ?? sessionId
    return this.startSession(this.newSessionId(), this.lastCreateOptions ?? {}, {
      forkFrom: sourcePiId,
    })
  }

  private lastCreateOptions?: SessionCreateOptions

  private async startSession(
    piSessionId: string,
    options: SessionCreateOptions,
    extra: { forkFrom?: string } = {}
  ): Promise<ExternalAgentSession> {
    if (!this._config) throw new Error("Pi adapter is not connected")
    // Checked per session rather than at connect: an operator flipping the
    // switch should stop the next session, not require a restart.
    if (isPiRpcDisabled()) throw new PiDisabledError()
    this.lastCreateOptions = options

    // Refuse before anything is spawned or reclaimed. A session that cannot
    // intercept Pi's native tools must not reach the point of having a process.
    const extension = this.assertExtensionReady()

    await this.reclaimCapacity()

    // Gate BEFORE the value can reach the process env — once it is in the
    // spawn config it has already crossed the boundary. Mirrors
    // `cli/src/agent/external-agent-session.ts`.
    const systemPrompt = buildPiSystemPrompt(options)

    const agentId = `${this._config.id}:${piSessionId}`
    const args = this.buildArgs(piSessionId, options, extra, extension)

    const peer = new PiRpcPeer({
      writeRaw: (frame) =>
        this.host
          .invoke("send_to_external_agent", { agentId, message: frame })
          .then(() => undefined),
      onEvent: (event) => this.dispatchEvent(piSessionId, event as PiEvent),
      onOrphanResponse: (response) => {
        // Pi rejecting our own input. Never fails a pending command (it has
        // no id), but it means a frame we wrote was malformed.
        if (response.command === "parse") {
          this.dispatchError(
            piSessionId,
            `Pi rejected a malformed command: ${response.error ?? ""}`
          )
        }
      },
      onProtocolError: (error: PiFrameError) => {
        this.dispatchError(piSessionId, error.message)
        void this.closeSession(piSessionId)
      },
    })

    const record: PiProcess = {
      agentId,
      piSessionId,
      peer,
      cwd: options.cwd,
      unlisten: [],
      framing: "unknown",
      queues: new Set(),
      busy: false,
      lastUsedAt: Date.now(),
      exited: false,
      handshake: Promise.resolve(),
    }
    record.handshake = new Promise<void>((resolve) => {
      record.settleHandshake = resolve
    })
    this.processes.set(piSessionId, record)

    // Two hosts, two framings, one codec.
    //
    // The Node/CLI backend honours `framing: "raw"` and emits base64 chunks on
    // `stdout-raw`. The Rust host (desktop and headless) reads with
    // `BufReader::lines()` and emits `\n`-stripped lines on `stdout`; its
    // `ExternalAgentSpawnConfig` has no `framing` field, so the flag below is
    // simply ignored there. Subscribing to only `stdout-raw` is why the desktop
    // received nothing at all: the process started, the version probe (which
    // listens on `stdout`) succeeded, and then every frame fell on the floor.
    //
    // The two are mutually exclusive per host today. The latch makes that a
    // property of the data rather than an assumption: once a raw frame arrives,
    // line events for this session are ignored, so a host that later emitted
    // both cannot double-feed the decoder.
    record.unlisten.push(
      await this.host.listen<{ agentId: string; data: string }>(
        "external-agent://stdout-raw",
        (payload) => {
          if (payload.agentId !== agentId) return
          record.framing = "raw"
          peer.ingest(base64ToBytes(payload.data))
        }
      )
    )
    record.unlisten.push(
      await this.host.listen<{ agentId: string; data: string }>(
        "external-agent://stdout",
        (payload) => {
          if (payload.agentId !== agentId) return
          if (record.framing === "raw") return
          record.framing = "line"
          // Re-append exactly the one byte the line reader stripped, so the
          // strict LF codec sees the frame Pi actually wrote. Safe because the
          // Rust reader splits on the `\n` BYTE only: U+2028/U+2029 do not
          // split there (that is a Node `readline` defect, ADR-0119), and a raw
          // `\r` cannot occur inside a Pi frame because `JSON.stringify`
          // escapes it as `\\r`.
          peer.ingest(textToBytes(`${payload.data}\n`))
        }
      )
    )
    record.unlisten.push(
      await this.host.listen<{ agentId: string; code: number }>(
        "external-agent://exit",
        (payload) => {
          if (payload.agentId !== agentId) return
          record.exited = true
          peer.endOfStream()
          peer.rejectAll(`Pi process exited (code ${payload.code})`)
          this.dispatchError(piSessionId, `Pi process exited with code ${payload.code}`)
          this.finishQueues(record)
        }
      )
    )

    await this.host.invoke("spawn_external_agent", {
      config: {
        id: agentId,
        command: this._config.process?.command ?? "pi",
        args,
        cwd: options.cwd,
        env: {
          ...this._config.process?.env,
          // The extension owns no policy: it applies this table. Computing it
          // here keeps the matrix in tested app code (`pi-permission.ts`).
          [PI_TOOL_POLICY_ENV]: encodePiToolPolicy(
            resolvePiToolPolicy(options.permissionMode, options.allowedTools)
          ),
          ...(systemPrompt ? { [PI_SYSTEM_PROMPT_ENV]: systemPrompt } : {}),
        },
        // The whole reason this adapter exists on a separate framing path.
        framing: "raw",
      },
    })

    // Unconditional: `assertExtensionReady` above already refused the session
    // if no verified extension exists, so reaching here means one was loaded
    // and must prove it. The budget follows the policy, because `session_start`
    // waits for every OTHER loaded extension too and only `isolated` bounds
    // that set.
    const settled = await Promise.race([
      record.handshake.then(() => true),
      delay(piHandshakeTimeoutMs(this.extensionPolicy())).then(() => false),
    ])
    if (!settled) {
      await this.closeSession(piSessionId)
      throw new PiExtensionHandshakeError(piSessionId, this.extensionPolicy())
    }

    const session: ExternalAgentSession = {
      id: piSessionId,
      agentId: this._config.id,
      status: "active",
      permissionMode: options.permissionMode,
      allowedTools: options.allowedTools,
      context: options.context as ExternalAgentSession["context"],
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {
        piSessionId,
        piVersion: this.versionVerdict?.version,
        piVersionStatus: this.versionVerdict?.status,
        cwd: options.cwd,
        forkedFrom: extra.forkFrom,
      },
    }
    this._sessions.set(piSessionId, session)
    return session
  }

  private buildArgs(
    piSessionId: string,
    options: SessionCreateOptions,
    extra: { forkFrom?: string },
    extension: string
  ): string[] {
    const configured = this._config?.process?.args ?? ["--mode", "rpc"]
    const args = [...configured]
    if (!args.includes("--mode")) args.push("--mode", "rpc")

    if (extra.forkFrom) args.push("--fork", extra.forkFrom)
    args.push("--session-id", piSessionId)

    args.push(...extensionPolicyArgs(this.extensionPolicy()))

    // `assertExtensionReady` guarantees interception is available by the time
    // we get here, so this is now always the "intercepted" floor. The
    // `interceptionAvailable: false` branch stays reachable and tested as
    // defence in depth — it is the process-level floor that would carry the
    // whole restriction if that guarantee were ever weakened.
    const floor = processToolFloor(options.permissionMode, options.allowedTools, {
      interceptionAvailable: true,
    })
    if (floor.length > 0) args.push("--tools", floor.join(","))

    // `-e` still loads under `--no-extensions`, which is exactly what makes
    // isolation workable: the user's stack stays off while Cognia's own
    // interception stays on.
    args.push("-e", extension)

    return args
  }

  /**
   * Absolute path of the bundled Cognia Pi extension, if one has been verified.
   *
   * Two sources, in order: the path a host resolver already verified and stored
   * on the config (the CLI does this in `external-agent-session.ts`), or the
   * verdict this adapter fetched from its host in `connect()`.
   *
   * Note there is no `process.env.COGNIA_PI_EXTENSION_PATH` fallback any more.
   * Reading it here bypassed the digest check entirely: an env var could point
   * the session at any file and that file would then be the thing enforcing
   * Pi's permission matrix. The override still exists for development, but it
   * is honoured by the *resolver* (which then hashes what it found), not here.
   */
  /**
   * Which extensions Pi loads alongside ours.
   *
   * Read in two places that must agree: the argv builder, which turns it into
   * Pi's isolation flags, and the handshake budget, which has to allow for
   * whatever those flags let start first.
   */
  private extensionPolicy(): PiExtensionPolicy {
    return (
      (this._config?.metadata?.piExtensionPolicy as PiExtensionPolicy | undefined) ?? "isolated"
    )
  }

  private extensionPath(): string | undefined {
    const configured = this._config?.metadata?.piExtensionPath as string | undefined
    if (configured) return configured
    return this.extensionVerdict?.status === "ok" ? this.extensionVerdict.path : undefined
  }

  /**
   * Refuse the session unless a verified extension is available.
   *
   * This is `PI_EXTENSION_REQUIRED`: the constant the old comment promised and
   * the code never had. Previously `startSession` guarded the handshake with
   * `if (this.extensionPath())`, so the *absence* of an extension skipped the
   * gate rather than tripping it — the one case that matters most, because Pi
   * ships no permission prompts of its own and its native `edit`/`write`/`bash`
   * tools run with the full rights of the process when nothing intercepts them.
   */
  private assertExtensionReady(): string {
    const path = this.extensionPath()
    if (path) return path
    throw new PiExtensionUnavailableError(
      this.extensionVerdict
        ? piExtensionVerdictReason(this.extensionVerdict)
        : "The Cognia Pi extension has not been verified on this host"
    )
  }

  /**
   * Make room for another process, closing the least-recently-used idle one.
   * A host where every process is mid-turn reports `resource_limit` instead of
   * killing someone else's live work.
   */
  private async reclaimCapacity(): Promise<void> {
    if (this.processes.size < this.maxProcesses) return
    const idle = [...this.processes.values()]
      .filter((record) => !record.busy)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    if (idle.length === 0) {
      throw new PiResourceLimitError(this.maxProcesses)
    }
    await this.closeSession(idle[0].piSessionId)
  }

  async closeSession(sessionId: string): Promise<void> {
    const record = this.processes.get(sessionId)
    if (!record) return
    this.processes.delete(sessionId)
    this._sessions.delete(sessionId)
    // Before the abort: a dialog left open holds the extension, and the
    // extension holding is what would keep Pi from exiting cleanly.
    this.cancelPendingDialogs(sessionId, record)

    if (!record.exited) {
      // Ask Pi to stop cleanly first; a hard kill mid-tool-call can leave a
      // half-written file behind.
      try {
        await Promise.race([record.peer.sendCommand("abort", {}, 5000), delay(5000)])
      } catch {
        // Already gone, or refused — the kill below is the real guarantee.
      }
    }
    record.peer.close("Session closed")
    for (const off of record.unlisten.splice(0)) off()
    this.finishQueues(record)

    if (!record.exited) {
      try {
        await this.host.invoke("kill_external_agent", { agentId: record.agentId })
      } catch {
        // The process may have exited between the abort and the kill.
      }
    }
  }

  // ------------------------------------------------------------------ prompt

  async *prompt(
    sessionId: string,
    message: ExternalAgentMessage,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    const record = this.requireProcess(sessionId)
    if (record.busy) {
      throw new Error(`Pi session ${sessionId} already has a turn in flight`)
    }

    if (!hasNoLeakingExternalAgentPromptInput(message, { sessionId })) {
      throw new PiOutboundBlockedError()
    }
    const prompt = messageToPiPrompt(message)

    const queue = new EventQueue()
    record.queues.add(queue)
    record.busy = true
    record.lastUsedAt = Date.now()

    try {
      // The response only means Pi ACCEPTED the prompt. Completion is
      // `agent_settled`, which arrives later on the event stream.
      await record.peer.sendCommand("prompt", prompt, options?.timeout ?? 60000)
    } catch (error) {
      record.busy = false
      record.queues.delete(queue)
      throw error
    }

    try {
      for await (const event of queue.drain()) {
        yield event
        if (event.type === "done") return
      }
    } finally {
      record.busy = false
      record.queues.delete(queue)
      record.lastUsedAt = Date.now()
    }
  }

  private dispatchEvent(sessionId: string, event: PiEvent): void {
    const record = this.processes.get(sessionId)
    if (!record) return

    if (isCogniaHandshake(event)) {
      record.settleHandshake?.()
    }
    const mapped = mapPiEvent(event, { sessionId })
    for (const canonical of mapped) {
      // A Pi dialog BLOCKS its extension until answered. Remember which session
      // owns each open request so `respondToElicitation` — which the canonical
      // contract calls with only a `requestId` — can route the answer back, and
      // so closing the session can cancel whatever is still open instead of
      // leaving the extension parked forever.
      if (canonical.type === "elicitation_request") {
        this.pendingDialogs.set(canonical.request.id, {
          sessionId,
          method: asDialogMethod(canonical.request.raw),
        })
      }
      // A native-tool approval is the same blocking Pi dialog, just routed to
      // the approval UI instead of a form. It has to be registered too, or
      // `respondToPermission` cannot resolve which session owns it and closing
      // the session leaves the extension parked.
      if (canonical.type === "permission_request") {
        this.pendingDialogs.set(canonical.request.id, { sessionId, method: "confirm" })
      }
      if (canonical.type === "done") {
        // `get_session_stats` is a round-trip, so it is only paid for once a
        // turn actually finishes — but it has to finish BEFORE `done` reaches
        // the consumer. `prompt()` returns on `done`, and `execute()` reads
        // `tokenUsage` off that event, so firing the query afterwards meant the
        // usage landed on a session object nobody was still reading: every Pi
        // turn reported zero tokens and zero cost.
        if (record.deferredWhileSettling) {
          // A settle is already in flight. This terminal event waits its turn
          // like anything else and is settled in order when the buffer drains —
          // starting a second settle here would race the first, and whichever
          // finished sooner would clear the buffer for both, letting later
          // events overtake a `done` still in flight.
          record.deferredWhileSettling.push(canonical)
          continue
        }
        record.deferredWhileSettling = []
        void this.emitSettledWithUsage(sessionId, record, canonical)
        continue
      }
      // While a `done` is held, everything behind it waits too — see
      // `deferredWhileSettling`.
      if (record.deferredWhileSettling) {
        record.deferredWhileSettling.push(canonical)
        continue
      }
      for (const queue of record.queues) queue.push(canonical)
    }
  }

  /**
   * Attach the turn's usage to `done`, then release it.
   *
   * A failed stats query must not strand the turn: the `done` is pushed either
   * way, just without usage. Usage is reporting; the turn already succeeded.
   *
   * The record is passed in rather than re-read after the await, and the queues
   * are read off it directly: a session torn down mid-round-trip (a close, a
   * process exit) removes it from `this.processes`, and looking it up again
   * there would drop the terminal event on the floor — leaving every consumer's
   * `for await` waiting forever on a `done` that had already been produced.
   * Delivering into the queues the turn was streaming to is always correct;
   * a queue nobody is reading is simply garbage-collected with its consumer.
   */
  private async emitSettledWithUsage(
    sessionId: string,
    record: PiProcess,
    done: ExternalAgentEvent & { type: "done" }
  ): Promise<void> {
    const tokenUsage = await this.readSessionUsage(sessionId)
    // A canonical `usage_update` before `done` as well, so a streaming consumer
    // that never inspects the terminal event still sees the turn's cost.
    if (tokenUsage) {
      for (const queue of record.queues) {
        queue.push({
          type: "usage_update",
          sessionId,
          timestamp: new Date(),
          used: tokenUsage.contextTokens ?? tokenUsage.totalTokens,
          size: tokenUsage.modelContextWindow ?? 0,
        })
      }
    }
    const settled = tokenUsage ? { ...done, tokenUsage } : done
    for (const queue of record.queues) queue.push(settled)
    // Release anything that arrived behind the held `done`, in arrival order.
    const deferred = record.deferredWhileSettling ?? []
    record.deferredWhileSettling = undefined
    for (let i = 0; i < deferred.length; i++) {
      const event = deferred[i]
      if (event.type === "done") {
        // A second terminal event that arrived while this one was settling. It
        // gets the same treatment — its own usage query, with the rest of the
        // buffer still held behind it — rather than being pushed raw ahead of
        // its own stats.
        record.deferredWhileSettling = deferred.slice(i + 1)
        void this.emitSettledWithUsage(sessionId, record, event)
        return
      }
      for (const queue of record.queues) queue.push(event)
    }
  }

  private dispatchError(sessionId: string, error: string): void {
    const record = this.processes.get(sessionId)
    if (!record) return
    for (const queue of record.queues) {
      queue.push({ type: "error", error, sessionId, timestamp: new Date() })
    }
  }

  private finishQueues(record: PiProcess): void {
    for (const queue of record.queues) queue.end()
    record.queues.clear()
    record.busy = false
  }

  /**
   * The turn's usage, and the session's mirror of it.
   *
   * Returns `undefined` rather than throwing: usage is reporting, not
   * correctness, and a stats query that fails must never fail a turn that
   * succeeded.
   */
  private async readSessionUsage(sessionId: string): Promise<ExternalAgentTokenUsage | undefined> {
    const session = this._sessions.get(sessionId)
    const record = this.processes.get(sessionId)
    if (!session || !record || record.exited) return undefined
    try {
      const stats = await record.peer.sendCommand<PiSessionStats>("get_session_stats")
      const tokenUsage = piStatsToTokenUsage(stats)
      session.tokenUsage = tokenUsage
      session.lastActivityAt = new Date()
      return tokenUsage
    } catch {
      return undefined
    }
  }

  // ------------------------------------------------------------- turn control

  async cancel(sessionId: string): Promise<void> {
    const record = this.processes.get(sessionId)
    if (!record || record.exited) return
    await record.peer.sendCommand("abort")
  }

  /** Deliver a message into a live turn (Pi's `steer`). */
  async steerTurn(sessionId: string, message: string): Promise<void> {
    const record = this.requireProcess(sessionId)
    await record.peer.sendCommand("steer", { message })
  }

  async supportsSteering(): Promise<boolean> {
    return true
  }

  async compactSession(sessionId: string): Promise<void> {
    const record = this.requireProcess(sessionId)
    await record.peer.sendCommand("compact", {}, 120000)
  }

  async getCompactionCapability(): Promise<ExternalAgentCompactionCapability> {
    // Native `compact` command, not a slash-command heuristic. `supportsFocus`
    // is part of the native route's shape and was missing from the hand-written
    // return type this used to declare.
    return { status: "supported", routes: [{ kind: "native", supportsFocus: false }] }
  }

  // ------------------------------------------------------------------ config

  async getSessionModels(sessionId: string): Promise<AcpSessionModelState> {
    const record = this.requireProcess(sessionId)
    const [state, models] = await Promise.all([
      record.peer.sendCommand<{ model?: { id?: string; provider?: string } }>("get_state"),
      record.peer.sendCommand<{
        models?: Array<{ id?: string; provider?: string; name?: string }>
      }>("get_available_models"),
    ])
    return {
      currentModelId: state.model ? qualifyModel(state.model) : "",
      availableModels: (models.models ?? []).map((model) => ({
        modelId: qualifyModel(model),
        name: model.name ?? qualifyModel(model),
      })),
    }
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    const record = this.requireProcess(sessionId)
    const { provider, modelId: id } = parsePiModel(modelId)
    await record.peer.sendCommand(
      "set_model",
      provider ? { provider, modelId: id } : { modelId: id }
    )
  }

  /**
   * Set the thinking level, clamped to what the live model actually supports.
   *
   * Without the clamp Pi accepts an unsupported level, reports success, and
   * silently drops to `off`.
   */
  async setThinkingLevel(sessionId: string, level: string): Promise<string | undefined> {
    const record = this.requireProcess(sessionId)
    const available = await record.peer.sendCommand<{ levels?: string[] }>(
      "get_available_thinking_levels"
    )
    const resolved = clampThinkingLevel(level, available.levels ?? [])
    if (!resolved) return undefined
    await record.peer.sendCommand("set_thinking_level", { level: resolved })
    return resolved
  }

  async getConfigOptions(sessionId: string): Promise<AcpConfigOption[]> {
    const record = this.requireProcess(sessionId)
    const [state, levels, models] = await Promise.all([
      record.peer.sendCommand<{
        model?: { id?: string; provider?: string }
        thinkingLevel?: string
      }>("get_state"),
      record.peer.sendCommand<{ levels?: string[] }>("get_available_thinking_levels"),
      record.peer.sendCommand<{
        models?: Array<{ id?: string; provider?: string; name?: string }>
      }>("get_available_models"),
    ])

    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: state.model ? qualifyModel(state.model) : "",
        options: (models.models ?? []).map((model) => ({
          value: qualifyModel(model),
          name: model.name ?? qualifyModel(model),
        })),
      },
      {
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue: state.thinkingLevel ?? "off",
        // Only the levels this model actually honours — the global seven
        // would offer choices that silently collapse to `off`.
        options: (levels.levels ?? []).map((level) => ({ value: level, name: level })),
      },
    ]
  }

  /**
   * Returns the refreshed option list, like the ACP implementation does — the
   * `ProtocolAdapter` contract promises `AcpConfigOption[]` and callers use it
   * to re-render the picker. This resolved `void` before, so a Pi session handed
   * `AgentManager.setConfigOption`'s callers `undefined` where they expected an
   * array.
   */
  async setConfigOption(
    sessionId: string,
    optionId: string,
    value: unknown
  ): Promise<AcpConfigOption[]> {
    if (optionId === "model") {
      await this.setSessionModel(sessionId, String(value))
    } else if (optionId === "thinking") {
      await this.setThinkingLevel(sessionId, String(value))
    } else {
      throw new Error(`Unknown Pi config option: ${optionId}`)
    }
    return this.getConfigOptions(sessionId)
  }

  // ------------------------------------------------------------- permissions

  /**
   * Answer a dialog raised by the bundled extension.
   *
   * Tool authorisation itself does NOT come through here — that is decided by
   * the tool-host broker inside the extension. This is only for dialogs the
   * extension surfaces to the user.
   */
  async respondToPermission(sessionId: string, response: AcpPermissionResponse): Promise<void> {
    await this.answerDialog(sessionId, response.requestId, {
      granted: response.granted,
      value: response.optionId,
    })
  }

  /**
   * Answer a dialog raised by an extension (`confirm` / `select` / `input` /
   * `editor`).
   *
   * This is the method the canonical contract routes `elicitation_request` to,
   * and its absence is why Pi dialogs used to hang forever:
   * `BaseProtocolAdapter.execute` guards the branch with
   * `if (options?.onElicitationRequest && this.respondToElicitation)`, so an
   * adapter without it silently skips the answer while the extension stays
   * blocked. `respondToPermission` existed and worked, but nothing mapped
   * dialogs onto it.
   *
   * The signature carries no session id, so the id is resolved from the
   * `pendingDialogs` registry populated when the request was dispatched.
   */
  async respondToElicitation(response: AcpElicitationResponse): Promise<void> {
    const pending = this.pendingDialogs.get(response.requestId)
    // Already answered, cancelled by a session close, or never ours.
    if (!pending) return
    await this.answerDialog(pending.sessionId, response.requestId, {
      granted: response.action === "accept",
      // Every Pi dialog collects one value under a property named for the
      // method (`piDialogSchema`), so the first entry is the answer.
      value: firstElicitationValue(response.content),
    })
  }

  /**
   * Write one `extension_ui_response` frame.
   *
   * Shape verified against Pi 0.84.1's `dist/modes/rpc/rpc-types.d.ts`:
   *
   * ```ts
   * type RpcExtensionUIResponse =
   *   | { type: "extension_ui_response"; id: string; value: string }
   *   | { type: "extension_ui_response"; id: string; confirmed: boolean }
   *   | { type: "extension_ui_response"; id: string; cancelled: true }
   * ```
   *
   * Three things follow, and the previous implementation got all three wrong.
   * `id` is the DIALOG id — the same field `sendCommand` overwrites with its
   * correlation id, which is why answers never matched
   * `pendingExtensionRequests` and every dialog blocked its extension forever.
   * The payloads are mutually exclusive, so `confirmed` and `value` must never
   * be sent together. And Pi replies to none of them, so this is a frame write,
   * not a command round-trip.
   */
  private answerDialog(
    sessionId: string,
    requestId: string,
    outcome: { granted: boolean; value?: unknown }
  ): Promise<void> | void {
    const record = this.requireProcess(sessionId)
    const method = this.pendingDialogs.get(requestId)?.method
    this.pendingDialogs.delete(requestId)

    // A dismissal is `cancelled`, never `confirmed: false`: the extension reads
    // the latter as a deliberate "no" to a `confirm` rather than "the user
    // walked away", and for a `select` it is not a valid answer at all.
    if (!outcome.granted) {
      return record.peer.sendFrame({
        type: "extension_ui_response",
        id: requestId,
        cancelled: true,
      })
    }
    // `confirm` is the only method that answers with a boolean; every other
    // dialog collects a string.
    if (method === "confirm") {
      return record.peer.sendFrame({
        type: "extension_ui_response",
        id: requestId,
        confirmed: true,
      })
    }
    return record.peer.sendFrame({
      type: "extension_ui_response",
      id: requestId,
      value: outcome.value === undefined ? "" : String(outcome.value),
    })
  }

  /**
   * Cancel every dialog still open on a session.
   *
   * Called as the session closes. Without it the extension keeps waiting on a
   * process that is about to be killed, and on a graceful `abort` that wait is
   * what stops Pi from exiting.
   */
  private cancelPendingDialogs(sessionId: string, record: PiProcess): void {
    for (const [requestId, pending] of [...this.pendingDialogs]) {
      if (pending.sessionId !== sessionId) continue
      this.pendingDialogs.delete(requestId)
      if (record.exited) continue
      try {
        void record.peer.sendFrame({
          type: "extension_ui_response",
          id: requestId,
          cancelled: true,
        })
      } catch {
        // The process may already be gone; the kill below is the guarantee.
      }
    }
  }

  // ------------------------------------------------------- credential checks

  /**
   * Ask Pi whether one provider's credentials resolve (ADR-0119).
   *
   * The whole point of routing this through `pi auth check` is that Cognia
   * never opens Pi's credential files: Pi answers with a status, and
   * `--no-refresh` makes it open its own store read-only, so a Cognia
   * diagnostic cannot refresh, rotate or expire the user's credentials as a
   * side effect of being run.
   *
   * A probe that produces no parseable verdict resolves to `unreadable`, never
   * to `not_ready` — see `pi-auth.ts` for why the exit code cannot be trusted
   * to tell those apart.
   */
  async checkProviderAuth(provider: string): Promise<PiAuthVerdict> {
    const config = this._config
    if (!config) return { status: "unreadable", provider: null, unreadableReason: "no_output" }
    const { stdout, exitCode } = await this.runCliProbe(
      config,
      buildPiAuthCheckArgs({ provider }),
      "auth",
      15000
    )
    const verdict = classifyPiAuthProbe({ stdout, exitCode })
    // Pi echoes the provider it resolved; when it answered without one, keep
    // the id we asked about so the caller can still label the row.
    return verdict.provider ? verdict : { ...verdict, provider }
  }

  /**
   * The providers Pi can actually reach right now, via `pi --list-models`.
   *
   * `auth check` has no "check everything" form, so the diagnostic needs a set
   * to iterate, and this is the honest source: Pi filters the listing down to
   * providers whose credentials resolve. An `unreadable` result is distinct
   * from an empty one on purpose — an empty list is the real diagnosis ("Pi has
   * no usable model"), while unreadable means the listing itself failed and
   * must not be shown as if Pi had answered.
   */
  async listModelProviders(): Promise<PiProviderListing> {
    const config = this._config
    if (!config) return { status: "unreadable" }
    const { stdout } = await this.runCliProbe(config, ["--list-models"], "models", 20000)
    return parsePiModelProviders(stdout)
  }

  /**
   * Every model Pi can run, without a session.
   *
   * `get_available_models` is an RPC and needs a live process; a picker that
   * opens before the first turn has none, and used to show nothing. This is
   * the same `pi --list-models` the credential diagnostic reads, kept as one
   * parse so both surfaces describe the same catalog.
   */
  async listAgentModels(): Promise<PiModelListing> {
    const config = this._config
    if (!config) return { status: "unreadable" }
    const { stdout } = await this.runCliProbe(config, ["--list-models"], "models", 20000)
    return parsePiModelListing(stdout)
  }

  /**
   * Sessions Pi has stored for a working directory (stable-surface shape).
   *
   * Scoped to `options.cwd`, falling back to the configured process cwd, and
   * to every directory when neither is set. Resume works on the id alone
   * because `startSession` re-launches with `--session-id`.
   */
  async listSessions(options?: SessionListOptions): Promise<
    Array<{
      sessionId: string
      cwd?: string
      title?: string
      createdAt?: string
      updatedAt?: string
    }>
  > {
    const cwd = options?.cwd ?? this._config?.process?.cwd
    const records = await this.host.invoke<PiSessionRecord[] | null | undefined>(
      "list_pi_sessions",
      cwd ? { cwd } : {}
    )
    const list = Array.isArray(records) ? records : []
    return list
      .filter((record) => typeof record?.id === "string" && record.id.length > 0)
      .map((record) => ({
        sessionId: record.id,
        ...(record.cwd ? { cwd: record.cwd } : {}),
        ...(record.name ? { title: record.name } : {}),
        ...(record.createdAt ? { createdAt: record.createdAt } : {}),
        ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
      }))
      .sort((a, b) =>
        (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? "")
      )
  }

  async healthCheck(): Promise<boolean> {
    if (!this.isConnected()) return false
    const live = [...this.processes.values()].filter((record) => !record.exited)
    if (live.length === 0) return true
    try {
      await live[0].peer.sendCommand("get_state", {}, 5000)
      return true
    } catch {
      return false
    }
  }

  // ------------------------------------------------------------------ helpers

  private requireProcess(sessionId: string): PiProcess {
    const record = this.processes.get(sessionId)
    if (!record) throw new Error(`Unknown Pi session: ${sessionId}`)
    if (record.exited) throw new Error(`Pi session ${sessionId} is no longer running`)
    return record
  }

  private requireSession(sessionId: string): ExternalAgentSession {
    const session = this._sessions.get(sessionId)
    if (!session) throw new Error(`Unknown Pi session: ${sessionId}`)
    return session
  }
}

/** Raised when the installed Pi is older than the certified floor. */
export class PiVersionError extends Error {
  readonly reasonCode = "runtime_version_unsupported"
  constructor(readonly verdict: PiVersionVerdict) {
    super(
      verdict.status === "unsupported" && verdict.version
        ? `Pi ${verdict.version} is not supported (requires ${PI_CERTIFIED_VERSION} or newer)`
        : `Could not determine the Pi version (requires ${PI_CERTIFIED_VERSION} or newer)`
    )
    this.name = "PiVersionError"
  }
}

/**
 * Operator kill switch (ADR-0119).
 *
 * Blocks NEW Pi RPC sessions without terminating sessions already running — a
 * switch that killed live turns mid-tool-call could leave half-written files
 * behind, which is a worse outcome than letting them finish.
 */
export const PI_KILL_SWITCH_ENV = "COGNIA_DISABLE_PI_RPC"

export function isPiRpcDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[PI_KILL_SWITCH_ENV]?.trim().toLowerCase()
  return value === "1" || value === "true" || value === "yes"
}

/** Raised when the operator kill switch is engaged. */
export class PiDisabledError extends Error {
  readonly reasonCode = "agent_disabled"
  constructor() {
    super(`Pi RPC sessions are disabled by ${PI_KILL_SWITCH_ENV}`)
    this.name = "PiDisabledError"
  }
}

/** Env var carrying Cognia's PII-gated system prompt to the bundled extension. */
export const PI_SYSTEM_PROMPT_ENV = "COGNIA_TOOLHOST_PI_SYSTEM_PROMPT"

/**
 * Assemble the system prompt Cognia injects into Pi, refusing to send it if it
 * would leak PII.
 *
 * Throws rather than silently redacting: a prompt the gate rejects means
 * something upstream put personal data somewhere it should not be, and
 * quietly sending a scrubbed version would hide that.
 */
export function buildPiSystemPrompt(options: SessionCreateOptions): string | undefined {
  const envelope = options.instructionEnvelope
  const pieces = [
    options.systemPrompt,
    envelope?.developerInstructions,
    envelope?.customInstructions,
    envelope?.projectContextSummary,
    envelope?.skillsSummary,
    options.briefMode ? "Answer concisely." : undefined,
  ].filter((piece): piece is string => Boolean(piece && piece.trim()))

  if (pieces.length === 0) return undefined

  if (!hasNoLeakingPiiDeep(pieces)) {
    throw new PiOutboundBlockedError()
  }
  return pieces.join("\n\n")
}

/** Raised when the outbound PII gate refuses to let a prompt reach Pi. */
export class PiOutboundBlockedError extends Error {
  readonly reasonCode = "permission_denied"
  constructor() {
    super("Pi session input blocked by the outbound PII gate")
    this.name = "PiOutboundBlockedError"
  }
}

/**
 * How long the bundled extension has to announce itself before the session
 * fails, under `isolated` — the only policy whose startup Cognia controls.
 *
 * Measured against Pi 0.84.3 on a cold working directory: 250ms with the
 * user's stack off. Five seconds is a wide margin over that.
 */
export const PI_EXTENSION_HANDSHAKE_TIMEOUT_MS = 5000

/**
 * The same budget under a policy that loads the user's own extensions.
 *
 * `session_start` does not fire until every loaded extension has initialised,
 * and under `global` that set is whatever the user installed: on a real
 * machine, an LSP bridge, an MCP client dialing five servers, a background-task
 * poller, a status line, a permission engine. Measured on that machine, the
 * same handshake that takes 250ms isolated took 5578ms — just past the
 * isolated budget, so every Pi session on that install was refused with
 * "the extension did not report ready", about an extension that was loading
 * perfectly well behind somebody else's.
 *
 * Waiting longer is the honest answer rather than a workaround: the time is
 * spent in code Cognia neither ships nor can bound, and the gate exists to
 * catch an extension that is ABSENT or tampered with, which no amount of
 * waiting will fix. `isolated` keeps the tight budget precisely because its
 * startup set is ours.
 */
export const PI_EXTENSION_HANDSHAKE_TIMEOUT_GLOBAL_MS = 30_000

/** The budget this policy's startup set deserves. */
export function piHandshakeTimeoutMs(policy: PiExtensionPolicy): number {
  return policy === "isolated"
    ? PI_EXTENSION_HANDSHAKE_TIMEOUT_MS
    : PI_EXTENSION_HANDSHAKE_TIMEOUT_GLOBAL_MS
}

/** Marker the bundled extension writes on `session_start`. */
export const PI_HANDSHAKE_MARKER = "cognia-ready"

/**
 * Is this frame the bundled extension announcing itself?
 *
 * The extension reports through Pi's `setStatus` UI method, which arrives as
 * an `extension_ui_request`. Matching on the marker rather than on the mere
 * presence of a status keeps another extension's status line from satisfying
 * Cognia's gate.
 */
export function isCogniaHandshake(event: PiEvent): boolean {
  if (event.type !== "extension_ui_request") return false
  if (event.method !== "setStatus") return false
  // `statusText` / `statusKey`, NOT `text` / `title` — confirmed by running
  // the bundled extension under real Pi 0.84.1. Matching the wrong field made
  // the gate silently unsatisfiable.
  const statusText = typeof event.statusText === "string" ? event.statusText : ""
  const statusKey = typeof event.statusKey === "string" ? event.statusKey : ""
  return `${statusKey}${statusText}`.includes(PI_HANDSHAKE_MARKER)
}

/**
 * Raised when no verified extension is available, so the session must not
 * start. Distinct from `PiExtensionHandshakeError`, which means an extension
 * WAS loaded but never announced itself — the two have different remedies and
 * collapsing them is what made the old failure mode unreadable.
 */
export class PiExtensionUnavailableError extends Error {
  readonly reasonCode = "extension_unavailable"
  constructor(reason: string) {
    super(reason)
    this.name = "PiExtensionUnavailableError"
  }
}

/**
 * Raised when the bundled extension never proved it loaded.
 *
 * Names the policy, because the two cases need different things from the user.
 * Under `isolated` the startup set is ours and a timeout means the extension is
 * genuinely not loading. Under `global` it means the user's own Pi extensions
 * are still starting, and the actionable advice is to switch this agent to
 * isolated rather than to go looking for a broken Cognia file.
 */
export class PiExtensionHandshakeError extends Error {
  readonly reasonCode = "extension_handshake_failed"
  constructor(sessionId: string, policy: PiExtensionPolicy = "isolated") {
    const timeout = piHandshakeTimeoutMs(policy)
    super(
      `The Cognia Pi extension did not report ready for session ${sessionId} within ` +
        `${timeout}ms` +
        (policy === "isolated"
          ? ""
          : `. This agent runs with extension policy "${policy}", so Pi loads your own ` +
            `extensions before the session starts. Switch it to "isolated" if they are slow ` +
            `or failing.`)
    )
    this.name = "PiExtensionHandshakeError"
  }
}

/** Raised when every Pi process slot on this host is occupied by a live turn. */
export class PiResourceLimitError extends Error {
  readonly reasonCode = "resource_limit"
  constructor(limit: number) {
    super(`All ${limit} Pi processes on this host are busy`)
    this.name = "PiResourceLimitError"
  }
}

/**
 * The single value a Pi dialog collects, pulled out of the canonical
 * elicitation content map.
 *
 * `piDialogSchema` gives every dialog exactly one property, named for the Pi
 * method, so "the first value" is unambiguous here rather than a guess.
 */
/**
 * The Pi dialog method behind a canonical elicitation request.
 *
 * `mapPiEvent` carries the untouched Pi event under `request.raw` precisely so
 * a responder can honour the original without the mapper having to model every
 * future dialog field.
 */
function asDialogMethod(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const method = (raw as { method?: unknown }).method
  return typeof method === "string" ? method : undefined
}

function firstElicitationValue(
  content: Record<string, unknown> | null | undefined
): unknown | undefined {
  if (!content) return undefined
  for (const value of Object.values(content)) {
    if (value !== undefined) return value
  }
  return undefined
}

function qualifyModel(model: { id?: string; provider?: string }): string {
  return model.provider ? `${model.provider}/${model.id ?? ""}` : (model.id ?? "")
}

function messageToPiPrompt(message: ExternalAgentMessage): {
  message: string
  images?: Array<{ type: "image"; data: string; mimeType: string }>
} {
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .filter(Boolean)
    .join("\n")
  const images = message.content.flatMap((block) => {
    if (block.type !== "image") return []
    if (block.source.type !== "base64" || !block.source.data) {
      throw new Error("Pi RPC image prompts require base64 image data")
    }
    return [
      {
        type: "image" as const,
        data: block.source.data,
        mimeType: block.source.mediaType,
      },
    ]
  })
  return { message: text, ...(images.length > 0 ? { images } : {}) }
}

/**
 * UTF-8 encode a line-framed chunk for the byte-oriented decoder.
 *
 * `TextEncoder` rather than `Buffer.from` so the same path works in the
 * renderer, where this adapter also runs.
 */
function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(base64, "base64"))
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
