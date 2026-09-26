// IP-literal and CIDR parsing for exact-address proxy bypass (NO_PROXY).

/** An IP literal as a fixed-width integer: 32 bits for IPv4, 128 for IPv6. */
export interface ParsedIp {
  bits: 32 | 128
  value: bigint
}

export interface ParsedCidr extends ParsedIp {
  prefix: number
}

function parseIpv4(input: string): ParsedIp | null {
  const parts = input.split(".")
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8n) | BigInt(octet)
  }
  return { bits: 32, value }
}

function ipv6Words(part: string): number[] | null {
  if (!part) return []
  const words: number[] = []
  for (const token of part.split(":")) {
    if (!token) return null
    if (token.includes(".")) {
      const ipv4 = parseIpv4(token)
      if (!ipv4) return null
      words.push(Number((ipv4.value >> 16n) & 0xffffn), Number(ipv4.value & 0xffffn))
      continue
    }
    if (!/^[0-9a-f]{1,4}$/i.test(token)) return null
    words.push(Number.parseInt(token, 16))
  }
  return words
}

function parseIpv6(input: string): ParsedIp | null {
  const normalized = input.replace(/^\[|\]$/g, "")
  const halves = normalized.split("::")
  if (halves.length > 2) return null
  const left = ipv6Words(halves[0] ?? "")
  const right = ipv6Words(halves[1] ?? "")
  if (!left || !right) return null
  const omitted = 8 - left.length - right.length
  if (halves.length === 1 ? omitted !== 0 : omitted < 1) return null
  const words = [...left, ...Array.from({ length: omitted }, () => 0), ...right]
  if (words.length !== 8) return null
  let value = 0n
  for (const word of words) value = (value << 16n) | BigInt(word)
  return { bits: 128, value }
}

/** Parse a dotted-quad IPv4 or (optionally bracketed) IPv6 literal; null for names. */
export function parseIp(input: string): ParsedIp | null {
  return parseIpv4(input) ?? parseIpv6(input)
}

/** Parse `address/prefix`; null when either half is malformed or the prefix is out of range. */
export function parseCidr(entry: string): ParsedCidr | null {
  const separator = entry.lastIndexOf("/")
  if (separator <= 0) return null
  const network = parseIp(entry.slice(0, separator))
  const prefix = Number(entry.slice(separator + 1))
  if (!network || !Number.isInteger(prefix) || prefix < 0 || prefix > network.bits) return null
  return { ...network, prefix }
}

/** Whether `hostname` is an IP literal of the same family inside `cidr`. */
export function cidrContains(cidr: ParsedCidr, hostname: string): boolean {
  const target = parseIp(hostname.replace(/^\[|\]$/g, ""))
  if (!target || target.bits !== cidr.bits) return false
  const shift = BigInt(cidr.bits - cidr.prefix)
  return target.value >> shift === cidr.value >> shift
}
