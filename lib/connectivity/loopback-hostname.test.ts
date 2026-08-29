import { isLoopbackHostname } from "./loopback-hostname"

describe("isLoopbackHostname", () => {
  it.each(["localhost", "127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "[::1]"])(
    "accepts %s",
    (host) => {
      expect(isLoopbackHostname(host)).toBe(true)
    }
  )

  it.each([
    // A suffix, not the host — the classic allowlist bypass.
    "localhost.evil.example",
    // The same bypass wearing the loopback block's prefix. A text test on
    // `127.` accepts both of these, and an attacker owns where they resolve.
    "127.evil.example",
    "127.0.0.1.nip.io",
    "127.0.0.1.example.com",
    // Not four octets, and not an octet at all.
    "127.0.0",
    "127.0.0.256",
    "192.168.1.42",
    "10.0.0.4",
    "example.com",
    // 128/8 is one bit outside the loopback block.
    "128.0.0.1",
    "",
  ])("refuses %s", (host) => {
    expect(isLoopbackHostname(host)).toBe(false)
  })

  it("matches what URL.hostname hands it for both literal forms", () => {
    // `URL.hostname` keeps the brackets on IPv6 and strips nothing on IPv4, so
    // the predicate has to accept exactly those two shapes.
    expect(isLoopbackHostname(new URL("http://[::1]:27891").hostname)).toBe(true)
    expect(isLoopbackHostname(new URL("http://127.0.0.1:27891").hostname)).toBe(true)
    expect(isLoopbackHostname(new URL("http://192.168.1.5:27891").hostname)).toBe(false)
  })
})
