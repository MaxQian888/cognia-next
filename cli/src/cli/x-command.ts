/**
 * `cognia-agent x <agent>` — launch an external coding agent through cognia.
 *
 * Routes the agent's API calls through cognia's model gateway (or a local
 * fallback proxy), providing model management, credential sharing, and
 * provider routing without modifying the external tools.
 *
 * Usage:
 *   cognia-agent x claude [--model m] [--bypass] [--resume id] [--verbose] [-- <passthrough>]
 *   cognia-agent x codex  [--model m] [--bypass] [--resume id] [--verbose] [-- <passthrough>]
 */

import os from "node:os"
import { boolFlag, stringFlag, type ParsedArgs } from "./args"
import { realOutput, type OutputSink } from "./output"
import { loadConfig as defaultLoadConfig } from "../config/load"
import { setAgentBackendModel } from "../config/mutate"
import { resolveHome } from "../config/load"
import { detectAgentCli, type SupportedAgent } from "../x/detect-cli"
import { selectModel } from "../x/model-selector"
import { connectGateway, type GatewayConnection } from "../x/gateway-connect"
import { launchAgent } from "../x/agent-launcher"
import type { ProxyConfig } from "../x/proxy-server"
import type { ResolvedConfig } from "../config/schema"

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
}

const SUPPORTED_AGENTS = new Set<SupportedAgent>(["claude", "codex"])

const X_HELP = `cognia-agent x — launch external coding agents through cognia

Usage:
  cognia-agent x claude [--model m] [--bypass] [--verbose] [--resume id] [-- <passthrough args>]
  cognia-agent x codex  [--model m] [--bypass] [--verbose] [--resume id] [-- <passthrough args>]

Supported agents:
  claude    Launch Claude Code CLI (anthropic-ai/claude-code)
  codex     Launch OpenAI Codex CLI (openai/codex)

Flags:
  --model, -m       Select the model (skip interactive picker)
  --bypass, -y      Enable auto-approve mode (skip permission prompts)
  --resume <id>     Resume a previous session
  --verbose         Log proxy requests for debugging
  --                Everything after this is passed directly to the agent CLI

The agent's API calls are routed through cognia's gateway (if running) or a
local proxy, using your configured provider credentials.
`

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

  // Resolve credentials for the proxy
  const verbose = boolFlag(args, "verbose")
  const proxyConfig = buildProxyConfig(agent, config, verbose)

  // Early credential warning
  const requiredKey = agent === "claude" ? proxyConfig.anthropicApiKey : proxyConfig.openaiApiKey
  const providerName = agent === "claude" ? "Anthropic" : "OpenAI"
  if (!requiredKey) {
    out.error(
      `\x1b[33m⚠\x1b[0m No API key found for ${providerName}. ` +
        `The agent will receive authentication errors.\n` +
        `  Set ${agent === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} or configure a provider in ~/.cognia/config.json\n`
    )
  }

  // Connect to gateway
  const connect = deps.connect ?? connectGateway
  let gateway: GatewayConnection
  try {
    gateway = await connect(proxyConfig)
  } catch (err) {
    out.error(`Failed to start proxy: ${(err as Error).message}\n`)
    return 1
  }

  const modeLabel = gateway.mode === "desktop-gateway" ? "cognia gateway" : "local proxy"
  out.write(`\x1b[36m→\x1b[0m Connected via ${modeLabel} (${gateway.baseUrl})\n`)
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
      bypass:
        boolFlag(args, "bypass") ||
        boolFlag(args, "dangerously-skip-permissions") ||
        boolFlag(args, "yes"),
      resume: stringFlag(args, "resume"),
      passthrough: extractPassthrough(args),
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
      const home = resolveHome(process.env, os.homedir())
      persist(home, agent, model)
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
  verbose?: boolean
): ProxyConfig {
  const providers = config.providers ?? {}

  // For Claude agents, look for anthropic provider credentials
  // For Codex agents, look for openai provider credentials
  let anthropicKey: string | undefined
  let openaiKey: string | undefined

  for (const [, prov] of Object.entries(providers)) {
    if (prov.apiKey) {
      // Heuristic: match protocol to determine which key it is
      if (prov.protocol === "anthropic" || prov.baseUrl?.includes("anthropic")) {
        anthropicKey ??= prov.apiKey
      }
      if (prov.protocol === "openai" || prov.baseUrl?.includes("openai")) {
        openaiKey ??= prov.apiKey
      }
    }
  }

  // Also check env vars as fallback
  anthropicKey ??= process.env.ANTHROPIC_API_KEY
  openaiKey ??= process.env.OPENAI_API_KEY

  return {
    anthropicApiKey: anthropicKey,
    openaiApiKey: openaiKey,
    // Let the proxy use default upstream URLs unless the provider config overrides
    anthropicBaseUrl: findBaseUrl(providers, "anthropic"),
    openaiBaseUrl: findBaseUrl(providers, "openai"),
    verbose,
  }
}

/** Find the base URL for a given protocol from provider entries. */
function findBaseUrl(
  providers: Record<string, { protocol?: string; baseUrl?: string }>,
  protocol: string
): string | undefined {
  for (const [, prov] of Object.entries(providers)) {
    if (prov.protocol === protocol && prov.baseUrl) {
      return prov.baseUrl
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
