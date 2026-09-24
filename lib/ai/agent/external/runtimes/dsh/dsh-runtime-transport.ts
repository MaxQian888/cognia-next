import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { nanoid } from "nanoid"
import { agentInvoke, agentListen } from "../../agent-transport"
import { JsonRpcPeer } from "../../json-rpc-peer"
import { PiFrameDecoder } from "../pi/pi-rpc-peer"
import type {
  DshRuntimeTransport,
  DshRuntimeTransportHandlers,
  DshPromptContentBlock,
} from "./dsh-sdk-client"
import { redactDshOutput } from "./dsh-runtime-install"

/** The existing host process plane works in Tauri, CLI and headless hosts. */
export interface DshProcessHost {
  invoke: typeof agentInvoke
  listen: typeof agentListen
}

export interface DshTransportLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  workspace: string
  provider: string
  model: string
  maxTokens?: number
  reasoningEffort?: string
}

export class DshRuntimeUnavailableError extends Error {}

/** Defaults matching `runtime/deepseek-harness/host.sdk-readonly.yml`. */
const DEFAULT_PROVIDER = "deepseek-official"
const DEFAULT_MODEL = "deepseek-v4-flash"

/**
 * Derive the launch spec from a stored agent config.
 *
 * Managed launch preparation puts resolved paths into a transient `process`
 * block immediately before connect. The API key
 * is NOT stored there — it is injected into `process.env` by the execution host
 * immediately before connect, from a `CredentialReference`, and this function
 * only forwards what it is handed.
 *
 * @throws {DshRuntimeUnavailableError} when the agent has not been installed.
 */
export function resolveDshLaunchFromConfig(config: ExternalAgentConfig): DshTransportLaunch {
  const process_ = config.process
  if (!process_?.command || !process_.args?.length) {
    throw new DshRuntimeUnavailableError(
      "This DeepSeek Harness agent has no installed runtime. Run the installer " +
        "(Settings -> Agents, or `cognia-agent backend install deepseek-harness`) first."
    )
  }
  const env = process_.env ?? {}
  if (!env.DEEPSEEK_API_KEY) {
    // Failing here keeps the cause attributable: without it the model route
    // fails deep inside the runtime with an opaque provider error.
    throw new DshRuntimeUnavailableError(
      "No DeepSeek credential was resolved for this agent before launch."
    )
  }
  return {
    command: process_.command,
    args: process_.args,
    env,
    workspace: env.COGNIA_DSH_WORKSPACE ?? process_.cwd ?? "",
    provider: DEFAULT_PROVIDER,
    model: env.COGNIA_DSH_MODEL ?? DEFAULT_MODEL,
    ...(env.COGNIA_DSH_REASONING_EFFORT
      ? { reasoningEffort: env.COGNIA_DSH_REASONING_EFFORT }
      : {}),
    ...(env.COGNIA_DSH_MAX_TOKENS ? { maxTokens: parseMaxTokens(env.COGNIA_DSH_MAX_TOKENS) } : {}),
  }
}

function parseMaxTokens(raw: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DshRuntimeUnavailableError(
      "DeepSeek Harness maxTokens must be a positive safe integer."
    )
  }
  return value
}

/** No Node library is imported into the renderer: the host owns every child. */
export function createDshRuntimeTransport(
  config: ExternalAgentConfig,
  resolveLaunch: (config: ExternalAgentConfig) => DshTransportLaunch,
  hostSupportsSubprocess: boolean,
  host: DshProcessHost = { invoke: agentInvoke, listen: agentListen }
): DshRuntimeTransport {
  if (!hostSupportsSubprocess) {
    throw new DshRuntimeUnavailableError(
      "DeepSeek Harness requires an available external-agent process host."
    )
  }
  return new HarnessSubprocessTransport(config, resolveLaunch, host)
}

