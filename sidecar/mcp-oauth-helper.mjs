/**
 * Interactive OAuth helper for remote (sse/http) MCP servers, spawned by the
 * desktop `mcp_oauth_authenticate` / `mcp_oauth_refresh` Tauri commands.
 *
 * Protocol (one JSON line in / one JSON line out):
 *   stdin:  { serverName, server: { transport, config }, entry }
 *   argv:   "authenticate" | "refresh"
 *   stdout: { result: { ok, status, message }, entry: <updated McpAuthEntry> }
 *           (browser-hint lines `{ "open": "<url>" }` may precede it)
 *
 * The flow mirrors the CLI's tested `authenticateMcpServer`
 * (`cli/src/mcp/oauth-flow.ts`): a loopback callback server captures the
 * redirect, an in-memory `OAuthClientProvider` (seeded from `entry`) reads /
 * writes tokens, and the SDK transport drives PKCE + dynamic registration.
 * Token state is returned to Rust, which persists it to the OS keyring — the
 * helper never touches the keyring or any config file.
 */
import nodeHttp from "node:http"
import nodeDns from "node:dns"
import nodePath from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import { Agent } from "undici"

function parseIpv4(hostname) {
  const parts = hostname.split(".")
  if (parts.length !== 4) return null
  const bytes = parts.map(Number)
  return bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? bytes : null
}

/** Fail-closed classification shared by configured, discovered, and token URLs. */
export function isPrivateOrReservedHost(hostname) {
  const host = String(hostname)
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "::" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1"
  ) {
    return true
  }
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

export function validateRemoteUrl(value, allowPrivateNetwork = false) {
  let url
  try {
    url = value instanceof URL ? value : new URL(String(value))
  } catch {
    throw new Error("MCP OAuth endpoint is not a valid URL")
  }
  const privateTarget = isPrivateOrReservedHost(url.hostname)
  if (url.protocol !== "https:" && !(allowPrivateNetwork && privateTarget)) {
    throw new Error("MCP OAuth endpoints require HTTPS")
  }
  if (privateTarget && !allowPrivateNetwork) {
    throw new Error("MCP OAuth endpoint resolves to a private or reserved address")
  }
  return url
}

function guardedLookup(allowPrivateNetwork, lookup = nodeDns.lookup) {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error)
        return
      }
      const rows = Array.isArray(addresses) ? addresses : []
      if (rows.length === 0) {
        callback(new Error(`MCP OAuth DNS lookup returned no addresses for ${hostname}`))
        return
      }
      if (!allowPrivateNetwork && rows.some((row) => isPrivateOrReservedHost(row.address))) {
        callback(
          new Error(`MCP OAuth DNS lookup blocked a private or reserved address for ${hostname}`)
        )
        return
      }
      if (options?.all) callback(null, rows)
      else callback(null, rows[0].address, rows[0].family)
    })
  }
}

/**
 * Build one fetch seam for every transport, discovery, registration, refresh,
 * and token request. The socket's actual DNS lookup is guarded by the Undici
 * dispatcher, avoiding a validate-then-resolve rebinding window.
 */
export function createEgressGuard({
  allowPrivateNetwork = false,
  fetchImpl = globalThis.fetch,
  lookup = nodeDns.lookup,
  AgentCtor = Agent,
} = {}) {
  let dispatcher
  const getDispatcher = () => {
    if (allowPrivateNetwork) return undefined
    dispatcher ??= new AgentCtor({ connect: { lookup: guardedLookup(false, lookup) } })
    return dispatcher
  }
  return {
    fetch: (input, init = {}) => {
      const value = typeof Request !== "undefined" && input instanceof Request ? input.url : input
      validateRemoteUrl(value, allowPrivateNetwork)
      const activeDispatcher = getDispatcher()
      return fetchImpl(input, {
        ...init,
        redirect: "error",
        ...(activeDispatcher ? { dispatcher: activeDispatcher } : {}),
      })
    },
    close: async () => {
      await dispatcher?.close?.()
    },
  }
}

