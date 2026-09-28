import { validateRemoteUrl } from "../../platform/net/egress-guard.ts"
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthSdk, RemoteServer, OAuthTransport, TransportOptions } from "./types.ts"

/** Lazily load the SDK client + remote transports. */
export async function loadSdk(): Promise<OAuthSdk> {
  const [{ Client }, { StreamableHTTPClientTransport }, { SSEClientTransport }] = await Promise.all(
    [
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
      import("@modelcontextprotocol/sdk/client/sse.js"),
    ]
  )
  return { Client, StreamableHTTPClientTransport, SSEClientTransport }
}

export function buildTransport(
  sdk: OAuthSdk,
  server: RemoteServer,
  authProvider: OAuthClientProvider | undefined,
  guardedFetch: TransportOptions["fetch"]
): OAuthTransport {
  const allowPrivateNetwork = server.config?.allowPrivateNetwork === true
  const url = validateRemoteUrl(server.config?.url, allowPrivateNetwork)
  const headers =
    server.config?.headers && typeof server.config.headers === "object"
      ? server.config.headers
      : undefined
  const opts: TransportOptions = {
    fetch: guardedFetch,
    requestInit: { ...(headers ? { headers } : {}), redirect: "error" },
  }
  if (authProvider) opts.authProvider = authProvider
  const Ctor =
    server.transport === "sse" ? sdk.SSEClientTransport : sdk.StreamableHTTPClientTransport
  return new Ctor(url, Object.keys(opts).length ? opts : undefined)
}

export function isUnauthorized(err: unknown) {
  const error = err && typeof err === "object" ? (err as Record<string, unknown>) : undefined
  const name = err && typeof err === "object" ? String(error?.name ?? "") : ""
  return name === "UnauthorizedError" || /unauthor/i.test(String(error?.message ?? ""))
}
