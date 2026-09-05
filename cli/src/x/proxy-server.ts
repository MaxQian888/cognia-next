/**
 * Lightweight Node.js HTTP proxy for `cognia x <agent>`.
 *
 * Serves as a Tier-1 fallback when the full Rust gateway (cognia-gateway) is
 * not running. The proxy listens on loopback, accepts requests on Anthropic
 * (`/v1/messages`) and OpenAI (`/v1/chat/completions`) endpoints, injects the
 * real API key from the CLI's credential store, and forwards to the upstream
 * provider with full SSE streaming passthrough.
 *
 * Security: loopback-only binding (127.0.0.1); no CORS; the ephemeral API key
 * is a random string valid only for the proxy's lifetime.
 */

import http from "node:http"
import https from "node:https"
import { randomBytes } from "node:crypto"
import { URL } from "node:url"

import { shouldBypass } from "@/lib/network/proxy-config"
import { createTunnelAgent, formatAuthority, type ProxyEndpoint } from "./egress-tunnel"

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface ProxyConfig {
  /** Upstream base URL for Anthropic API (default: https://api.anthropic.com) */
  anthropicBaseUrl?: string
  /** Upstream base URL for OpenAI API (default: https://api.openai.com) */
  openaiBaseUrl?: string
  /** Real Anthropic API key to inject on upstream requests. */
  anthropicApiKey?: string
  /** Real OpenAI API key to inject on upstream requests. */
  openaiApiKey?: string
  /** When true, log each proxied request to stderr for debugging. */
  verbose?: boolean
  /**
   * Outbound proxy for the upstream hop (`egress-proxy.ts`). Hosts in
   * `bypass` dial direct. Absent: every upstream dials direct.
   */
  egress?: { endpoint: ProxyEndpoint; bypass: string[] } | null
  /** Injectable fetch for the `/v1/models` upstream listing (tests). */
  fetch?: JsonFetch
}