class HarnessSubprocessTransport implements DshRuntimeTransport {
  private peer?: JsonRpcPeer
  private processId?: string
  private running = false
  private starting?: Promise<void>
  private closing?: Promise<void>
  private readonly unlisten: Array<() => void> = []
  private readonly secrets: string[] = []
  private stderr = ""
  private handlers?: DshRuntimeTransportHandlers
  // Reuse the bounded, LF-only byte decoder; JSON-RPC correlation stays in JsonRpcPeer.
  private readonly decoder = new PiFrameDecoder()

  constructor(
    private readonly config: ExternalAgentConfig,
    private readonly resolveLaunch: (config: ExternalAgentConfig) => DshTransportLaunch,
    private readonly host: DshProcessHost
  ) {}

  start(handlers: DshRuntimeTransportHandlers): Promise<void> {
    if (this.starting)
      return Promise.reject(
        new DshRuntimeUnavailableError("DeepSeek Harness runtime is already started.")
      )
    this.starting = this.startOnce(handlers)
    return this.starting
  }

  private async startOnce(handlers: DshRuntimeTransportHandlers): Promise<void> {
    if (this.processId || this.closing)
      throw new DshRuntimeUnavailableError("DeepSeek Harness runtime is already started or closed.")
    const launch = this.resolveLaunch(this.config)
    this.handlers = handlers
    for (const [key, value] of Object.entries(launch.env)) {
      if (/KEY|TOKEN|SECRET/.test(key)) this.secrets.push(value)
    }
    // MCP credentials live inside a session-scoped JSON envelope rather than
    // top-level environment keys. Child startup errors must redact them too.
    try {
      const servers: unknown = JSON.parse(launch.env.COGNIA_DSH_MCP_SERVERS ?? "[]")
      if (Array.isArray(servers)) {
        for (const server of servers) {
          for (const pairs of [server?.env, server?.headers]) {
            if (Array.isArray(pairs)) {
              for (const pair of pairs)
                if (typeof pair?.value === "string") this.secrets.push(pair.value)
            }
          }
        }
      }
    } catch {
      /* The managed launcher reports invalid configuration. */
    }
    const processId = `dsh-${nanoid()}`
    this.processId = processId
    const peer = new JsonRpcPeer({
      defaultTimeout: this.config.timeout ?? 30000,
      cancellationNotifications: false,
      writeRaw: (message) =>
        this.host.invoke("send_to_external_agent", { agentId: processId, message }),
      onNotification: (method, params) => this.handlers?.onNotification({ method, params }),
    })
    this.peer = peer
    try {
      this.unlisten.push(
        await this.host.listen<{ agentId: string; data: string }>(
          "external-agent://stdout-raw",
          (payload) => {
            if (payload.agentId !== processId) return
            try {
              const bytes = Uint8Array.from(atob(payload.data), (char) => char.charCodeAt(0))
              for (const frame of this.decoder.push(bytes)) peer.ingest(frame)
            } catch (error) {
              this.failed(error instanceof Error ? error.message : String(error))
              void this.close().catch(() => {})
            }
          }
        )
      )
      this.unlisten.push(
        await this.host.listen<{ agentId: string; data: string }>(
          "external-agent://stderr",
          (payload) => {
            if (payload.agentId === processId)
              this.stderr = redactDshOutput(this.stderr + payload.data, this.secrets).slice(-4096)
          }
        )
      )
      this.unlisten.push(
        await this.host.listen<{ agentId: string; code: number }>(
          "external-agent://exit",
          (payload) => {
            if (payload.agentId !== processId) return
            this.processId = undefined
            const reason = `DeepSeek Harness exited (code ${payload.code}). ${this.stderr}`
            this.failed(reason)
            this.cleanup()
          }
        )
      )
      await this.host.invoke("spawn_external_agent", {
        config: {
          id: processId,
          command: launch.command,
          args: launch.args,
          cwd: launch.workspace,
          env: launch.env,
          framing: "raw",
        },
      })
      const result = await peer.sendRequest<{ serverInfo?: { name?: string; version?: string } }>(
        "initialize",
        {
          cwd: launch.workspace,
          provider: launch.provider,
          model: launch.model,
          ...(launch.maxTokens !== undefined ? { maxTokens: launch.maxTokens } : {}),
          ...(launch.reasoningEffort ? { reasoningEffort: launch.reasoningEffort } : {}),
        }
      )
      // Upstream does not negotiate versions: enforce the named SDK endpoint;
      // package/session versions are certified by the managed launcher and codec.
      if (
        result?.serverInfo?.name !== "deepseek-harness-sdk-runtime" ||
        result.serverInfo.version !== "0.0.1"
      ) {
        throw new Error("DeepSeek Harness returned an unsupported SDK server identity.")
      }
      if (!this.processId) throw new Error("DeepSeek Harness exited during initialization.")
      this.running = true
    } catch (error) {
      this.running = false
      peer.rejectAll("DeepSeek Harness initialization failed.")
      const message = redactDshOutput(
        error instanceof Error ? error.message : String(error),
        this.secrets
      )
      // A failed handshake cannot safely accept shutdown; reap through the host.
      try {
        await this.host.invoke("kill_external_agent", { agentId: processId })
      } catch (cleanupError) {
        throw new DshRuntimeUnavailableError(
          `${message} Cleanup failed: ${redactDshOutput(String(cleanupError), this.secrets)}`
        )
      }
      this.processId = undefined
      this.cleanup()
      throw new DshRuntimeUnavailableError(message)
    }
  }