/** Parse the OAuth redirect query into a result object. (Pure — tested.) */
export function parseCallback(requestUrl) {
  let query
  try {
    query = new URL(requestUrl, "http://127.0.0.1").searchParams
  } catch {
    return {}
  }
  return {
    code: query.get("code") ?? undefined,
    state: query.get("state") ?? undefined,
    error: query.get("error") ?? undefined,
    errorDescription: query.get("error_description") ?? undefined,
  }
}

/** 16 hex chars of CSRF state (the redirect is loopback). (Pure — tested.) */
export function randomState() {
  let s = ""
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

/**
 * Build an in-memory `OAuthClientProvider` over a mutable `state` object
 * (seeded from the stored entry). Mirrors `cli/src/mcp/oauth-provider.ts` but
 * keeps everything in memory — Rust persists the final `state` to the keyring.
 * (Pure given its deps — the provider object is unit-tested.)
 */
export function buildProvider(state, deps) {
  const metadata = {
    client_name: deps.clientName ?? "Cognia",
    redirect_uris: [deps.redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(deps.scope ? { scope: deps.scope } : {}),
  }
  return {
    get redirectUrl() {
      return deps.redirectUrl
    },
    get clientMetadata() {
      return metadata
    },
    state() {
      return deps.state ?? ""
    },
    clientInformation() {
      return state.clientInformation
    },
    saveClientInformation(info) {
      state.clientInformation = info
    },
    tokens() {
      return state.tokens
    },
    saveTokens(tokens) {
      state.tokens = tokens
      state.codeVerifier = undefined
      // Stamp absolute expiry so the renderer can show / proactively act on it.
      if (tokens && typeof tokens.expires_in === "number") {
        state.expiresAtMs = Date.now() + tokens.expires_in * 1000
      }
    },
    redirectToAuthorization(url) {
      return deps.onRedirect(url)
    },
    saveCodeVerifier(verifier) {
      state.codeVerifier = verifier
    },
    codeVerifier() {
      if (!state.codeVerifier) throw new Error("No PKCE code verifier saved")
      return state.codeVerifier
    },
  }
}

/** Start a loopback callback server; resolves once listening. */
function startCallbackServer() {
  return new Promise((resolve, reject) => {
    let settle
    let fail
    let captured
    let capturedError
    const path = "/callback"
    const server = nodeHttp.createServer((req, res) => {
      if (!req.url || !req.url.startsWith(path)) {
        res.statusCode = 404
        res.end("Not found")
        return
      }
      const result = parseCallback(req.url)
      res.statusCode = result.error ? 400 : 200
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:2rem"><h2>${
          result.error ? "Authorization failed" : "Authorization complete"
        }</h2><p>You can close this tab.</p></body>`
      )
      if (result.error) {
        const err = new Error(`Authorization denied: ${result.error}`)
        if (fail) fail(err)
        else capturedError = err
      } else if (settle) settle(result)
      else captured = result
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      resolve({
        redirectUrl: `http://127.0.0.1:${port}${path}`,
        waitForCode: (timeoutMs) =>
          new Promise((res2, rej2) => {
            if (capturedError) return rej2(capturedError)
            if (captured) return res2(captured)
            settle = res2
            fail = rej2
            const t = setTimeout(() => rej2(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
            if (typeof t === "object" && "unref" in t) t.unref()
          }),
        close: () => server.close(),
      })
    })
  })
}

/** Open a URL in the OS browser (best-effort, cross-platform). */
function openBrowser(url) {
  const cmd =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref()
  } catch {
    // Non-fatal — the URL is also printed as an `{open}` hint for the renderer.
  }
}

/** Lazily load the SDK client + remote transports. */
async function loadSdk() {
  const [{ Client }, { StreamableHTTPClientTransport }, { SSEClientTransport }] = await Promise.all(
    [
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
      import("@modelcontextprotocol/sdk/client/sse.js"),
    ]
  )
  return { Client, StreamableHTTPClientTransport, SSEClientTransport }
}