/** The slice of `fetch` the models listing needs. Real `fetch` satisfies it. */
export type JsonFetch = (
  url: string,
  init: { headers: Record<string, string> }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface ProxyServer {
  /** The URL clients should set as base URL (e.g. http://127.0.0.1:54321). */
  baseUrl: string
  /** Ephemeral API key clients must send (loopback-only, but defense in depth). */
  apiKey: string
  /** Port the server is listening on. */
  port: number
  /** Graceful shutdown — waits up to 5s for in-flight requests to drain. */
  shutdown: () => Promise<void>
}

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

// `count_tokens` too: Claude Code sizes its context window with it before
// every turn, and a 404 there reads as a dead base URL.
const ANTHROPIC_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"])
const OPENAI_PATHS = new Set(["/v1/chat/completions", "/v1/responses"])

/** Maximum request body size: 16 MiB (matching the Rust gateway). */
const MAX_BODY_BYTES = 16 * 1024 * 1024

/** Upstream idle timeout: 5 minutes (no data received → abort). */
const UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** Graceful shutdown drain timeout: 5 seconds. */
const SHUTDOWN_DRAIN_MS = 5_000

/** One upstream's `/v1/models` answer, normalized to the OpenAI list shape. */
interface ModelRow {
  id: string
  object: "model"
  created: number
  owned_by: string
}

/**
 * `/v1/models` is answered from the UPSTREAMS this proxy is configured for,
 * never from a hard-coded list: a list that names models the configured key
 * cannot reach only teaches the agent to request them. Each configured
 * upstream is asked; a failed one is skipped and reported in `errors`.
 */
async function listUpstreamModels(
  config: ProxyConfig,
  anthropicBase: string,
  openaiBase: string,
  fetchImpl: JsonFetch
): Promise<{ data: ModelRow[]; errors: string[] }> {
  const data: ModelRow[] = []
  const errors: string[] = []
  const sources: Array<{ url: string; headers: Record<string, string>; ownedBy: string }> = []
  if (config.anthropicApiKey) {
    sources.push({
      url: `${anthropicBase}/v1/models`,
      headers: { "x-api-key": config.anthropicApiKey, "anthropic-version": "2023-06-01" },
      ownedBy: "anthropic",
    })
  }
  if (config.openaiApiKey) {
    sources.push({
      url: `${openaiBase}/v1/models`,
      headers: { authorization: `Bearer ${config.openaiApiKey}` },
      ownedBy: "openai",
    })
  }
  for (const source of sources) {
    try {
      const res = await fetchImpl(source.url, { headers: source.headers })
      if (!res.ok) {
        errors.push(`${source.ownedBy}: HTTP ${res.status}`)
        continue
      }
      const body = (await res.json()) as {
        data?: Array<{ id?: string; created?: number; created_at?: string; owned_by?: string }>
      }
      for (const row of body.data ?? []) {
        if (!row.id) continue
        data.push({
          id: row.id,
          object: "model",
          created:
            row.created ?? (row.created_at ? Math.floor(Date.parse(row.created_at) / 1000) : 0),
          owned_by: row.owned_by ?? source.ownedBy,
        })
      }
    } catch (error) {
      errors.push(`${source.ownedBy}: ${(error as Error).message}`)
    }
  }
  return { data, errors }
}

// ────────────────────────────────────────────────────────────────────────────
// Egress
// ────────────────────────────────────────────────────────────────────────────

/** Picks the agent an upstream URL dials through: the tunnel, or none (direct). */
interface EgressAgents {
  agentFor: (url: URL) => http.Agent | undefined
  describe: (url: URL) => string
  destroy: () => void
}

function createEgressAgents(egress: ProxyConfig["egress"]): EgressAgents {
  if (!egress) {
    return { agentFor: () => undefined, describe: () => "direct", destroy: () => {} }
  }
  const { endpoint, bypass } = egress
  const label = `proxy ${endpoint.protocol}://${formatAuthority(endpoint.host, endpoint.port)}`
  // One pooled agent per target scheme, created on first use.
  const agents = new Map<"http:" | "https:", http.Agent>()
  const routed = (url: URL) => !shouldBypass(url.href, bypass)
  return {
    agentFor: (url) => {
      if (!routed(url)) return undefined
      const scheme = url.protocol === "https:" ? "https:" : "http:"
      let agent = agents.get(scheme)
      if (!agent) {
        agent = createTunnelAgent(endpoint, scheme === "https:")
        agents.set(scheme, agent)
      }
      return agent
    },
    describe: (url) => (routed(url) ? label : "direct (bypass)"),
    destroy: () => {
      for (const agent of agents.values()) agent.destroy()
      agents.clear()
    },
  }
}

/**
 * A `fetch`-shaped GET over `http(s).request` so the models listing takes the
 * same egress route as the chat traffic. Global `fetch` (undici) would ignore
 * the tunnel agent and dial the upstream direct.
 */
function agentJsonFetch(agentFor: (url: URL) => http.Agent | undefined): JsonFetch {
  return (rawUrl, init) =>
    new Promise((resolve, reject) => {
      const url = new URL(rawUrl)
      const transport = url.protocol === "https:" ? https : http
      const req = transport.request(
        url,
        { method: "GET", headers: init.headers, agent: agentFor(url) },
        (res) => {
          const chunks: Buffer[] = []
          res.on("data", (chunk: Buffer) => chunks.push(chunk))
          res.on("end", () => {
            const status = res.statusCode ?? 0
            const text = Buffer.concat(chunks).toString("utf8")
            resolve({
              ok: status >= 200 && status < 300,
              status,
              json: async () => JSON.parse(text) as unknown,
            })
          })
          res.on("error", reject)
        }
      )
      req.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => req.destroy(new Error("timed out")))
      req.on("error", reject)
      req.end()
    })
}

// ────────────────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Start the proxy server. Resolves once the server is listening.
 *
 * @param config - Upstream URLs and real API keys.
 * @returns A handle with the local base URL, ephemeral API key, and shutdown.
 */
