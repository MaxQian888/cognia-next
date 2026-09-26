// The outbound-request guard for remote MCP servers and their OAuth
// endpoints: HTTPS only, no private or reserved targets unless the user
// reviewed the server with `allowPrivateNetwork`, no redirects, and a DNS
// check on the socket's own lookup so a hostname cannot rebind to a private
// address between validation and connect.
//
// Used by the OAuth helper, the stdio relay, the AI SDK MCP client, and the
// app's `lib/mcp/transport.ts` (which also compiles it under the root
// tsconfig, so it stays free of `import.meta` and top-level await).

import nodeDns from "node:dns"
import type { LookupAddress, LookupAllOptions, LookupOptions } from "node:dns"
import type { LookupFunction } from "node:net"
import { Agent } from "undici"
import type { Dispatcher } from "undici"

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split(".")
  if (parts.length !== 4) return null
  const bytes = parts.map(Number)
  return bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? bytes : null
}

/** Fail-closed classification shared by configured, discovered, and token URLs. */
export function isPrivateOrReservedHost(hostname: string): boolean {
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
  const [a = 0, b = 0, c = 0] = ip
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

/**
 * Parse a remote endpoint and enforce HTTPS and a public target. With
 * `allowPrivateNetwork`, a private target may also use plain HTTP.
 */
export function validateRemoteUrl(value: unknown, allowPrivateNetwork = false): URL {
  let url: URL
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

/** The `dns.lookup` form the guard calls: every address for a host. */
export type LookupAll = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number
) => void

function guardedLookup(allowPrivateNetwork: boolean, lookup: LookupAll): LookupFunction {
  const guarded = (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error)
        return
      }
      const rows = Array.isArray(addresses) ? addresses : []
      const first = rows[0]
      if (!first) {
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
      else callback(null, first.address, first.family)
    })
  }
  // Like Node's own `dns.lookup`, the guard reports a failure with the error
  // alone; the declared callback type makes the address mandatory anyway.
  return guarded as LookupFunction
}

/** Builds the connection pool whose sockets resolve through the guarded lookup. */
export type GuardAgentConstructor = new (options: {
  connect: { lookup: LookupFunction }
}) => Dispatcher

export interface EgressGuardOptions {
  allowPrivateNetwork?: boolean
  fetchImpl?: typeof fetch
  lookup?: LookupAll
  AgentCtor?: GuardAgentConstructor
}

export interface EgressGuard {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
  close(): Promise<void>
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
}: EgressGuardOptions = {}): EgressGuard {
  let dispatcher: Dispatcher | undefined
  const getDispatcher = (): Dispatcher | undefined => {
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
