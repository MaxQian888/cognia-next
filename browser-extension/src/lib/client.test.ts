/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { encodeBrowserEnrollmentPayload } from "@cognia/companion-client"

import { createHostClient, pairWithHost } from "./client"

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

describe("createHostClient", () => {
  /**
   * A signer that never touches WebCrypto.
   *
   * The proof's contents are `@cognia/companion-client`'s to get right and its
   * own suite already pins them; what is under test here is the envelope the
   * Host answers with, so a signature that is merely well-shaped keeps the
   * failure legible.
   */
  const signer = {
    deviceId: "device-a",
    sign: async () => new Uint8Array(64),
  }

  const pairing = {
    baseUrl: "http://127.0.0.1:27891",
    tenantId: "tenant-a",
    deviceId: "device-a",
    extensionOrigin: ORIGIN,
    pairedAt: NOW,
  }

  /** Challenge, token, then whatever the command answers with. */
  function hostAnswering(rpcBody: unknown): {
    fetchImpl: (input: string, init: RequestInit) => Promise<Response>
    calls: { path: string; headers: Headers }[]
  } {
    const calls: { path: string; headers: Headers }[] = []
    const accessToken = [
      btoa(JSON.stringify({ alg: "HS256" })),
      btoa(JSON.stringify({ jti: "token-jti" })),
      "sig",
    ].join(".")
    return {
      calls,
      fetchImpl: async (input, init) => {
        const path = new URL(input).pathname
        calls.push({ path, headers: new Headers(init.headers) })
        if (path === "/api/auth/device/challenge") {
          return jsonResponse({ challengeId: "c1", nonce: "n1", expiresAt: NOW + 60_000 })
        }
        if (path === "/api/auth/token") {
          return jsonResponse({ accessToken, tokenType: "DPoP", expiresIn: 300 })
        }
        return jsonResponse(rpcBody)
      },
    }
  }

  it("reads the result out of the RPC envelope rather than returning the envelope", async () => {
    // `POST /api/_rpc/<name>` answers `{ requestId, result }`, never the bare
    // result — and returning the envelope is not a type error anywhere, so the
    // only symptom is every field reading back `undefined`. For the capability
    // call that means `schemaVersion === undefined`, which the panel renders as
    // "this Host speaks a schema this build does not" — a dead end that
    // describes neither the cause nor the fix.
    const capability = {
      schemaVersion: 1,
      limits: { instructionBytes: 1, selectionBytes: 1, readableTextBytes: 1, requestBytes: 1 },
      supportedCaptureModes: ["metadata"],
      workspaces: [{ id: "w1", label: "Workspace", isDefault: true }],
      appearance: {
        mode: "light",
        cssVars: {},
        radiusBaseRem: 0.625,
        pillRadiusPx: 9999,
        density: "comfortable",
      },
    }
    const host = hostAnswering({ requestId: "r1", result: capability })
    const client = createHostClient({ pairing, signer, fetchImpl: host.fetchImpl })

    await expect(client.capability()).resolves.toEqual(capability)
  })

  it("passes an unwrapped body through, for a plane that does not envelope", async () => {
    const page = { items: [] }
    const host = hostAnswering(page)
    const client = createHostClient({ pairing, signer, fetchImpl: host.fetchImpl })

    await expect(client.list()).resolves.toEqual(page)
  })

  it("sends an idempotency key on the write and on nothing else", async () => {
    // The header is a declaration, not a precaution: only
    // `browser_context_submit` declares `idempotency: "required"`, and the Host
    // answers `idempotency_key_forbidden` to a read that carries one.
    const submissionId = "11111111-2222-3333-4444-555555555555"
    const host = hostAnswering({ requestId: "r1", result: {} })
    const client = createHostClient({ pairing, signer, fetchImpl: host.fetchImpl })

    await client.list()
    await client.submit({
      submissionId,
      workspaceId: "w1",
      instruction: "summarize",
      context: {
        schemaVersion: 1,
        captureMode: "metadata",
        url: "https://example.com/",
        title: "Example",
        capturedAt: NOW,
      },
    })

    const rpcCalls = host.calls.filter((call) => call.path.startsWith("/api/_rpc/"))
    expect(rpcCalls.map((call) => [call.path, call.headers.get("Idempotency-Key")])).toEqual([
      ["/api/_rpc/browser_context_list", null],
      ["/api/_rpc/browser_context_submit", submissionId],
    ])
  })
})
