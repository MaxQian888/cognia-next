import {
  decodeBrowserEnrollmentPayload,
  encodeBrowserEnrollmentPayload,
  type BrowserEnrollmentPayload,
} from "./browser-enrollment-payload"

const NOW = 1_700_000_000_000

function payload(overrides: Partial<BrowserEnrollmentPayload> = {}): BrowserEnrollmentPayload {
  return {
    baseUrl: "http://127.0.0.1:27891",
    tenantId: "tenant-a",
    enrollment: "9f1c.aa22",
    expiresAt: NOW + 5 * 60 * 1_000,
    ...overrides,
  }
}

describe("browser enrollment payload", () => {
  it("round-trips", () => {
    const outcome = decodeBrowserEnrollmentPayload(encodeBrowserEnrollmentPayload(payload()), NOW)
    expect(outcome).toEqual({ kind: "ok", payload: payload() })
  })

  it("carries the cgnb1 header so it cannot be confused with a pairing code", () => {
    // `cgnp3|` advertises the HTTPS plane, which a tab cannot reach at all.
    // Sharing a header would let each code be pasted where it silently fails.
    expect(encodeBrowserEnrollmentPayload(payload()).startsWith("cgnb1|")).toBe(true)
    expect(decodeBrowserEnrollmentPayload("cgnp3|eyJhIjoxfQ", NOW)).toEqual({
      kind: "wrong_format",
    })
  })

  it("separates 'not our code', 'newer Cognia', and 'broken code'", () => {
    expect(decodeBrowserEnrollmentPayload("hello", NOW)).toEqual({ kind: "wrong_format" })
    expect(decodeBrowserEnrollmentPayload("cgnb9|eyJhIjoxfQ", NOW)).toEqual({
      kind: "version_mismatch",
      got: 9,
    })
    const broken = decodeBrowserEnrollmentPayload("cgnb1|not-base64-json", NOW)
    expect(broken.kind).toBe("invalid")
  })

  it("refuses an expired code and says so", () => {
    const outcome = decodeBrowserEnrollmentPayload(
      encodeBrowserEnrollmentPayload(payload({ expiresAt: NOW - 1 })),
      NOW
    )
    expect(outcome).toEqual({ kind: "invalid", message: "the pairing code has expired" })
  })

  it("accepts every loopback form the Host can bind", () => {
    for (const baseUrl of [
      "http://127.0.0.1:27891",
      "http://127.0.0.2:27891",
      "http://localhost:27891",
      "http://[::1]:27891",
    ]) {
      const outcome = decodeBrowserEnrollmentPayload(
        encodeBrowserEnrollmentPayload(payload({ baseUrl })),
        NOW
      )
      expect(outcome.kind).toBe("ok")
    }
  })

  it("refuses a code that points anywhere but this machine's browser listener", () => {
    for (const baseUrl of [
      // The extension holds a loopback host permission only; an off-machine
      // code would produce a permission prompt nobody can satisfy.
      "http://192.168.1.10:27891",
      "http://example.com",
      // The browser plane is plaintext by construction — an https code names a
      // listener that does not exist.
      "https://127.0.0.1:27890",
      "http://127.0.0.1:27891/pair",
      "http://127.0.0.1:27891?a=1",
      "http://user:pw@127.0.0.1:27891",
      "not a url",
    ]) {
      const outcome = decodeBrowserEnrollmentPayload(
        encodeBrowserEnrollmentPayload(payload({ baseUrl })),
        NOW
      )
      expect(outcome.kind).toBe("invalid")
    }
  })

  it("refuses a payload missing any field", () => {
    for (const key of ["base", "tenant", "enrollment", "exp"]) {
      const body = {
        base: "http://127.0.0.1:27891",
        tenant: "tenant-a",
        enrollment: "tok",
        exp: NOW + 1_000,
      } as Record<string, unknown>
      delete body[key]
      const encoded =
        "cgnb1|" +
        Buffer.from(JSON.stringify(body), "utf8")
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/g, "")
      expect(decodeBrowserEnrollmentPayload(encoded, NOW).kind).toBe("invalid")
    }
  })
})