export async function startProxyServer(config: ProxyConfig): Promise<ProxyServer> {
  const ephemeralKey = `cgx-${randomBytes(16).toString("hex")}`
  const anthropicBase = config.anthropicBaseUrl ?? "https://api.anthropic.com"
  const openaiBase = config.openaiBaseUrl ?? "https://api.openai.com"
  const verbose = config.verbose ?? false
  const egress = createEgressAgents(config.egress)
  const modelsFetch: JsonFetch = config.fetch ?? agentJsonFetch(egress.agentFor)

  // Track active responses for graceful shutdown
  const activeResponses = new Set<http.ServerResponse>()

  const server = http.createServer((req, res) => {
    activeResponses.add(res)
    res.on("close", () => activeResponses.delete(res))

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    const pathname = url.pathname

    // Health probe (no auth)
    if (req.method === "GET" && (pathname === "/healthz" || pathname === "/")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ status: "ok", proxy: "cognia-x" }))
      return
    }

    // Models list — proxied from the configured upstreams.
    if (req.method === "GET" && pathname === "/v1/models") {
      void listUpstreamModels(config, anthropicBase, openaiBase, modelsFetch).then(
        ({ data, errors }) => {
          if (data.length === 0 && errors.length > 0) {
            res.writeHead(502, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                error: {
                  message: `no upstream answered /v1/models: ${errors.join("; ")}`,
                  type: "upstream_error",
                },
              })
            )
            return
          }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(
            JSON.stringify({ object: "list", data, ...(errors.length ? { warnings: errors } : {}) })
          )
        }
      )
      return
    }

    // Auth check — require the ephemeral key (defense in depth; already loopback).
    const authHeader = req.headers.authorization ?? ""
    const xApiKey = req.headers["x-api-key"] as string | undefined
    const providedKey =
      xApiKey ?? (authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined)
    if (providedKey !== ephemeralKey) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Invalid API key", type: "auth_error" } }))
      return
    }

    // Route to upstream
    let upstreamBase: string
    let upstreamKey: string | undefined
    let upstreamAuthScheme: "x-api-key" | "bearer"

    if (ANTHROPIC_PATHS.has(pathname)) {
      upstreamBase = anthropicBase
      upstreamKey = config.anthropicApiKey
      upstreamAuthScheme = "x-api-key"
    } else if (OPENAI_PATHS.has(pathname)) {
      upstreamBase = openaiBase
      upstreamKey = config.openaiApiKey
      upstreamAuthScheme = "bearer"
    } else {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(
        JSON.stringify({ error: { message: `Unknown path: ${pathname}`, type: "not_found" } })
      )
      return
    }

    if (!upstreamKey) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: {
            message: "No upstream API key configured for this endpoint",
            type: "config_error",
          },
        })
      )
      return
    }

    // Preserve query parameters when forwarding
    const fullPath = pathname + url.search
    const upstreamUrl = new URL(fullPath, upstreamBase)
    proxyRequest(req, res, {
      upstreamBase,
      upstreamKey,
      upstreamAuthScheme,
      path: fullPath,
      verbose,
      agent: egress.agentFor(upstreamUrl),
      route: egress.describe(upstreamUrl),
    })
  })

  // Bind to loopback with port 0 (OS picks a free port)
  return new Promise((resolve, reject) => {
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") {
        server.close()
        reject(new Error("Failed to get server address"))
        return
      }
      const port = addr.port
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: ephemeralKey,
        port,
        shutdown: async () => {
          egress.destroy()
          return new Promise<void>((res) => {
            server.close(() => res())
            // Graceful drain: wait for in-flight to finish (max 5s)
            const deadline = setTimeout(() => {
              // Force-destroy remaining connections
              for (const resp of activeResponses) {
                resp.destroy()
              }
              activeResponses.clear()
              res()
            }, SHUTDOWN_DRAIN_MS)
            // If all connections close naturally before the deadline, resolve early
            const check = setInterval(() => {
              if (activeResponses.size === 0) {
                clearInterval(check)
                clearTimeout(deadline)
                res()
              }
            }, 50)
          })
        },
      })
    })
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Proxy pipeline (streaming-aware)
// ────────────────────────────────────────────────────────────────────────────

