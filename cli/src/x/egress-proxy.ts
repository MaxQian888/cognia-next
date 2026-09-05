/**
 * The egress-proxy plan for one `cognia-agent x` launch.
 *
 * Decides, once per launch, whether outbound traffic goes through a proxy
 * and which hosts dial direct. Three inputs, in priority order:
 *   1. `--proxy <url|off>` and `--proxy-bypass <a,b>` on the command line,
 *   2. `agentBackends.<agent>.proxy` / `.proxyBypass` in the CLI config,
 *   3. the inherited `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` environment
 *      (with `NO_PROXY`).
 *
 * Two consumers read the plan and must agree:
 *   - the Node fallback proxy dials the upstream provider through it,
 *   - the agent subprocess receives it as environment, so its own non-API
 *     traffic (MCP servers, web fetch, telemetry) takes the same route.
 *
 * Whatever the source, the loopback set and the gateway's own host are
 * ALWAYS in the bypass list. The agent talks to the gateway on loopback. A
 * proxy that swallowed that hop would turn "route through cognia" into
 * "route through the proxy to nowhere", and the failure would look like a
 * dead gateway.
 */

import { redactProxyUrl, shouldBypass } from "@/lib/network/proxy-config"
import { TunnelError, parseProxyUrl, type ProxyEndpoint } from "./egress-tunnel"

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** The literal that turns the proxy off from a flag or a config field. */
export const PROXY_OFF = "off"

/** Hosts that never go through a proxy. Mirrors `DEFAULT_NETWORK_PROXY_SETTINGS.bypass`. */
export const LOOPBACK_BYPASS: readonly string[] = ["localhost", "127.0.0.1", "::1"]

/** Every casing a child process might read. */
export const PROXY_ENV_NAMES: readonly string[] = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
]

export const NO_PROXY_ENV_NAMES: readonly string[] = ["NO_PROXY", "no_proxy"]

export type EgressProxySource = "flag" | "config" | "environment"

export type EgressProxyPlan =
  | {
      kind: "proxy"
      source: EgressProxySource
      /** The proxy URL as given (may carry userinfo). Never log it raw. */
      url: string
      endpoint: ProxyEndpoint
      /** Hosts that dial direct. Always contains the loopback set. */
      bypass: string[]
    }
  | {
      kind: "direct"
      reason: "flag-off" | "config-off" | "unset"
      bypass: string[]
    }

export interface EgressProxyInput {
  /** `--proxy` value. */
  flag?: string
  /** `--proxy-bypass` value, comma separated. */
  bypassFlag?: string
  /** `agentBackends.<agent>.proxy`. */
  configured?: string
  /** `agentBackends.<agent>.proxyBypass`. */
  configuredBypass?: string[]
  env: Record<string, string | undefined>
}

/** A proxy value that cannot be used. Carries where it came from. */
export class EgressProxyError extends Error {
  constructor(
    readonly source: string,
    detail: string
  ) {
    super(`${source}: ${detail}`)
    this.name = "EgressProxyError"
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Resolution
// ────────────────────────────────────────────────────────────────────────────

function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function uniqueBypass(...groups: Array<readonly string[] | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const group of groups) {
    for (const raw of group ?? []) {
      const entry = raw.trim()
      const key = entry.toLowerCase()
      if (!entry || seen.has(key)) continue
      seen.add(key)
      out.push(entry)
    }
  }
  return out
}

function firstEnv(
  env: Record<string, string | undefined>,
  names: readonly string[]
): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value) return { name, value }
  }
  return undefined
}

function parseOrThrow(source: string, url: string): ProxyEndpoint {
  try {
    return parseProxyUrl(url)
  } catch (error) {
    const detail = error instanceof TunnelError ? error.message : String(error)
    throw new EgressProxyError(source, detail)
  }
}

/**
 * Resolve the plan. Throws `EgressProxyError` for a proxy value that cannot
 * be dialled, so the launch stops before an agent starts.
 */
