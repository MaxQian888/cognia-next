import { classifyPairNetworkError, validateWebPairingTransport } from "./pair-helpers"

describe("validateWebPairingTransport", () => {
  it("requires HTTPS before a browser can send a pairing credential", () => {
    expect(validateWebPairingTransport("http://192.168.1.42:7890", true)).toBe("https_required")
    expect(validateWebPairingTransport("https://cognia.local", true)).toBeNull()
    expect(validateWebPairingTransport("http://192.168.1.42:7890", false)).toBeNull()
  })
})

describe("classifyPairNetworkError", () => {
  it.each([
    [new Error("net::ERR_CERT_AUTHORITY_INVALID"), true, "certificate"],
    [new Error("blocked by CORS private network access policy"), true, "browser_policy"],
    [new Error("Failed to fetch"), true, "browser_blocked"],
    [new Error("connect ECONNREFUSED"), true, "unreachable"],
    [new Error("request failed"), false, "offline"],
    [new Error("custom blowup"), true, "unknown"],
  ] as const)("classifies %s as %s", (error, online, expected) => {
    expect(classifyPairNetworkError(error, online)).toBe(expected)
  })
})
