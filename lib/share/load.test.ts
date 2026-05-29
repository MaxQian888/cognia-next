import {
  parseShareLocation,
  fetchEnvelope,
  decryptEnvelope,
  loadShare,
  type ShareLoadState,
} from "./load"
import { encryptSharePayload } from "./crypto"
import { generateShareKey, encodeShareKey } from "./keys"
import type { SharePayload, ShareEnvelopeV1 } from "./types"

const PAYLOAD: SharePayload = {
  kind: "chat-md",
  mime: "text/markdown",
  data: "# hello",
  encoding: "utf8",
  title: "Greeting",
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe("parseShareLocation", () => {
  it("extracts code from ?c= and key from #k=", () => {
    expect(parseShareLocation("?c=AbC123", "#k=deadbeef")).toEqual({
      code: "AbC123",
      key: "deadbeef",
    })
  })

  it("tolerates a missing leading ? / #", () => {
    expect(parseShareLocation("c=XyZ", "k=key")).toEqual({ code: "XyZ", key: "key" })
  })

  it("returns null when the code is missing", () => {
    expect(parseShareLocation("", "#k=key")).toBeNull()
  })

  it("returns null when the key is missing", () => {
    expect(parseShareLocation("?c=AbC123", "")).toBeNull()
  })
})

describe("fetchEnvelope", () => {
  it("returns the envelope on 200", async () => {
    const envelope = { v: 1 } as unknown as ShareEnvelopeV1
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ envelope }))
    await expect(fetchEnvelope("https://x", "code", fetchImpl)).resolves.toEqual(envelope)
    expect(fetchImpl).toHaveBeenCalledWith("https://x/v1/share/code", { cache: "no-store" })
  })

  it("returns null on 404", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ error: "not found" }, 404))
    await expect(fetchEnvelope("https://x", "code", fetchImpl)).resolves.toBeNull()
  })

  it("throws on a 5xx", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}, 500))
    await expect(fetchEnvelope("https://x", "code", fetchImpl)).rejects.toThrow("HTTP 500")
  })
})

describe("decryptEnvelope", () => {
  it("decrypts a valid envelope to a ready payload", async () => {
    const key = generateShareKey()
    const envelope = await encryptSharePayload(PAYLOAD, key)
    const state = await decryptEnvelope(envelope, encodeShareKey(key))
    expect(state).toEqual({ status: "ready", payload: PAYLOAD })
  })

  it("asks for a passphrase on a protected envelope when none is given", async () => {
    const key = generateShareKey()
    const envelope = await encryptSharePayload(PAYLOAD, key, "secret")
    const state = await decryptEnvelope(envelope, encodeShareKey(key))
    expect(state.status).toBe("passphrase")
    expect((state as Extract<ShareLoadState, { status: "passphrase" }>).wrong).toBeUndefined()
  })

  it("flags a wrong passphrase", async () => {
    const key = generateShareKey()
    const envelope = await encryptSharePayload(PAYLOAD, key, "secret")
    const state = await decryptEnvelope(envelope, encodeShareKey(key), "nope")
    expect(state).toMatchObject({ status: "passphrase", wrong: true })
  })

  it("reports an invalid-key error on a wrong key", async () => {
    const key = generateShareKey()
    const envelope = await encryptSharePayload(PAYLOAD, key)
    const state = await decryptEnvelope(envelope, encodeShareKey(generateShareKey()))
    expect(state).toEqual({ status: "error", reason: "invalid-key" })
  })
})

describe("loadShare", () => {
  it("parses, fetches and decrypts end-to-end", async () => {
    const key = generateShareKey()
    const envelope = await encryptSharePayload(PAYLOAD, key)
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ envelope }))
    const state = await loadShare("https://x", "?c=code", `#k=${encodeShareKey(key)}`, fetchImpl)
    expect(state).toEqual({ status: "ready", payload: PAYLOAD })
  })

  it("errors with not-a-link on a malformed location", async () => {
    const state = await loadShare("https://x", "", "", jest.fn())
    expect(state).toEqual({ status: "error", reason: "not-a-link" })
  })

  it("errors with network when the fetch throws", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("boom"))
    const state = await loadShare("https://x", "?c=code", "#k=key", fetchImpl)
    expect(state).toEqual({ status: "error", reason: "network" })
  })

  it("returns unavailable on a 404", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ error: "not found" }, 404))
    const state = await loadShare("https://x", "?c=code", "#k=key", fetchImpl)
    expect(state).toEqual({ status: "unavailable" })
  })
})