export function resolveEgressProxy(input: EgressProxyInput): EgressProxyPlan {
  const flagBypass = splitList(input.bypassFlag)
  const flag = input.flag?.trim()
  if (flag) {
    if (flag.toLowerCase() === PROXY_OFF) {
      return { kind: "direct", reason: "flag-off", bypass: uniqueBypass(LOOPBACK_BYPASS) }
    }
    return {
      kind: "proxy",
      source: "flag",
      url: flag,
      endpoint: parseOrThrow("--proxy", flag),
      bypass: uniqueBypass(LOOPBACK_BYPASS, flagBypass, input.configuredBypass),
    }
  }

  const configured = input.configured?.trim()
  if (configured) {
    if (configured.toLowerCase() === PROXY_OFF) {
      return { kind: "direct", reason: "config-off", bypass: uniqueBypass(LOOPBACK_BYPASS) }
    }
    return {
      kind: "proxy",
      source: "config",
      url: configured,
      endpoint: parseOrThrow("agentBackends.<agent>.proxy", configured),
      bypass: uniqueBypass(LOOPBACK_BYPASS, flagBypass, input.configuredBypass),
    }
  }

  const inherited = firstEnv(input.env, PROXY_ENV_NAMES)
  if (inherited) {
    const noProxy = firstEnv(input.env, NO_PROXY_ENV_NAMES)
    return {
      kind: "proxy",
      source: "environment",
      url: inherited.value,
      endpoint: parseOrThrow(inherited.name, inherited.value),
      bypass: uniqueBypass(
        LOOPBACK_BYPASS,
        flagBypass,
        input.configuredBypass,
        splitList(noProxy?.value)
      ),
    }
  }

  return { kind: "direct", reason: "unset", bypass: uniqueBypass(LOOPBACK_BYPASS, flagBypass) }
}

// ────────────────────────────────────────────────────────────────────────────
// Consumers
// ────────────────────────────────────────────────────────────────────────────

/** Whether the plan routes `targetUrl` through the proxy. */
export function routesThroughProxy(plan: EgressProxyPlan, targetUrl: string): boolean {
  if (plan.kind !== "proxy") return false
  return !shouldBypass(targetUrl, plan.bypass)
}

export interface ChildProxyEnv {
  /** Variables to set on the child. */
  set: Record<string, string>
  /** Variables the child must NOT inherit from this process. */
  unset: string[]
}

/**
 * The environment the agent subprocess receives for its own traffic. The
 * gateway host is added to the bypass list here, because it is only known
 * after the gateway connected.
 */
export function childProxyEnv(plan: EgressProxyPlan, gatewayBaseUrl: string): ChildProxyEnv {
  let gatewayHost: string | undefined
  try {
    gatewayHost = new URL(gatewayBaseUrl).hostname.replace(/^\[|\]$/g, "")
  } catch {
    gatewayHost = undefined
  }
  if (plan.kind === "direct") {
    if (plan.reason === "unset") return { set: {}, unset: [] }
    // Explicitly off: the child must not pick up this process's proxy.
    return { set: {}, unset: [...PROXY_ENV_NAMES] }
  }
  const bypass = uniqueBypass(plan.bypass, gatewayHost ? [gatewayHost] : []).join(",")
  const set: Record<string, string> = {}
  for (const name of PROXY_ENV_NAMES) set[name] = plan.url
  for (const name of NO_PROXY_ENV_NAMES) set[name] = bypass
  return { set, unset: [] }
}

/** One line for the launch banner. Credentials are redacted. */
export function describeEgressProxy(plan: EgressProxyPlan): string {
  if (plan.kind === "direct") {
    switch (plan.reason) {
      case "flag-off":
        return "direct (--proxy off)"
      case "config-off":
        return "direct (proxy: off in config)"
      default:
        return "direct (no proxy configured)"
    }
  }
  const origin: Record<EgressProxySource, string> = {
    flag: "--proxy",
    config: "config",
    environment: "environment",
  }
  return `${redactProxyUrl(plan.url)} via ${origin[plan.source]}, bypass: ${plan.bypass.join(",")}`
}
