/**
 * Host classification for the shared SSRF policy.
 *
 * This is the half that answers "is this host somewhere an outbound request
 * must not be aimed at by default" — loopback, private LAN, link-local (the
 * cloud metadata endpoint at `169.254.169.254`), CGNAT, multicast, and the
 * IPv6 equivalents. Pure string/number work: no DNS, no sockets, no Node
 * built-ins, so it runs unchanged in the renderer and in the sidecar.
 *
 * ## Why the IPv6 path decodes instead of matching text
 *
 * `new URL("http://[::1]/").hostname` is `"[::1]"` — WHATWG keeps the brackets.
 * A classifier that compares `host === "::1"` therefore clears every IPv6
 * loopback. Worse, the parser re-serialises IPv4-mapped literals to hex:
 * `http://[::ffff:169.254.169.254]/` arrives as `[::ffff:a9fe:a9fe]`, so a
 * regex hunting for a trailing dotted quad never fires and the metadata
 * endpoint gets through.
 *
 * Both mistakes shipped in this repo — see the module docs on
 * `evaluateFetchTarget`. The only classification that survives the parser is a
 * numeric one: expand the address to its 8 groups, then mask-test.
 */

/** The 4 octets of an IPv4 address. */
export type IPv4Octets = [number, number, number, number]

/**
 * Strip a host down to the form the classifiers below expect: no surrounding
 * whitespace, no IPv6 brackets, no root-zone trailing dot, lower-cased.
 *
 * The trailing dot matters on its own: `example.com.` and `example.com` resolve
 * identically, so a suffix check that skips normalisation is trivially evaded.
 */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase()
}

/**
 * Parse one IPv4 part in any radix the legacy `inet_aton` grammar allows:
 * `0x7f` hex, `0177` octal, `127` decimal. Returns `null` when the part is not
 * a valid number in its implied radix.
 *
 * WHATWG normalises these forms away before `hostname` is read
 * (`http://0x7f.0.0.1/` → `127.0.0.1`), so `evaluateFetchTarget` never sees
 * them. `isPrivateOrLocalHost` is exported for callers holding a raw host that
 * never went through a URL parser, and those callers still need the coverage.
 */
function parseIPv4Part(part: string): number | null {
  if (part === "") return null
  let radix = 10
  let digits = part
  if (/^0x/i.test(part)) {
    radix = 16
    digits = part.slice(2)
    if (digits === "") return null
    if (!/^[0-9a-f]+$/i.test(digits)) return null
  } else if (part.length > 1 && part.startsWith("0")) {
    radix = 8
    digits = part.slice(1)
    if (!/^[0-7]+$/.test(digits)) return null
  } else if (!/^\d+$/.test(part)) {
    return null
  }
  const value = parseInt(digits, radix)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Parse a host as an IPv4 literal, tolerating the SSRF-bypass encodings: the
 * dotted quad (`127.0.0.1`), a bare 32-bit integer (`2130706433`), the short
 * forms where the final part absorbs the remaining octets (`127.1`), and any
 * part written in hex or octal. Returns the four octets, or `null` when the
 * host is not an IPv4 literal at all.
 */
export function parseIPv4(host: string): IPv4Octets | null {
  const parts = host.split(".")
  if (parts.length > 4) return null
  const values: number[] = []
  for (const part of parts) {
    const value = parseIPv4Part(part)
    if (value === null) return null
    values.push(value)
  }
  // Every part but the last is a single octet; the last absorbs whatever
  // octets the notation left out (`127.1` ≡ `127.0.0.1`).
  const last = values.pop()
  if (last === undefined) return null
  if (values.some((v) => v > 0xff)) return null
  const capacity = 4 - values.length
  if (last > (capacity === 4 ? 0xffffffff : Math.pow(256, capacity) - 1)) return null
  const packed = values.reduce((acc, v, i) => acc + v * Math.pow(256, 3 - i), 0) + last
  return [
    Math.floor(packed / 0x1000000) & 0xff,
    Math.floor(packed / 0x10000) & 0xff,
    Math.floor(packed / 0x100) & 0xff,
    packed & 0xff,
  ]
}

/**
 * Is this IPv4 address in a range an outbound request must not reach?
 *
 * The union of the three rule sets this package replaced — the app gate and the
 * webclone gate already carried CGNAT and the multicast/reserved top, which the
 * connector floor's regex missed.
 */
export function isPrivateIPv4([a, b]: IPv4Octets): boolean {
  if (a === 0) return true // 0.0.0.0/8 "this host"
  if (a === 10) return true // 10.0.0.0/8 private
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (a >= 224) return true // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false
}

/**
 * Expand an IPv6 literal (brackets already stripped) into its 8 numeric
 * groups, or `null` when it cannot be read.
 *
 * Handles the three things that hide an address from a textual check: a
 * trailing dotted quad folding into the last two groups, a `%zone` suffix that
 * is not part of the address, and the `::` run-length elision.
 */
export function ipv6Groups(inner: string): number[] | null {
  // A zone id (`fe80::1%eth0`) identifies an interface, not an address.
  let text = inner.split("%")[0]
  // A trailing dotted quad (`::ffff:127.0.0.1`) folds into the last two groups.
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted?.index !== undefined) {
    const octets = dotted[1].split(".").map(Number)
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null
    const hi = ((octets[0] << 8) | octets[1]).toString(16)
    const lo = ((octets[2] << 8) | octets[3]).toString(16)
    text = `${text.slice(0, dotted.index)}${hi}:${lo}`
  }
  const halves = text.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return null
  const parts = [...head, ...Array<string>(fill).fill("0"), ...tail]
  if (parts.length !== 8) return null
  const groups = parts.map((part) => (/^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : NaN))
  return groups.some(Number.isNaN) ? null : groups
}

/**
 * Is this IPv6 host (brackets already stripped) one an outbound request must
 * not reach? A literal that cannot be decoded is not one that can be cleared.
 */
export function isPrivateIPv6(host: string): boolean {
  const groups = ipv6Groups(host)
  if (!groups) return true
  // `::1` loopback and `::` unspecified, which most stacks route to loopback.
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] <= 1) return true
  // IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible (`::a.b.c.d`) literals
  // reach the v4 internet, so they answer to the v4 rules. This is the hole
  // that let `http://[::ffff:169.254.169.254]/` past two of the three gates.
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0 || groups[5] === 0xffff)) {
    return isPrivateIPv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff])
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((groups[0] & 0xffc0) === 0xfec0) return true // fec0::/10 site-local (deprecated, still routed)
  if ((groups[0] & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/**
 * True when `host` names a loopback, private-LAN, link-local, mDNS, or
 * otherwise non-public target that an outbound fetch should not reach by
 * default. Accepts a bare host, bracketed or not.
 */
export function isPrivateOrLocalHost(host: string): boolean {
  const h = normalizeHost(host)
  if (!h) return true // empty host → treat as unsafe
  if (h === "localhost" || h.endsWith(".localhost")) return true
  // mDNS: `.local` names resolve on the LAN by definition.
  if (h === "local" || h.endsWith(".local")) return true
  if (h.includes(":")) return isPrivateIPv6(h)
  const v4 = parseIPv4(h)
  if (v4) return isPrivateIPv4(v4)
  return false
}
