import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

import type { DshRuntimeTransport, DshRuntimeTransportHandlers } from "./dsh-sdk-client"
import { redactDshOutput } from "./dsh-runtime-install"

/**
 * Host-side transport for the DeepSeek Harness SDK runtime.
 *
 * `@deepseek-ai/dsh-sdk-client` spawns a subprocess and is installed into the
 * isolated runtime home, never into the Cognia workspace. This module is
 * reachable from `app/layout.tsx` through `manager.ts`, so it IS in the client
 * bundle — which means the specifier must never appear in any module graph, not
 * even inside a dynamic `import()`. See {@link loadHarnessClientModule}.
 *
 * The upstream client already owns the shutdown ladder
 * (`shutdown` RPC -> stdin EOF -> SIGTERM -> SIGKILL) and typed transport
 * errors, so this wrapper adds only host gating, redaction, and the shape the
 * adapter expects.
 */

/** Minimal surface used from `@deepseek-ai/dsh-sdk-client`'s `HarnessClient`. */
interface HarnessClientLike {
  start(): Promise<void>
  initialize(params: Record<string, unknown>): Promise<unknown>
  prompt(params: Record<string, unknown>): Promise<{ messageId: string }>
  subscribe(): { [Symbol.asyncIterator](): AsyncIterator<unknown> }
  close(): Promise<void>
}

export interface DshTransportLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  workspace: string
  provider: string
  model: string
  maxTokens?: number
}

export class DshRuntimeUnavailableError extends Error {}

interface HarnessClientModule {
  HarnessClient: new (options: Record<string, unknown>) => HarnessClientLike
}

/**
 * Bundler-opaque dynamic import.
 *
 * `manager.ts` is reachable from `app/layout.tsx`, so this module IS in the
 * client bundle. A plain `await import("@deepseek-ai/dsh-sdk-client")` — even
 * through a variable — still forces Turbopack and webpack to resolve the
 * specifier at build time, and it is unresolvable by design: the package is
 * installed into the isolated runtime home, never into the Cognia workspace.
 * Routing through `new Function` is what keeps the specifier out of every
 * module graph. The argument is a path Cognia computed under its own data
 * root, never user input.
 */
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<unknown>

/**
 * Load the SDK client from the installed runtime home.
 *
 * The launcher path is `<runtimeHome>/launcher.mjs`, so the runtime home — and
 * therefore the client's real location — is derivable from the launch spec
 * Cognia just validated. Importing it from there rather than by bare specifier
 * matches where the file actually is.
 */
export async function loadHarnessClientModule(
  command: string,
  args: readonly string[]
): Promise<HarnessClientModule> {
  const launcherPath = args[0]
  if (!launcherPath) {
    throw new DshRuntimeUnavailableError(
      `Cannot locate the DeepSeek Harness SDK client: no launcher path in the launch spec for ${command}.`
    )
  }
  // Plain string arithmetic rather than `node:path`, so this module pulls in no
  // Node built-in that would then need stubbing for the browser bundle.
  const separator = launcherPath.includes("\\") && !launcherPath.includes("/") ? "\\" : "/"
  const runtimeHome = launcherPath.slice(0, launcherPath.lastIndexOf(separator))
  const clientEntry = [
    runtimeHome,
    "node_modules",
    "@deepseek-ai",
    "dsh-sdk-client",
    "lib",
    "index.js",
  ].join(separator)
  const url = clientEntry.startsWith("file:")
    ? clientEntry
    : `file://${separator === "\\" ? "/" : ""}${clientEntry.split("\\").join("/")}`

  try {
    return (await dynamicImport(url)) as HarnessClientModule
  } catch (error) {
    throw new DshRuntimeUnavailableError(
      `The DeepSeek Harness SDK client is missing from the installed runtime ` +
        `(${clientEntry}). Reinstall the runtime. ${(error as Error).message}`
    )
  }
}

/** Defaults matching `runtime/deepseek-harness/host.sdk-readonly.yml`. */
const DEFAULT_PROVIDER = "deepseek-official"
const DEFAULT_MODEL = "deepseek-v4-flash"