function buildTransport(sdk, server, authProvider, guardedFetch) {
  const allowPrivateNetwork = server.config?.allowPrivateNetwork === true
  const url = validateRemoteUrl(server.config?.url, allowPrivateNetwork)
  const headers =
    server.config?.headers && typeof server.config.headers === "object"
      ? server.config.headers
      : undefined
  const opts = {
    fetch: guardedFetch,
    requestInit: { ...(headers ? { headers } : {}), redirect: "error" },
  }
  if (authProvider) opts.authProvider = authProvider
  const Ctor =
    server.transport === "sse" ? sdk.SSEClientTransport : sdk.StreamableHTTPClientTransport
  return new Ctor(url, Object.keys(opts).length ? opts : undefined)
}

function isUnauthorized(err) {
  const name = err && typeof err === "object" ? String(err.name ?? "") : ""
  return name === "UnauthorizedError" || /unauthor/i.test(String(err?.message ?? ""))
}

/**
 * Run the flow. Returns `{ result, entry }`. Never throws — every failure mode
 * is a structured result. `mode` is "authenticate" (interactive) or "refresh"
 * (silent, refresh-token only).
 */
export async function runFlow({ server, entry, mode }, deps = {}) {
  if (server?.transport === "stdio") {
    return {
      result: { ok: false, status: "unsupported", message: "OAuth applies to sse/http only" },
      entry,
    }
  }
  const state = { ...(entry ?? {}) }
  const allowPrivateNetwork = server?.config?.allowPrivateNetwork === true
  let egress
  try {
    validateRemoteUrl(server?.config?.url, allowPrivateNetwork)
    egress = (deps.createEgressGuard ?? createEgressGuard)({
      allowPrivateNetwork,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.lookup ? { lookup: deps.lookup } : {}),
      ...(deps.AgentCtor ? { AgentCtor: deps.AgentCtor } : {}),
    })
  } catch (err) {
    return {
      result: { ok: false, status: "error", message: `egress blocked: ${msg(err)}` },
      entry: state,
    }
  }
  const start = deps.startCallbackServer ?? startCallbackServer
  const open = deps.openBrowser ?? openBrowser
  const onAuthUrl =
    deps.onAuthUrl ?? ((url) => process.stdout.write(JSON.stringify({ open: url }) + "\n"))
  const timeoutMs = deps.timeoutMs ?? 180_000
  let sdk
  try {
    sdk = deps.sdk ?? (await loadSdk())
  } catch (err) {
    await egress.close().catch(() => undefined)
    return {
      result: { ok: false, status: "error", message: `SDK load failed: ${msg(err)}` },
      entry: state,
    }
  }
  const csrf = (deps.randomState ?? randomState)()

  let callback
  try {
    callback = await start()
  } catch (err) {
    await egress.close().catch(() => undefined)
    return {
      result: { ok: false, status: "error", message: `callback server: ${msg(err)}` },
      entry: state,
    }
  }

  let client
  try {
    const provider = buildProvider(state, {
      redirectUrl: callback.redirectUrl,
      scope: server.config?.scope,
      state: csrf,
      onRedirect: async (url) => {
        const authorizationUrl = validateRemoteUrl(url, allowPrivateNetwork)
        onAuthUrl(authorizationUrl.href)
        if (mode === "authenticate") open(authorizationUrl.href)
      },
    })
    const transport = buildTransport(sdk, server, provider, egress.fetch)
    client = new sdk.Client({ name: "cognia-mcp-oauth", version: "1.0.0" }, { capabilities: {} })

    try {
      await client.connect(transport)
      return {
        result: { ok: true, status: "authorized", message: "already authorized" },
        entry: state,
      }
    } catch (err) {
      if (mode === "refresh") {
        return {
          result: { ok: false, status: "error", message: `refresh failed: ${msg(err)}` },
          entry: state,
        }
      }
      if (!isUnauthorized(err)) {
        return {
          result: { ok: false, status: "error", message: `connect failed: ${msg(err)}` },
          entry: state,
        }
      }
      // UnauthorizedError → the provider opened the browser; await the redirect.
    }

    let redirect
    try {
      redirect = await callback.waitForCode(timeoutMs)
    } catch (err) {
      return { result: { ok: false, status: "denied", message: msg(err) }, entry: state }
    }
    if (redirect.state && redirect.state !== csrf) {
      return {
        result: { ok: false, status: "error", message: "OAuth state mismatch (CSRF)" },
        entry: state,
      }
    }
    if (!redirect.code) {
      return {
        result: { ok: false, status: "denied", message: "no authorization code" },
        entry: state,
      }
    }
    if (typeof transport.finishAuth !== "function") {
      return {
        result: { ok: false, status: "error", message: "transport has no finishAuth" },
        entry: state,
      }
    }
    try {
      await transport.finishAuth(redirect.code)
      await client.connect(transport)
    } catch (err) {
      return {
        result: { ok: false, status: "error", message: `token exchange: ${msg(err)}` },
        entry: state,
      }
    }
    return { result: { ok: true, status: "authorized", message: "authorized" }, entry: state }
  } finally {
    await client?.close?.().catch(() => undefined)
    callback.close()
    await egress.close().catch(() => undefined)
  }
}

