/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { encodeBrowserEnrollmentPayload } from "@cognia/companion-client"

import { pairWithHost } from "./client"

const NOW = 1_700_000_000_000
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"

function code(overrides: Record<string, unknown> = {}): string {
  return encodeBrowserEnrollmentPayload({
    baseUrl: "http://127.0.0.1:27891",
    tenantId: "tenant-a",
    enrollment: "aaaa.bbbb",
    expiresAt: NOW + 60_000,
    ...overrides,
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("pairWithHost", () => {
  it("refuses a malformed code before generating a key", async () => {
    // Order matters: a key generated for a code that was never going to work
    // leaves an orphaned identity in IndexedDB that nothing will ever use.
    let called = false
    const outcome = await pairWithHost({
      code: "not-a-cognia-code",
      extensionOrigin: ORIGIN,
      hasPermission: true,
      displayName: "Chrome",
      fetchImpl: async () => {
        called = true
        return jsonResponse({})
      },
      now: () => NOW,
    })
    expect(outcome).toEqual({ ok: false, failure: { code: "wrong_format" } })
    expect(called).toBe(false)
  })

  it("separates an expired code from a malformed one", async () => {
    const outcome = await pairWithHost({
      code: code({ expiresAt: NOW - 1 }),
      extensionOrigin: ORIGIN,
      hasPermission: true,
      displayName: "Chrome",
      fetchImpl: async () => jsonResponse({}),
      now: () => NOW,
    })
    expect(outcome).toMatchObject({ ok: false, failure: { code: "invalid" } })
  })

  it("refuses without the loopback permission, rather than failing at fetch", async () => {
    // A fetch without the host permission fails with a network error that
    // says nothing about the cause; naming it is the whole point.
    let called = false
    const outcome = await pairWithHost({
      code: code(),
      extensionOrigin: ORIGIN,
      hasPermission: false,
      displayName: "Chrome",
      fetchImpl: async () => {
        called = true
        return jsonResponse({})
      },
      now: () => NOW,
    })
    expect(outcome).toEqual({ ok: false, failure: { code: "permission_denied" } })
    expect(called).toBe(false)
  })

  it("registers with a proof and returns only the public half of the pairing", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = []
    const outcome = await pairWithHost({
      code: code(),
      extensionOrigin: ORIGIN,
      hasPermission: true,
      displayName: "Chrome",
      now: () => NOW,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        seen.push({ url, body })
        if (url.endsWith("/api/auth/device/challenge")) {
          return jsonResponse({ challengeId: "c1", nonce: "n1", expiresAt: NOW + 60_000 })
        }
        return jsonResponse({
          deviceId: body.deviceId,
          tenantId: "tenant-a",
          role: "member",
          capabilities: ["browser.submit", "browser.read-own"],
          extensionOrigin: ORIGIN,
        })
      },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.pairing).toMatchObject({
      baseUrl: "http://127.0.0.1:27891",
      tenantId: "tenant-a",
      extensionOrigin: ORIGIN,
    })

    const registration = seen.find((entry) => entry.url.endsWith("/api/auth/browser/register"))
    expect(registration?.body.extensionOrigin).toBe(ORIGIN)
    expect(typeof registration?.body.proof).toBe("string")
    expect(String(registration?.body.publicKeyPem)).toContain("BEGIN PUBLIC KEY")
    // The private key never leaves IndexedDB; nothing key-shaped is sent
    // beyond the public PEM the Host has to store.
    expect(JSON.stringify(registration?.body)).not.toContain('"d"')
    expect(JSON.stringify(outcome.pairing)).not.toContain("PRIVATE")
  })

  it("refuses a host that answers with a different device id", async () => {
    const outcome = await pairWithHost({
      code: code(),
      extensionOrigin: ORIGIN,
      hasPermission: true,
      displayName: "Chrome",
      now: () => NOW,
      fetchImpl: async (url) =>
        url.endsWith("/api/auth/device/challenge")
          ? jsonResponse({ challengeId: "c1", nonce: "n1" })
          : jsonResponse({ deviceId: "somebody-else" }),
    })
    expect(outcome).toMatchObject({ ok: false, failure: { code: "rejected" } })
  })

  it("carries the host's refusal message through", async () => {
    const outcome = await pairWithHost({
      code: code(),
      extensionOrigin: ORIGIN,
      hasPermission: true,
      displayName: "Chrome",
      now: () => NOW,
      fetchImpl: async (url) =>
        url.endsWith("/api/auth/device/challenge")
          ? jsonResponse({ challengeId: "c1", nonce: "n1" })
          : jsonResponse(
              { error: { code: "invalid_extension_origin", message: "bad origin" } },
              400
            ),
    })
    expect(outcome).toMatchObject({
      ok: false,
      failure: { code: "rejected", message: "bad origin" },
    })
  })
})
