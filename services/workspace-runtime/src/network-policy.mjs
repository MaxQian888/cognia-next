import dns from "node:dns/promises"
import net from "node:net"

export class DomainBlockedError extends Error {
  constructor(code, hostname) {
    super(`${code}: ${hostname}`)
    this.name = "DomainBlockedError"
    this.code = code
    this.hostname = hostname
  }
}

function normalizedHostname(value) {
  return value
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
}

function ipv4Number(address) {
  return (
    address
      .split(".")
      .map(Number)
      .reduce((value, octet) => (value << 8) + octet, 0) >>> 0
  )
}

function inIpv4Cidr(address, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask)
}

export function isBlockedAddress(address) {
  const ip = normalizedHostname(address)
  if (net.isIPv4(ip)) {
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([base, bits]) => inIpv4Cidr(ip, base, bits))
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      /^fe[89ab]/.test(lower) ||
      lower.startsWith("ff")
    )
  }
  return true
}

function granted(hostname, grants) {
  const host = normalizedHostname(hostname)
  return grants.some((rawGrant) => host === normalizedHostname(rawGrant))
}

async function defaultResolve(hostname) {
  const records = await dns.lookup(hostname, { all: true, verbatim: true })
  return records.map(({ address }) => address)
}

export class NetworkPolicy {
  constructor({ resolve = defaultResolve } = {}) {
    this.resolve = resolve
    this.pins = new Map()
  }

  async authorize(rawUrl, grants) {
    let url
    try {
      url = new URL(rawUrl)
    } catch {
      throw new DomainBlockedError("domain_blocked", rawUrl)
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new DomainBlockedError("domain_blocked", url.hostname)
    }
    const hostname = normalizedHostname(url.hostname)
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      return { url: url.toString(), hostname, address: hostname, loopback: true }
    }
    if (net.isIP(hostname) && isBlockedAddress(hostname)) {
      throw new DomainBlockedError("network_address_blocked", hostname)
    }
    if (!granted(hostname, grants)) {
      throw new DomainBlockedError("domain_blocked", hostname)
    }
    const addresses = await this.resolve(hostname)
    if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
      throw new DomainBlockedError("network_address_blocked", hostname)
    }
    const previous = this.pins.get(hostname)
    if (previous && !addresses.includes(previous)) {
      throw new DomainBlockedError("dns_rebinding_blocked", hostname)
    }
    const address = previous ?? addresses[0]
    this.pins.set(hostname, address)
    return { url: url.toString(), hostname, address, loopback: false }
  }

  async authorizeRedirect(fromUrl, toUrl, grants) {
    const from = new URL(fromUrl)
    const to = new URL(toUrl, from)
    if (normalizedHostname(from.hostname) === normalizedHostname(to.hostname)) {
      return this.authorize(to.toString(), grants)
    }
    return this.authorize(to.toString(), grants)
  }

  async resolverRules(grants) {
    const mappings = []
    for (const grant of grants) {
      if (grant.startsWith("*.")) {
        throw new DomainBlockedError("domain_grant_invalid", grant)
      }
      const result = await this.authorize(`https://${grant}/`, grants)
      mappings.push(`MAP ${result.hostname} ${result.address}`)
    }
    return [...mappings, "EXCLUDE localhost", "EXCLUDE 127.0.0.1", "EXCLUDE [::1]"].join(",")
  }
}
