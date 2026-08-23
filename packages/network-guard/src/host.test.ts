import {
  ipv6Groups,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateOrLocalHost,
  normalizeHost,
  parseIPv4,
} from "./host"

describe("normalizeHost", () => {
  it("strips whitespace, brackets, the root dot, and case", () => {
    expect(normalizeHost("  ExAmPle.COM.  ")).toBe("example.com")
    expect(normalizeHost("[::1]")).toBe("::1")
    expect(normalizeHost("[FE80::1]")).toBe("fe80::1")
    expect(normalizeHost("example.com...")).toBe("example.com")
  })
})

describe("parseIPv4", () => {
  it("reads the dotted quad", () => {
    expect(parseIPv4("127.0.0.1")).toEqual([127, 0, 0, 1])
    expect(parseIPv4("8.8.8.8")).toEqual([8, 8, 8, 8])
  })

  it("reads the legacy inet_aton forms", () => {
    expect(parseIPv4("2130706433")).toEqual([127, 0, 0, 1]) // bare 32-bit
    expect(parseIPv4("127.1")).toEqual([127, 0, 0, 1]) // last part absorbs
    expect(parseIPv4("0x7f.0.0.1")).toEqual([127, 0, 0, 1]) // hex part
    expect(parseIPv4("0177.0.0.1")).toEqual([127, 0, 0, 1]) // octal part
    expect(parseIPv4("0")).toEqual([0, 0, 0, 0])
  })

  it("rejects non-IPv4 hosts", () => {
    expect(parseIPv4("example.com")).toBeNull()
    expect(parseIPv4("1.2.3.4.5")).toBeNull()
    expect(parseIPv4("256.0.0.1")).toBeNull()
    expect(parseIPv4("0x")).toBeNull()
    expect(parseIPv4("08.0.0.1")).toBeNull() // 8 is not an octal digit
    expect(parseIPv4("")).toBeNull()
    expect(parseIPv4("99999999999")).toBeNull() // beyond 32 bits
  })
})

describe("isPrivateIPv4 boundaries", () => {
  it.each([
    ["0.0.0.0", true],
    ["0.255.255.255", true],
    ["1.0.0.0", false],
    ["9.255.255.255", false],
    ["10.0.0.0", true],
    ["10.255.255.255", true],
    ["11.0.0.0", false],
    ["100.63.255.255", false],
    ["100.64.0.0", true],
    ["100.127.255.255", true],
    ["100.128.0.0", false],
    ["126.255.255.255", false],
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["128.0.0.0", false],
    ["169.253.255.255", false],
    ["169.254.169.254", true],
    ["169.255.0.0", false],
    ["172.15.255.255", false],
    ["172.16.0.0", true],
    ["172.31.255.255", true],
    ["172.32.0.0", false],
    ["192.167.255.255", false],
    ["192.168.0.0", true],
    ["192.168.255.255", true],
    ["192.169.0.0", false],
    ["223.255.255.255", false],
    ["224.0.0.1", true],
    ["239.255.255.255", true],
    ["240.0.0.1", true],
    ["255.255.255.255", true],
  ])("%s → private=%s", (host, expected) => {
    const octets = parseIPv4(host)
    expect(octets).not.toBeNull()
    expect(isPrivateIPv4(octets!)).toBe(expected)
  })
})

describe("ipv6Groups", () => {
  it("expands the :: elision", () => {
    expect(ipv6Groups("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(ipv6Groups("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(ipv6Groups("2606:4700::1")).toEqual([0x2606, 0x4700, 0, 0, 0, 0, 0, 1])
  })

  it("folds a trailing dotted quad into the last two groups", () => {
    expect(ipv6Groups("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1])
  })

  it("drops the zone id", () => {
    expect(ipv6Groups("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1])
  })

  it("reads a fully written address", () => {
    expect(ipv6Groups("0:0:0:0:0:0:0:1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
  })

  it("refuses what it cannot decode", () => {
    expect(ipv6Groups("::1::2")).toBeNull()
    expect(ipv6Groups("1:2:3")).toBeNull()
    expect(ipv6Groups("gggg::1")).toBeNull()
    expect(ipv6Groups("::ffff:999.0.0.1")).toBeNull()
  })
})

describe("isPrivateIPv6", () => {
  it.each([
    ["::1", true],
    ["::", true],
    ["0:0:0:0:0:0:0:1", true],
    ["fc00::1", true],
    ["fd00::1", true],
    ["fdff:ffff::1", true],
    ["fe80::1", true],
    ["febf::1", true],
    ["fec0::1", true],
    ["feff::1", true],
    ["ff02::1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:169.254.169.254", true],
    ["::ffff:192.168.1.1", true],
    ["::127.0.0.1", true],
    ["2606:4700::1", false],
    ["2001:db8::1", false],
    ["::ffff:1.2.3.4", false],
    ["fe00::1", false],
    ["fdgg::1", true], // undecodable → refused
  ])("%s → private=%s", (host, expected) => {
    expect(isPrivateIPv6(host)).toBe(expected)
  })

  it("classifies the hex re-serialisation the URL parser produces", () => {
    // `new URL("http://[::ffff:169.254.169.254]/").hostname` is
    // `[::ffff:a9fe:a9fe]` — the form a textual dotted-quad check misses.
    expect(isPrivateIPv6("::ffff:a9fe:a9fe")).toBe(true)
    expect(isPrivateIPv6("::ffff:7f00:1")).toBe(true)
  })
})

describe("isPrivateOrLocalHost", () => {
  it("blocks the named local suffixes", () => {
    expect(isPrivateOrLocalHost("localhost")).toBe(true)
    expect(isPrivateOrLocalHost("app.localhost")).toBe(true)
    expect(isPrivateOrLocalHost("router.local")).toBe(true)
    expect(isPrivateOrLocalHost("local")).toBe(true)
    expect(isPrivateOrLocalHost("LOCALHOST.")).toBe(true)
  })

  it("treats an empty host as unsafe", () => {
    expect(isPrivateOrLocalHost("")).toBe(true)
    expect(isPrivateOrLocalHost("   ")).toBe(true)
  })

  it("accepts a bracketed literal", () => {
    expect(isPrivateOrLocalHost("[::1]")).toBe(true)
    expect(isPrivateOrLocalHost("[2606:4700::1]")).toBe(false)
  })

  it("clears ordinary public hosts", () => {
    expect(isPrivateOrLocalHost("example.com")).toBe(false)
    expect(isPrivateOrLocalHost("cdn.example.co.uk")).toBe(false)
    expect(isPrivateOrLocalHost("8.8.8.8")).toBe(false)
    // A name merely CONTAINING the suffix is not the suffix.
    expect(isPrivateOrLocalHost("notlocalhost.com")).toBe(false)
    expect(isPrivateOrLocalHost("mylocal.com")).toBe(false)
  })
})
