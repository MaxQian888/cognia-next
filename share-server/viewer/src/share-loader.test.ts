import { describe, it, expect } from "vitest"
import { parseShareLocation, fetchEnvelope, decryptEnvelope, loadShare } from "./share-loader"
import { encryptSharePayload } from "@/lib/share/crypto"
import { generateShareKey, encodeShareKey } from "@/lib/share/keys"
import type { SharePayload, ShareEnvelopeV1 } from "@/lib/share/types"

const PAYLOAD: SharePayload = {
  kind: "chat-html",
  mime: "text/html",
  data: "<h1>hi</h1>",
  encoding: "utf8",
  title: "T",
}

async function makeShare(passphrase?: string): Promise<{ env: ShareEnvelopeV1; keyB64: string }> {
  const key = generateShareKey()
  const env = await encryptSharePayload(PAYLOAD, key, passphrase)
  return { env, keyB64: encodeShareKey(key) }
}

function jsonResponse(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response
}

describe("parseShareLocation", () => {
  it("extracts code and key", () => {
    expect(parseShareLocation("/v/AbC123", "#k=deadbeef")).toEqual({
      code: "AbC123",
      key: "deadbeef",
    })
  })
  it("tolerates a trailing slash and url-encoded code", () => {
    expect(parseShareLocation("/v/a%2Fb/", "#k=x")).toEqual({ code: "a/b", key: "x" })
  })
  it("returns null without a key or a /v/ path", () => {
    expect(parseShareLocation("/v/AbC123", "")).toBeNull()
    expect(parseShareLocation("/other", "#k=x")).toBeNull()
  })
})

describe("fetchEnvelope", () => {
  it("returns the envelope on 200", async () => {
    const { env } = await makeShare()
    const got = await fetchEnvelope("", "code", async () => jsonResponse(200, { envelope: env }))
    expect(got).toEqual(env)
  })
  it("returns null on 404", async () => {
    expect(await fetchEnvelope("", "code", async () => jsonResponse(404, {}))).toBeNull()
  })
  it("throws on other errors", async () => {
    await expect(fetchEnvelope("", "code", async () => jsonResponse(500, {}))).rejects.toThrow()
  })
})

describe("decryptEnvelope", () => {
  it("returns ready on the right key", async () => {
    const { env, keyB64 } = await makeShare()
    expect(await decryptEnvelope(env, keyB64)).toEqual({ status: "ready", payload: PAYLOAD })
  })
  it("returns error on the wrong key", async () => {
    const { env } = await makeShare()
    const wrong = encodeShareKey(generateShareKey())
    expect((await decryptEnvelope(env, wrong)).status).toBe("error")
  })
  it("asks for a passphrase when one is required", async () => {
    const { env, keyB64 } = await makeShare("secret")
    const state = await decryptEnvelope(env, keyB64)
    expect(state.status).toBe("passphrase")
  })
  it("flags a wrong passphrase", async () => {
    const { env, keyB64 } = await makeShare("secret")
    const state = await decryptEnvelope(env, keyB64, "nope")
    expect(state).toMatchObject({ status: "passphrase", wrong: true })
  })
  it("decrypts with the correct passphrase", async () => {
    const { env, keyB64 } = await makeShare("secret")
    expect(await decryptEnvelope(env, keyB64, "secret")).toEqual({
      status: "ready",
      payload: PAYLOAD,
    })
  })
})

describe("loadShare", () => {
  it("end-to-end: parse → fetch → decrypt", async () => {
    const { env, keyB64 } = await makeShare()
    const state = await loadShare("", "/v/abc", `#k=${keyB64}`, async () =>
      jsonResponse(200, { envelope: env })
    )
    expect(state).toEqual({ status: "ready", payload: PAYLOAD })
  })
  it("reports unavailable on 404", async () => {
    const state = await loadShare("", "/v/abc", "#k=AAAA", async () => jsonResponse(404, {}))
    expect(state.status).toBe("unavailable")
  })
  it("errors on a malformed link", async () => {
    const state = await loadShare("", "/nope", "", async () => jsonResponse(200, {}))
    expect(state.status).toBe("error")
  })
  it("errors when the server is unreachable", async () => {
    const state = await loadShare("", "/v/abc", "#k=AAAA", async () => {
      throw new Error("network")
    })
    expect(state).toMatchObject({ status: "error" })
  })
})
