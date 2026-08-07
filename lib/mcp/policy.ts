import type { McpServer } from "@cognia/agent-config-types"

export type McpExecutionSurface = "chat" | "workflow" | "plan" | "cli" | "settings" | "agent-sync"
export type McpPolicyDecision = "allow" | "deny" | "ask"

export interface McpExecutionGrant {
  serverId: string
  fingerprint: string
  /** Empty/omitted means the whole reviewed server. */
  tools?: string[]
  expiresAt?: number
}

export interface McpPolicyResult {
  decision: McpPolicyDecision
  reason: string
}

export function evaluateMcpPolicy(input: {
  server: McpServer
  surface: McpExecutionSurface
  interactive: boolean
  toolName?: string
  fingerprint?: string
  grant?: McpExecutionGrant
  now?: number
}): McpPolicyResult {
  const state = input.server.trust?.state ?? "legacy"
  if (state === "blocked") return { decision: "deny", reason: "server trust is blocked" }
  if (state === "trusted" || state === "legacy") {
    return {
      decision: "allow",
      reason: state === "legacy" ? "legacy compatibility grant" : "trusted server",
    }
  }

  const grant = input.grant
  const now = input.now ?? Date.now()
  const toolAllowed =
    !grant?.tools?.length || (Boolean(input.toolName) && grant.tools.includes(input.toolName!))
  if (
    grant?.serverId === input.server.id &&
    Boolean(input.fingerprint) &&
    grant.fingerprint === input.fingerprint &&
    (grant.expiresAt === undefined || grant.expiresAt > now) &&
    toolAllowed
  ) {
    return { decision: "allow", reason: "fingerprint-scoped execution grant" }
  }
  if (input.interactive) return { decision: "ask", reason: "server trust review required" }
  return {
    decision: "deny",
    reason: `pending MCP server cannot execute non-interactively on ${input.surface}`,
  }
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split(".")
  if (parts.length !== 4) return null
  const bytes = parts.map(Number)
  return bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? bytes : null
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "::" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1"
  )
    return true
  if (
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe8") ||
    host.startsWith("fe9") ||
    host.startsWith("fea") ||
    host.startsWith("feb") ||
    host.startsWith("ff") ||
    host.startsWith("2001:db8:") ||
    host.startsWith("::ffff:")
  ) {
    return true
  }
  const ip = parseIpv4(host)
  if (!ip) return false
  const [a, b, c] = ip
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

/** Validate the configured endpoint before any remote MCP/OAuth request. */
export function validateMcpRemoteEgress(value: string, allowPrivateNetwork: boolean): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("MCP remote endpoint is not a valid URL")
  }
  if (url.protocol !== "https:" && !allowPrivateNetwork) {
    throw new Error("MCP remote endpoints require HTTPS")
  }
  if (isPrivateHostname(url.hostname) && !allowPrivateNetwork) {
    throw new Error("MCP remote endpoint resolves to a private or reserved address")
  }
  if (url.protocol !== "https:" && !isPrivateHostname(url.hostname)) {
    throw new Error("MCP remote endpoints require HTTPS")
  }
  return url
}
