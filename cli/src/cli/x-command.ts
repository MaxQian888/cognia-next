/**
 * `cognia-agent x <agent>` — launch an external coding agent through cognia.
 *
 * Routes the agent's API calls through cognia's model gateway (or a local
 * fallback proxy), providing model management, credential sharing, and
 * provider routing without modifying the external tools.
 *
 * Usage:
 *   cognia-agent x claude [--model m] [--gateway url] [--proxy url|off] [--profile p] [-- <passthrough>]
 *   cognia-agent x codex  [--model m] [--gateway url] [--proxy url|off] [--profile p] [-- <passthrough>]
 *
 * Every launch is its own instance: it authenticates with a route ticket
 * minted for it alone (revoked when it exits), runs in an isolated agent
 * home so it never touches the user's own sessions or login, and carries
 * exactly one credential, the gateway's. The upstream provider keys, the
 * user's subscription token and any transport override in the shell are
 * stripped from the child. See `egress-proxy.ts`, `launch-home.ts`,
 * `agent-launcher.ts:AMBIENT_CREDENTIAL_ENV`.
 */

import { createHash, randomBytes } from "node:crypto"
import os from "node:os"
import { boolFlag, stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"
import { loadConfig as defaultLoadConfig } from "../config/load"
import { setAgentBackendModel } from "../config/mutate"
import { resolveHome } from "../config/load"
import { detectAgentCli, type SupportedAgent } from "../x/detect-cli"
import { selectModel } from "../x/model-selector"
import {
  GatewayCredentialError,
  RemoteGatewayRefusedError,
  connectGateway,
  type GatewayConnection,
} from "../x/gateway-connect"
import { launchAgent } from "../x/agent-launcher"
import { codexHomeFallbackRequested } from "../x/codex-config"
import {
  EgressProxyError,
  childProxyEnv,
  describeEgressProxy,
  resolveEgressProxy,
  type EgressProxyPlan,
} from "../x/egress-proxy"
import { LaunchProfileError, describeLaunchHome, resolveLaunchHome } from "../x/launch-home"
import type { TicketMintRequest } from "../x/mint-ticket"
import type { ProxyConfig } from "../x/proxy-server"
import type { ExternalBackendConfig, ResolvedConfig } from "../config/schema"

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface XCommandDeps {
  out?: OutputSink
  loadConfig?: (flags?: Record<string, string | boolean>) => ResolvedConfig
  detect?: typeof detectAgentCli
  selectModel?: typeof selectModel
  connect?: typeof connectGateway
  launch?: typeof launchAgent
  persistModel?: typeof setAgentBackendModel
  launchHome?: typeof resolveLaunchHome
  /** Process environment (tests substitute a clean one). */
  env?: Record<string, string | undefined>
}

const SUPPORTED_AGENTS = new Set<SupportedAgent>(["claude", "codex"])

const X_HELP = `cognia-agent x — launch external coding agents through cognia

Usage:
  cognia-agent x claude [flags] [-- <passthrough args>]
  cognia-agent x codex  [flags] [-- <passthrough args>]

Supported agents:
  claude    Launch Claude Code CLI (anthropic-ai/claude-code)
  codex     Launch OpenAI Codex CLI (openai/codex)

Flags:
  --model, -m <id>          Select the model (skip interactive picker)
  --gateway <url>           Route through this gateway listener instead of the
                            default (loopback unless --allow-remote-gateway)
  --proxy <url|off>         Egress proxy for the upstream hop and the agent's
                            own traffic: http://, https://, socks5://, socks5h://
                            with optional user:pass@. "off" ignores an inherited
                            HTTPS_PROXY. Loopback and the gateway never go
                            through it.
  --proxy-bypass <a,b>      Extra hosts, .suffixes or CIDRs that dial direct
  --profile <name>          Isolated agent home to use (default "default");
                            each profile is a separate instance with its own
                            sessions, so --resume works within a profile
  --shared-home             Use your own ~/.claude or ~/.codex instead of an
                            isolated profile (their settings apply; their
                            sessions and login are shared with this launch)
  --bypass, -y              Enable auto-approve mode (skip permission prompts)
  --resume <id>             Resume a previous session
  --verbose                 Log proxy requests for debugging
  --allow-remote-gateway    Accept a non-loopback gateway URL
  --codex-home-fallback     Codex only: write a temporary CODEX_HOME instead of
                            passing -c provider overrides (for a Codex that
                            refuses dotted -c keys). Off unless asked.
  --                        Everything after this is passed directly to the agent CLI

Config (~/.cognia/config.json, agentBackends.<agent>):
  model, gateway, proxy, proxyBypass, profile, sharedHome
  Each is the persisted form of the flag above. The flag wins.

Environment:
  COGNIA_GATEWAY_URL   Gateway listener (default http://127.0.0.1:47823)
  COGNIA_GATEWAY_KEY   A gateway API key. Without it a route ticket is minted
                       for this launch from the running Cognia desktop.
  HTTPS_PROXY etc.     Used when neither --proxy nor config names a proxy.

The agent's API calls are routed through cognia's gateway when it is running,
authenticated with a route ticket minted for this launch and revoked when it
exits (or your gateway key). Only when no gateway is running does a local
proxy start with your own provider credentials. The agent never inherits
ANTHROPIC_*, OPENAI_* or CLAUDE_CODE_OAUTH_TOKEN from your shell: the gateway
credential is the only one it holds.
`

/** A stable identity for this launch, for the route ticket's frozen spec. */
export function executionFingerprintFor(agent: string, model: string, cwd: string): string {
  const digest = createHash("sha256").update(`x|${agent}|${model}|${cwd}`).digest("hex")
  return `aexf1-${digest.slice(0, 24)}`
}

export function ticketRequestFor(agent: string, model: string, cwd: string): TicketMintRequest {
  return {
    model,
    sessionId: `x-${agent}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
    executionFingerprint: executionFingerprintFor(agent, model, cwd),
    routePolicy: "gateway-required",
  }
}

const MODE_LABELS: Record<GatewayConnection["mode"], string> = {
  "desktop-gateway-ticket": "cognia gateway (route ticket)",
  "desktop-gateway-key": "cognia gateway (API key)",
  "node-proxy": "local proxy",
}

// ────────────────────────────────────────────────────────────────────────────
// Command
// ────────────────────────────────────────────────────────────────────────────

/**
 * Execute the `cognia x <agent>` command.
 *
 * Flow:
 * 1. Parse agent name from positionals
 * 2. Detect the agent CLI
 * 3. Load config, resolve credentials
 * 4. Select model (flag → remembered → interactive picker)
 * 5. Connect to gateway (probe desktop → fallback proxy)
 * 6. Launch agent with env injection
 * 7. Persist model choice on successful exit
 */
export async function xCommand(args: ParsedArgs, deps: XCommandDeps = {}): Promise<number> {
  const out = deps.out ?? realOutput

  // Help
  if (args.help) {
    out.write(X_HELP)
    return 0
  }

  // Parse agent name from the first positional (the command itself is "x",
  // so positionals[0] is the agent name after arg parsing shifts the command).
  const agentName = args.positionals[0]?.toLowerCase()
  if (!agentName || !SUPPORTED_AGENTS.has(agentName as SupportedAgent)) {
    if (agentName) {
      out.error(`Unknown agent: "${agentName}"\n`)
    }
    out.error(X_HELP)
    return 2
  }
  const agent = agentName as SupportedAgent

  // Detect agent CLI
  const detect = deps.detect ?? detectAgentCli
  const detection = await detect(agent)
  if (!detection.installed) {
    out.error(`\x1b[31m✗\x1b[0m ${agent} CLI is not installed.\n`)
    out.error(`  Install it with: \x1b[33m${detection.installHint}\x1b[0m\n`)
    return 1
  }
  out.write(
    `\x1b[32m✓\x1b[0m ${agent} CLI found${detection.version ? ` (v${detection.version})` : ""}\n`
  )

  // Load config
  const loadConfig = deps.loadConfig ?? defaultLoadConfig
  let config: ResolvedConfig
  try {
    config = loadConfig()
  } catch (err) {
    out.error(`Config error: ${(err as Error).message}\n`)
    return 2
  }

  // Resolve model
  const modelFlag = stringFlag(args, "model")
  const remembered = config.agentBackends?.[agent]?.model
  let model: string | undefined
  if (modelFlag) {
    model = modelFlag
  } else {
    const modelSelect = deps.selectModel ?? selectModel
    model = await modelSelect(agent, remembered)
  }

  out.write(`\x1b[36m→\x1b[0m Model: ${model}\n`)

  // Egress proxy: decided once, before anything dials out. Both the local
  // proxy's upstream hop and the agent's own traffic follow this plan.
  const env = deps.env ?? process.env
  const backend: ExternalBackendConfig | undefined = config.agentBackends?.[agent]
  let egress: EgressProxyPlan
  try {
    egress = resolveEgressProxy({
      flag: stringFlag(args, "proxy"),
      bypassFlag: stringFlag(args, "proxy-bypass"),
      configured: backend?.proxy,
      configuredBypass: backend?.proxyBypass,
      env,
    })
  } catch (err) {
    if (err instanceof EgressProxyError) {
      out.error(`\x1b[31m✗\x1b[0m ${err.message}\n`)
      return 2
    }
    throw err
  }
  out.write(`\x1b[36m→\x1b[0m Egress proxy: ${describeEgressProxy(egress)}\n`)

  // Connect to gateway. The upstream provider keys are only materialized if
  // the local proxy actually starts: the gateway path never sees them.
  const verbose = boolFlag(args, "verbose")
  const connect = deps.connect ?? connectGateway
  const gatewayUrl = stringFlag(args, "gateway") ?? backend?.gateway
  let gateway: GatewayConnection
  try {
    gateway = await connect(() => buildProxyConfig(agent, config, verbose, egress, env), {
      ticketRequest: ticketRequestFor(agent, model, config.cwd),
      allowRemoteGateway: boolFlag(args, "allow-remote-gateway"),
      ...(gatewayUrl ? { gatewayUrl } : {}),
      env,
    })
  } catch (err) {
    if (err instanceof GatewayCredentialError || err instanceof RemoteGatewayRefusedError) {
      out.error(`\x1b[31m✗\x1b[0m ${err.message}\n`)
      return 1
    }
    out.error(`Failed to start proxy: ${(err as Error).message}\n`)
    return 1
  }

  if (gateway.mode === "node-proxy") {
    // Only the proxy uses upstream keys, so only here is a missing one a problem.
    const proxyConfig = buildProxyConfig(agent, config, verbose, egress, env)
    const requiredKey = agent === "claude" ? proxyConfig.anthropicApiKey : proxyConfig.openaiApiKey
    const providerName = agent === "claude" ? "Anthropic" : "OpenAI"
    if (!requiredKey) {
      out.error(
        `\x1b[33m⚠\x1b[0m No API key found for ${providerName}. ` +
          `The agent will receive authentication errors.\n` +
          `  Set ${agent === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} or configure a provider in ~/.cognia/config.json\n`
      )
    }
  }

  out.write(`\x1b[36m→\x1b[0m Connected via ${MODE_LABELS[gateway.mode]} (${gateway.baseUrl})\n`)

  // The agent's home: an isolated profile unless the user opts into their
  // own directory. Resolved after the gateway so a Codex profile's
  // config.toml can name the real listener.
  const launchHome = deps.launchHome ?? resolveLaunchHome
  let home: ReturnType<typeof resolveLaunchHome>
  try {
    home = launchHome({
      agent,
      cliHome: config.cliHome ?? resolveHome(env, os.homedir()),
      profile: stringFlag(args, "profile") ?? backend?.profile,
      shared: boolFlag(args, "shared-home") || backend?.sharedHome === true,
      gatewayBaseUrl: gateway.baseUrl,
      model,
      env,
    })
  } catch (err) {
    await gateway.shutdown()
    if (err instanceof LaunchProfileError) {
      out.error(`\x1b[31m✗\x1b[0m ${err.message}\n`)
      return 2
    }
    out.error(`\x1b[31m✗\x1b[0m could not prepare the agent home: ${(err as Error).message}\n`)
    return 1
  }
  out.write(`\x1b[36m→\x1b[0m Home: ${describeLaunchHome(home)}\n`)
  out.write(`\x1b[36m→\x1b[0m Launching ${agent}...\n\n`)

  // Launch agent
  const launch = deps.launch ?? launchAgent
  let exitCode: number
  try {
    exitCode = await launch({
      agent,
      model,
      gatewayBaseUrl: gateway.baseUrl,
      gatewayApiKey: gateway.apiKey,
      cwd: config.cwd,
      binaryPath: detection.path,
      homeEnv: home.env,
      proxyEnv: childProxyEnv(egress, gateway.baseUrl),
      bypass:
        boolFlag(args, "bypass") ||
        boolFlag(args, "dangerously-skip-permissions") ||
        boolFlag(args, "yes"),
      resume: stringFlag(args, "resume"),
      passthrough: extractPassthrough(args),
      ...(gateway.modelBindings ? { modelBindings: gateway.modelBindings } : {}),
      codexHomeFallback: codexHomeFallbackRequested(boolFlag(args, "codex-home-fallback")),
    })
  } catch (err) {
    out.error(`\n\x1b[31m✗\x1b[0m ${agent} failed to start: ${(err as Error).message}\n`)
    exitCode = 1
  } finally {
    await gateway.shutdown()
  }

  // Persist model choice on successful exit
  if (exitCode === 0 && model) {
    try {
      const persist = deps.persistModel ?? setAgentBackendModel
      persist(config.cliHome ?? resolveHome(env, os.homedir()), agent, model)
    } catch {
      // Non-fatal — don't fail the command if config write fails
    }
  }

  return exitCode
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the proxy config from the CLI's resolved configuration.
 * Reads API keys from the provider entries.
 */
function buildProxyConfig(
  agent: SupportedAgent,
  config: ResolvedConfig,
  verbose: boolean | undefined,
  egress: EgressProxyPlan,
  env: Record<string, string | undefined>
): ProxyConfig {
  const providers = config.providers ?? {}

  // For Claude agents, look for anthropic provider credentials
  // For Codex agents, look for openai provider credentials
  let anthropicKey: string | undefined
  let openaiKey: string | undefined

  for (const [, prov] of Object.entries(providers)) {
    if (prov.apiKey) {
      // Heuristic: match protocol to determine which key it is
      if (prov.protocol === "anthropic" || prov.baseURL?.includes("anthropic")) {
        anthropicKey ??= prov.apiKey
      }
      if (prov.protocol === "openai" || prov.baseURL?.includes("openai")) {
        openaiKey ??= prov.apiKey
      }
    }
  }

  // Also check env vars as fallback
  anthropicKey ??= env.ANTHROPIC_API_KEY
  openaiKey ??= env.OPENAI_API_KEY

  return {
    anthropicApiKey: anthropicKey,
    openaiApiKey: openaiKey,
    // Let the proxy use default upstream URLs unless the provider config overrides
    anthropicBaseUrl: findBaseUrl(providers, "anthropic"),
    openaiBaseUrl: findBaseUrl(providers, "openai"),
    verbose,
    egress: egress.kind === "proxy" ? { endpoint: egress.endpoint, bypass: egress.bypass } : null,
  }
}

/**
 * Find the base URL for a given protocol from provider entries. The config
 * field is `baseURL` (see `providerConfigSchema`), so a self-hosted or
 * relay endpoint configured there is the one the fallback proxy dials.
 */
export function findBaseUrl(
  providers: Record<string, { protocol?: string; baseURL?: string }>,
  protocol: string
): string | undefined {
  for (const [, prov] of Object.entries(providers)) {
    if (prov.protocol === protocol && prov.baseURL) {
      return prov.baseURL
    }
  }
  return undefined
}

/**
 * Extract passthrough arguments: explicit `rest` (tokens after `--`) takes
 * priority; otherwise fall back to remaining positionals after the agent name.
 */
function extractPassthrough(args: ParsedArgs): string[] {
  if (args.rest.length > 0) {
    return args.rest
  }
  // Remaining positionals after the agent name
  return args.positionals.slice(1)
}