  async prompt(sessionId: string, contentBlocks: DshPromptContentBlock[]): Promise<string> {
    if (!this.peer || !this.running)
      throw new DshRuntimeUnavailableError("The DeepSeek Harness runtime is not running.")
    const payload = { sessionId, contentBlocks }
    if (!hasNoLeakingPiiDeep(payload))
      throw new Error("DeepSeek Harness prompt blocked by PII gate")
    try {
      const result = await this.peer.sendRequest<{ messageId?: unknown }>("session/prompt", payload)
      if (typeof result?.messageId !== "string" || !result.messageId)
        throw new Error("DeepSeek Harness returned an invalid prompt admission receipt.")
      return result.messageId
    } catch (error) {
      throw new Error(
        redactDshOutput(error instanceof Error ? error.message : String(error), this.secrets)
      )
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = this.stop().catch((error) => {
      this.closing = undefined
      throw error
    })
    return this.closing
  }

  private async stop(): Promise<void> {
    // Closing during listener registration/spawn must wait for startup to
    // settle, otherwise the host can spawn a child after teardown has finished.
    await this.starting?.catch(() => {})
    const processId = this.processId
    const wasRunning = this.running
    this.running = false
    // Intentional shutdown must not become a spurious runtime failure.
    this.handlers = undefined
    try {
      if (processId) {
        if (wasRunning) await this.peer?.sendRequest("shutdown", undefined, 1000).catch(() => {})
        // The host owns bounded process-group termination and reaping.
        if (this.processId === processId) {
          try {
            await this.host.invoke("kill_external_agent", { agentId: processId })
          } catch (error) {
            // Exit can race the host command. A confirmed exit is already reaped.
            if (this.processId === processId) {
              throw new Error(redactDshOutput(String(error), this.secrets))
            }
          }
        }
        this.processId = undefined
      }
    } finally {
      this.peer?.rejectAll("DeepSeek Harness runtime closed.")
      if (!this.processId) this.cleanup()
    }
  }

  private failed(reason: string): void {
    this.running = false
    this.peer?.rejectAll(reason)
    this.handlers?.onClosed(reason)
    this.handlers = undefined
  }

  private cleanup(): void {
    for (const off of this.unlisten.splice(0)) off()
    this.decoder.reset()
    this.peer = undefined
    this.stderr = ""
    this.secrets.length = 0
  }

  isRunning(): boolean {
    return this.running
  }
}