export async function prepareHeadlessFlow({ server, entry, redirectUrl, state: csrf }, deps = {}) {
  if (!/^[0-9a-f]{64}$/i.test(String(csrf ?? ""))) {
    return {
      result: { ok: false, status: "error", message: "invalid 256-bit OAuth state" },
      entry: entry ?? {},
    }
  }
  return runHeadlessStage(
    { server, entry, redirectUrl, csrf },
    deps,
    async ({ client, transport, authState, getAuthorizationUrl }) => {
      try {
        await client.connect(transport)
        return {
          result: { ok: true, status: "authorized", message: "already authorized" },
          entry: authState,
        }
      } catch (err) {
        if (!isUnauthorized(err)) {
          return {
            result: { ok: false, status: "error", message: `connect failed: ${msg(err)}` },
            entry: authState,
          }
        }
        const authorizationUrl = getAuthorizationUrl()
        if (!authorizationUrl) {
          return {
            result: {
              ok: false,
              status: "error",
              message: "authorization server returned no authorization URL",
            },
            entry: authState,
          }
        }
        return {
          result: { ok: true, status: "pending", message: "authorization required" },
          authorizationUrl,
          entry: authState,
        }
      }
    }
  )
}

export async function completeHeadlessFlow(
  { server, entry, redirectUrl, state: csrf, code },
  deps = {}
) {
  if (typeof code !== "string" || code.length === 0 || code.length > 8192) {
    return {
      result: { ok: false, status: "error", message: "invalid authorization code" },
      entry: entry ?? {},
    }
  }
  return runHeadlessStage(
    { server, entry, redirectUrl, csrf },
    deps,
    async ({ client, transport, authState }) => {
      if (typeof transport.finishAuth !== "function") {
        return {
          result: { ok: false, status: "error", message: "transport has no finishAuth" },
          entry: authState,
        }
      }
      try {
        await transport.finishAuth(code)
        await client.connect(transport)
        return {
          result: { ok: true, status: "authorized", message: "authorized" },
          entry: authState,
        }
      } catch (err) {
        return {
          result: { ok: false, status: "error", message: `token exchange: ${msg(err)}` },
          entry: authState,
        }
      }
    }
  )
}

