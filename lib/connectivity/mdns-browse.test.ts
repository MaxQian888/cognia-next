/**
 * @jest-environment jsdom
 */

const mockIsTauri = jest.fn(() => true)
const mockCall = jest.fn(async (..._args: unknown[]) => undefined as unknown)

jest.mock("@/lib/platform/detect", () => ({
  isTauri: () => mockIsTauri(),
}))
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => mockCall(...args) },
}))

import {
  browseLanHosts,
  classifyPayloadReachability,
  findHostByFingerprint,
  type BrowsedHost,
} from "./mdns-browse"

function host(overrides: Partial<BrowsedHost> = {}): BrowsedHost {
  return {
    fullname: "cognia-ab12cd._cognia._tcp.local.",
    instanceName: "cognia-ab12cd",
    hostname: "cognia-ab12cd.local.",
    addresses: ["192.168.1.9"],
    port: 27890,
    appVersion: "1.2.3",
    tlsFingerprint: "abc123",
    baseUrl: "https://192.168.1.9:27890",
    isSelf: false,
    ...overrides,
  }
}

beforeEach(() => {
  mockIsTauri.mockReturnValue(true)
  mockCall.mockReset()
  mockCall.mockResolvedValue([])
})

describe("browseLanHosts", () => {
  it("passes the sweep window through to the command", async () => {
    const found = [host()]
    mockCall.mockResolvedValue(found)

    await expect(browseLanHosts({ timeoutMs: 3000 })).resolves.toEqual(found)
    expect(mockCall).toHaveBeenCalledWith("companion_mdns_browse", { timeoutMs: 3000 })
  })

  it("returns nothing off-desktop without calling the command", async () => {
    // Neither a browser nor the Capacitor webview can open a multicast socket.
    mockIsTauri.mockReturnValue(false)

    await expect(browseLanHosts()).resolves.toEqual([])
    expect(mockCall).not.toHaveBeenCalled()
  })

  it("returns an empty list rather than throwing when the sweep fails", async () => {
    mockCall.mockRejectedValue(new Error("no usable IP interface"))

    await expect(browseLanHosts()).resolves.toEqual([])
  })

  it("tolerates a non-array result", async () => {
    mockCall.mockResolvedValue({ unexpected: true })

    await expect(browseLanHosts()).resolves.toEqual([])
  })
})

describe("findHostByFingerprint", () => {
  it("matches case-insensitively", async () => {
    // The TXT record is lower-case hex; payloads have carried both cases.
    const hosts = [host({ tlsFingerprint: "abcdef" })]

    expect(findHostByFingerprint(hosts, "ABCDEF")).toBe(hosts[0])
  })

  it("ignores surrounding whitespace", () => {
    const hosts = [host({ tlsFingerprint: "abcdef" })]

    expect(findHostByFingerprint(hosts, "  abcdef ")).toBe(hosts[0])
  })

  it("does not match an absent or empty fingerprint", () => {
    // Otherwise a payload with no fingerprint would "match" the first host
    // that also lacks one, and we would offer to rewrite its address.
    const hosts = [host({ tlsFingerprint: undefined })]

    expect(findHostByFingerprint(hosts, undefined)).toBeNull()
    expect(findHostByFingerprint(hosts, "")).toBeNull()
    expect(findHostByFingerprint(hosts, "   ")).toBeNull()
  })
})

describe("classifyPayloadReachability", () => {
  it("reports a host that is not on the LAN", () => {
    expect(
      classifyPayloadReachability([host({ tlsFingerprint: "other" })], {
        baseUrl: "https://box.example:27890",
        fingerprint: "abc123",
      })
    ).toEqual({ kind: "not-advertising" })
  })

  it("matches when the invitation already points at the live address", () => {
    const hosts = [host()]

    expect(
      classifyPayloadReachability(hosts, {
        baseUrl: "https://192.168.1.9:27890",
        fingerprint: "abc123",
      })
    ).toEqual({ kind: "match", host: hosts[0] })
  })

  it("ignores trailing slashes and case when comparing addresses", () => {
    const hosts = [host()]

    expect(
      classifyPayloadReachability(hosts, {
        baseUrl: "HTTPS://192.168.1.9:27890/",
        fingerprint: "abc123",
      })
    ).toMatchObject({ kind: "match" })
  })

  it("surfaces the live address when the invitation carries a stale one", () => {
    // The DHCP-move case: the invitation was generated at .9, the host now
    // answers at .22. Pairing on the stale address fails with a bare
    // connection error that names nothing actionable.
    const hosts = [host({ addresses: ["192.168.1.22"], baseUrl: "https://192.168.1.22:27890" })]

    expect(
      classifyPayloadReachability(hosts, {
        baseUrl: "https://192.168.1.9:27890",
        fingerprint: "abc123",
      })
    ).toEqual({
      kind: "address-differs",
      host: hosts[0],
      liveBaseUrl: "https://192.168.1.22:27890",
    })
  })

  it("does not claim a mismatch when the advertisement resolved without an address", () => {
    const hosts = [host({ addresses: [], baseUrl: null })]

    expect(
      classifyPayloadReachability(hosts, {
        baseUrl: "https://192.168.1.9:27890",
        fingerprint: "abc123",
      })
    ).toMatchObject({ kind: "match" })
  })

  it("treats a null payload as not advertising", () => {
    expect(classifyPayloadReachability([host()], null)).toEqual({ kind: "not-advertising" })
  })
})