interface ProxyTarget {
  upstreamBase: string
  upstreamKey: string
  upstreamAuthScheme: "x-api-key" | "bearer"
  path: string
  verbose?: boolean
  /** Tunnel agent for the upstream hop. Absent: dial direct. */
  agent?: http.Agent
  /** How the hop is routed, for the verbose log. */
  route?: string
}

function proxyRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  target: ProxyTarget
): void {
  const upstreamUrl = new URL(target.path, target.upstreamBase)
  const isHttps = upstreamUrl.protocol === "https:"
  const transport = isHttps ? https : http

  // Build upstream headers — forward content-type & accept, inject auth
  const upstreamHeaders: Record<string, string> = {
    "content-type": clientReq.headers["content-type"] ?? "application/json",
    accept: clientReq.headers.accept ?? "application/json",
  }

  // Copy anthropic-specific headers
  for (const key of Object.keys(clientReq.headers)) {
    if (key.startsWith("anthropic-") || key === "x-stainless-arch") {
      upstreamHeaders[key] = clientReq.headers[key] as string
    }
  }

  // Inject the real API key
  if (target.upstreamAuthScheme === "x-api-key") {
    upstreamHeaders["x-api-key"] = target.upstreamKey
  } else {
    upstreamHeaders.authorization = `Bearer ${target.upstreamKey}`
  }

  if (target.verbose) {
    process.stderr.write(
      `[cognia-x] → ${clientReq.method} ${target.path} → ${upstreamUrl.origin} (${target.route ?? "direct"})\n`
    )
  }

  const proxyReq = transport.request(
    upstreamUrl,
    {
      method: clientReq.method,
      headers: upstreamHeaders,
      ...(target.agent ? { agent: target.agent } : {}),
    },
    (proxyRes) => {
      if (target.verbose) {
        process.stderr.write(
          `[cognia-x] ← ${proxyRes.statusCode} ${clientReq.method} ${target.path}\n`
        )
      }

      // Pass through status and headers from upstream
      const responseHeaders: Record<string, string | string[]> = {}
      for (const [key, val] of Object.entries(proxyRes.headers)) {
        if (val !== undefined) {
          responseHeaders[key] = val as string | string[]
        }
      }
      clientRes.writeHead(proxyRes.statusCode ?? 502, responseHeaders)

      // Reset idle timeout on each data chunk (keeps active SSE streams alive)
      proxyRes.on("data", (chunk: Buffer) => {
        proxyReq.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS)
        clientRes.write(chunk)
      })
      proxyRes.on("end", () => {
        clientRes.end()
      })
      proxyRes.on("error", () => {
        clientRes.end()
      })
    }
  )

  // Set upstream idle timeout — abort if no response within the window
  proxyReq.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
    proxyReq.destroy()
    if (!clientRes.headersSent) {
      clientRes.writeHead(504, { "content-type": "application/json" })
      clientRes.end(
        JSON.stringify({
          error: { message: "Upstream request timed out", type: "timeout_error" },
        })
      )
    } else {
      clientRes.end()
    }
  })

  proxyReq.on("error", (err) => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "content-type": "application/json" })
      clientRes.end(
        JSON.stringify({
          error: { message: `Upstream error: ${err.message}`, type: "proxy_error" },
        })
      )
    } else {
      clientRes.end()
    }
  })

  // Pipe the client request body to the upstream with size limit
  let bytesReceived = 0
  clientReq.on("data", (chunk: Buffer) => {
    bytesReceived += chunk.length
    if (bytesReceived > MAX_BODY_BYTES) {
      proxyReq.destroy()
      if (!clientRes.headersSent) {
        clientRes.writeHead(413, { "content-type": "application/json" })
        clientRes.end(
          JSON.stringify({
            error: {
              message: `Request body too large (max ${MAX_BODY_BYTES / 1024 / 1024} MiB)`,
              type: "payload_too_large",
            },
          })
        )
      }
      clientReq.destroy()
      return
    }
    proxyReq.write(chunk)
  })
  clientReq.on("end", () => {
    proxyReq.end()
  })
  clientReq.on("error", () => {
    proxyReq.destroy()
  })
}