async function runHeadlessStage(input, deps, stage) {
  const { server, redirectUrl, csrf } = input
  const authState = { ...(input.entry ?? {}) }
  if (server?.transport === "stdio") {
    return {
      result: { ok: false, status: "unsupported", message: "OAuth applies to sse/http only" },
      entry: authState,
    }
  }
  let parsedRedirect
  let egress
  try {
    parsedRedirect = new URL(String(redirectUrl))
    if (
      parsedRedirect.protocol !== "https:" &&
      parsedRedirect.hostname !== "127.0.0.1" &&
      parsedRedirect.hostname !== "localhost"
    ) {
      throw new Error("Headless OAuth redirect requires HTTPS")
    }
    const allowPrivateNetwork = server?.config?.allowPrivateNetwork === true
    validateRemoteUrl(server?.config?.url, allowPrivateNetwork)
    egress = (deps.createEgressGuard ?? createEgressGuard)({
      allowPrivateNetwork,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.lookup ? { lookup: deps.lookup } : {}),
      ...(deps.AgentCtor ? { AgentCtor: deps.AgentCtor } : {}),
    })
  } catch (err) {
    return {
      result: { ok: false, status: "error", message: `egress blocked: ${msg(err)}` },
      entry: authState,
    }
  }
  let sdk
  try {
    sdk = deps.sdk ?? (await loadSdk())
  } catch (err) {
    await egress.close().catch(() => undefined)
    return {
      result: { ok: false, status: "error", message: `SDK load failed: ${msg(err)}` },
      entry: authState,
    }
  }
  let authorizationUrl
  let client
  try {
    const allowPrivateNetwork = server?.config?.allowPrivateNetwork === true
    const provider = buildProvider(authState, {
      redirectUrl: parsedRedirect.href,
      scope: server.config?.scope,
      state: csrf,
      onRedirect: async (url) => {
        authorizationUrl = validateRemoteUrl(url, allowPrivateNetwork).href
      },
    })
    const transport = buildTransport(sdk, server, provider, egress.fetch)
    client = new sdk.Client({ name: "cognia-mcp-oauth", version: "1.0.0" }, { capabilities: {} })
    return await stage({
      client,
      transport,
      authState,
      getAuthorizationUrl: () => authorizationUrl,
    })
  } finally {
    await client?.close?.().catch(() => undefined)
    await egress.close().catch(() => undefined)
  }
}

function msg(err) {
  return err instanceof Error ? err.message : String(err)
}

/** Read one JSON line from stdin. */
function readStdin() {
  return new Promise((resolve) => {
    let buf = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (d) => {
      buf += d
      const i = buf.indexOf("\n")
      if (i >= 0) resolve(buf.slice(0, i))
    })
    process.stdin.on("end", () => resolve(buf))
  })
}

// Only the separately shipped helper owns this one-shot stdin protocol.
// Bundling collapses import.meta.url onto the host entry, so URL equality alone
// also starts this helper inside claude-host.mjs. A spawned helper may inherit
// COGNIA_ROLE from its parent; its own filename and URL, not that role, identify it.
export function isMcpOauthHelperEntry({ importUrl, argvPath }) {
  if (typeof argvPath !== "string" || nodePath.basename(argvPath) !== "mcp-oauth-helper.mjs")
    return false
  return importUrl === pathToFileURL(nodePath.resolve(argvPath)).href
}

const isMain = isMcpOauthHelperEntry({
  importUrl: import.meta.url,
  argvPath: process.argv[1],
})
if (isMain) {
  const mode = process.argv[2] ?? "authenticate"
  readStdin()
    .then(async (line) => {
      let input
      try {
        input = JSON.parse(line)
      } catch {
        return { result: { ok: false, status: "error", message: "invalid stdin JSON" }, entry: {} }
      }
      if (mode === "headless-prepare") {
        return prepareHeadlessFlow({
          server: input.server,
          entry: input.entry,
          redirectUrl: input.redirectUrl,
          state: input.state,
        })
      }
      if (mode === "headless-complete") {
        return completeHeadlessFlow({
          server: input.server,
          entry: input.entry,
          redirectUrl: input.redirectUrl,
          state: input.state,
          code: input.code,
        })
      }
      return runFlow({
        server: input.server,
        entry: input.entry,
        mode: mode === "refresh" ? "refresh" : "authenticate",
      })
    })
    .then((out) => {
      process.stdout.write(JSON.stringify(out) + "\n")
      process.exit(0)
    })
    .catch((err) => {
      process.stdout.write(
        JSON.stringify({ result: { ok: false, status: "error", message: msg(err) }, entry: {} }) +
          "\n"
      )
      process.exit(0)
    })
}