/**
 * Derive the launch spec from a stored agent config.
 *
 * The installer writes the resolved runtime paths into the config's `process`
 * block, so a connect does not have to re-derive the runtime home. The API key
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
  }
}

/**
 * Build a transport for a config.
 *
 * @throws {DshRuntimeUnavailableError} in hosts that cannot spawn processes.
 */
export function createDshRuntimeTransport(
  config: ExternalAgentConfig,
  resolveLaunch: (config: ExternalAgentConfig) => DshTransportLaunch,
  hostSupportsSubprocess: boolean,
  /** Overridable for tests; defaults to loading from the installed runtime home. */
  loadModule: typeof loadHarnessClientModule = loadHarnessClientModule
): DshRuntimeTransport {
  if (!hostSupportsSubprocess) {
    throw new DshRuntimeUnavailableError(
      "The DeepSeek Harness runtime needs a local subprocess and is unavailable in this host. " +
        "It runs on desktop (Tauri), CLI, and headless only."
    )
  }
  return new HarnessSubprocessTransport(config, resolveLaunch, loadModule)
}

class HarnessSubprocessTransport implements DshRuntimeTransport {
  private client?: HarnessClientLike
  private running = false
  private readonly secrets: string[] = []

  constructor(
    private readonly config: ExternalAgentConfig,
    private readonly resolveLaunch: (config: ExternalAgentConfig) => DshTransportLaunch,
    private readonly loadModule: typeof loadHarnessClientModule
  ) {}

  async start(handlers: DshRuntimeTransportHandlers): Promise<void> {
    const launch = this.resolveLaunch(this.config)
    // The API key is the one value that must never reach a log or event; keep a
    // reference purely so stderr can be scrubbed of it.
    const apiKey = launch.env.DEEPSEEK_API_KEY
    if (apiKey) this.secrets.push(apiKey)

    const { HarnessClient } = await this.loadModule(launch.command, launch.args)

    const client = new HarnessClient({
      launch: { command: launch.command, args: launch.args },
      env: launch.env,
    })
    await client.start()
    await client.initialize({
      cwd: launch.workspace,
      provider: launch.provider,
      model: launch.model,
      ...(launch.maxTokens !== undefined ? { maxTokens: launch.maxTokens } : {}),
    })

    this.client = client
    this.running = true
    void this.pump(client, handlers)
  }

  private async pump(
    client: HarnessClientLike,
    handlers: DshRuntimeTransportHandlers
  ): Promise<void> {
    try {
      for await (const notification of client.subscribe()) {
        handlers.onNotification(notification)
      }
      this.running = false
      handlers.onClosed("The DeepSeek Harness runtime closed its notification stream.")
    } catch (error) {
      this.running = false
      // TransportClosedError carries an exit code and a bounded stderr tail,
      // which is exactly the kind of text that can contain a leaked key.
      const message = error instanceof Error ? error.message : String(error)
      handlers.onClosed(redactDshOutput(message, this.secrets))
    }
  }

  async prompt(sessionId: string, text: string): Promise<string> {
    const client = this.client
    if (!client || !this.running) {
      throw new DshRuntimeUnavailableError("The DeepSeek Harness runtime is not running.")
    }
    const providerPayload = {
      sessionId,
      contentBlocks: [{ type: "text", text }],
    }
    if (!hasNoLeakingPiiDeep(providerPayload)) {
      throw new Error("DeepSeek Harness prompt blocked by PII gate")
    }
    const result = await client.prompt(providerPayload)
    // An inbox-admission receipt, not a turn result: the turn boundary comes
    // from session.status running -> idle.
    return result.messageId
  }

  async close(): Promise<void> {
    const client = this.client
    this.client = undefined
    this.running = false
    // Upstream's close() runs the full shutdown ladder and is idempotent.
    if (client) await client.close()
    this.secrets.length = 0
  }

  isRunning(): boolean {
    return this.running
  }
}
