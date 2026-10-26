/**
 * The CLI's transport for `web_fetch` direct reads and reader services.
 *
 * The Reader checks each URL (and every redirect hop) against the private-host
 * guard, but a URL check cannot see where a public NAME resolves. This
 * transport closes that gap at connection time: every connection resolves its
 * host through {@link createGuardedLookup}, which refuses to connect when any
 * resolved address is loopback, private, link-local or otherwise non-public,
 * and the connection then uses exactly the addresses it checked (no second
 * resolution a rebinding server could answer differently).
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns"

import { isPrivateOrLocalHost } from "@cognia/network-guard"
import { Agent, fetch as undiciFetch } from "undici"

export class PrivateAddressError extends Error {
  readonly code = "EPRIVATEADDRESS"
  constructor(hostname: string, address: string) {
    super(`refusing to connect: ${hostname} resolves to a non-public address (${address})`)
    this.name = "PrivateAddressError"
  }
}

type Resolve = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void

/**
 * A `net.connect`-compatible lookup that resolves every address for the host
 * and fails the connection if any of them is non-public. When private hosts
 * are allowed it is a plain resolution.
 */
export function createGuardedLookup(
  options: { allowPrivateHosts?: boolean; resolve?: Resolve } = {}
): (hostname: string, lookupOptions: LookupOptions, callback: LookupCallback) => void {
  const resolve: Resolve = options.resolve ?? ((host, opts, cb) => dnsLookup(host, opts, cb))
  return (hostname, lookupOptions, callback) => {
    resolve(hostname, { ...lookupOptions, all: true }, (error, addresses) => {
      if (error) {
        callback(error, [])
        return
      }
      if (!addresses.length) {
        callback(Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" }), [])
        return
      }
      if (!options.allowPrivateHosts) {
        const blocked = addresses.find((entry) => isPrivateOrLocalHost(entry.address))
        if (blocked) {
          callback(new PrivateAddressError(hostname, blocked.address), [])
          return
        }
      }
      if (lookupOptions.all) callback(null, addresses)
      else callback(null, addresses[0].address, addresses[0].family)
    })
  }
}

/** A `fetch` whose every connection goes through the guarded lookup. */
export function createGuardedWebFetch(
  options: { allowPrivateHosts?: boolean; resolve?: Resolve } = {}
): typeof fetch {
  const dispatcher = new Agent({ connect: { lookup: createGuardedLookup(options) } })
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    })) as unknown as typeof fetch
}
