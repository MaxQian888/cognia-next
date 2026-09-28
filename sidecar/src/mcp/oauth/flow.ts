import { createEgressGuard, validateRemoteUrl } from "../../platform/net/egress-guard.ts"
import { buildProvider, randomState } from "./provider.ts"
import { startCallbackServer } from "./callback.ts"
import { spawn } from "node:child_process"
import { buildTransport, isUnauthorized, loadSdk } from "./transport.ts"
import { msg, type FlowInput, type FlowDeps, type FlowResult, type OAuthClient } from "./types.ts"

/**
 * Run the flow. Returns `{ result, entry }`. Never throws — every failure mode
 * is a structured result. `mode` is "authenticate" (interactive) or "refresh"
 * (silent, refresh-token only).
 */
export async function runFlow(
  { server, entry, mode }: FlowInput,
  deps: FlowDeps = {}
): Promise<FlowResult> {
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

  let client: OAuthClient | undefined
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

/** Open a URL in the OS browser (best-effort, cross-platform). */
function openBrowser(url: string) {
  const cmd =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref()
  } catch {
    // Non-fatal — the URL is also printed as an `{open}` hint for the renderer.
  }
}
