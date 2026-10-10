import {
  parseShareLocation,
  fetchEnvelope,
  decryptEnvelope,
  loadShare,
  openShare,
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
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ passphrase: false, burnAfterRead: false }))
      .mockResolvedValueOnce(jsonResponse({ envelope }))
    const state = await loadShare("https://x", "?c=code", `#k=${encodeShareKey(key)}`, fetchImpl)
    expect(state).toEqual({ status: "ready", payload: PAYLOAD })
  })

  it("errors with not-a-link on a malformed location", async () => {
    const state = await loadShare("https://x", "", "", jest.fn())
    expect(state).toEqual({ status: "error", reason: "not-a-link" })
  })

  it("errors with network when the fetch throws", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("boom"))
    const state = await loadShare(
      "https://x",
      "?c=code",
      `#k=${encodeShareKey(generateShareKey())}`,
      fetchImpl
    )
    expect(state).toEqual({ status: "error", reason: "network" })
  })

  it("returns unavailable on a 404", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ error: "not found" }, 404))
    const state = await loadShare(
      "https://x",
      "?c=code",
      `#k=${encodeShareKey(generateShareKey())}`,
      fetchImpl
    )
    expect(state).toEqual({ status: "unavailable" })
  })
})

describe("protected and limited-view loading", () => {
  it("does not spend a protected burn share until a passphrase is submitted, and retries locally", async () => {
    const key = generateShareKey()
    const envelope = await encryptSharePayload(PAYLOAD, key, "secret")
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ passphrase: true, burnAfterRead: true, maxViews: 1 }))
      .mockResolvedValueOnce(jsonResponse({ envelope }))
    const state = await loadShare("https://x", "?c=code", `#k=${encodeShareKey(key)}`, fetchImpl)
    expect(state).toMatchObject({ status: "passphrase-pending", burnAfterRead: true })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith("https://x/v1/share/code/metadata", {
      cache: "no-store",
    })
    if (state.status !== "passphrase-pending") throw new Error("expected gate")
    const wrong = await openShare(state.request, "wrong", fetchImpl)
    expect(wrong).toMatchObject({ status: "passphrase", wrong: true })
    if (wrong.status !== "passphrase") throw new Error("expected retry")
    expect(await decryptEnvelope(wrong.envelope, wrong.key, "secret")).toEqual({
      status: "ready",
      payload: PAYLOAD,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("requires an explicit open for an unprotected limited-view share", async () => {
    const key = generateShareKey()
    const envelope = await encryptSharePayload(PAYLOAD, key)
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ passphrase: false, burnAfterRead: false, maxViews: 2 }))
      .mockResolvedValueOnce(jsonResponse({ envelope }))
    const state = await loadShare("https://x", "?c=code", `#k=${encodeShareKey(key)}`, fetchImpl)
    expect(state.status).toBe("confirm")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    if (state.status !== "confirm") throw new Error("expected gate")
    expect(await openShare(state.request, undefined, fetchImpl)).toEqual({
      status: "ready",
      payload: PAYLOAD,
    })
  })

  it("rejects an invalid key before any network read", async () => {
    const fetchImpl = jest.fn()
    expect(await loadShare("https://x", "?c=code", "#k=invalid", fetchImpl)).toEqual({
      status: "error",
      reason: "invalid-key",
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("never falls back to a consuming read when metadata is unavailable or malformed", async () => {
    const key = generateShareKey()
    for (const response of [jsonResponse({}, 500), jsonResponse({})]) {
      const fetchImpl = jest.fn().mockResolvedValueOnce(response)
      expect(
        await loadShare("https://x", "?c=code", `#k=${encodeShareKey(key)}`, fetchImpl)
      ).toEqual({ status: "error", reason: "network" })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  })
})

describe("file access (ADR-0222)", () => {
  const FILES: SharePayload = {
    kind: "file-bundle",
    mime: "application/json",
    data: "",
    encoding: "utf8",
    files: [
      {
        blobId: "AAECAwQFBgcICQoLDA0ODw",
        path: "/workspace/a.txt",
        name: "a.txt",
        mime: "text/plain",
        size: 1,
        sha256: "0".repeat(64),
        chunkSize: 4194304,
        chunkCount: 1,
        ivPrefix: "AAAAAAAAAAA=",
      },
    ],
  }

  it("hands the viewer the read ticket and the key material for a share with files", async () => {
    const key = generateShareKey()
    const envelope = await encryptSharePayload(FILES, key)
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ passphrase: false, burnAfterRead: false }))
      .mockResolvedValueOnce(
        jsonResponse({ envelope, readTicket: "123.sig", readTicketExpiresAt: 123 })
      )
    const state = await loadShare("https://x", "?c=code", `#k=${encodeShareKey(key)}`, fetchImpl)
    expect(state).toMatchObject({
      status: "ready",
      payload: FILES,
      files: {
        baseUrl: "https://x",
        code: "code",
        readTicket: "123.sig",
        readTicketExpiresAt: 123,
      },
    })
    if (state.status !== "ready") throw new Error("expected ready")
    expect(Array.from(state.files!.material)).toEqual(Array.from(key))
  })

  it("keeps the ticket through a wrong passphrase and returns passphrase-derived material", async () => {
    const key = generateShareKey()
    const envelope = await encryptSharePayload(FILES, key, "pw")
    const fetchImpl = jest.fn().mockResolvedValueOnce(jsonResponse({ envelope, readTicket: "t" }))
    const wrong = await openShare(
      { baseUrl: "https://x", code: "code", key: encodeShareKey(key) },
      "no",
      fetchImpl
    )
    expect(wrong).toMatchObject({ status: "passphrase", wrong: true, read: { readTicket: "t" } })
    if (wrong.status !== "passphrase") throw new Error("expected retry")
    const ready = await decryptEnvelope(wrong.envelope, wrong.key, "pw", wrong.read)
    expect(ready).toMatchObject({ status: "ready", files: { readTicket: "t", code: "code" } })
    if (ready.status !== "ready") throw new Error("expected ready")
    expect(ready.files!.material).toHaveLength(32)
    expect(Array.from(ready.files!.material)).not.toEqual(Array.from(key))
  })

  it("gives a share without files no file access, and tolerates a server without tickets", async () => {
    const key = generateShareKey()
    const plain = await encryptSharePayload(PAYLOAD, key)
    const withTicket = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ envelope: plain, readTicket: "t" }))
    expect(
      await openShare(
        { baseUrl: "https://x", code: "c", key: encodeShareKey(key) },
        undefined,
        withTicket
      )
    ).toEqual({ status: "ready", payload: PAYLOAD })

    const files = await encryptSharePayload(FILES, key)
    const noTicket = jest.fn().mockResolvedValueOnce(jsonResponse({ envelope: files }))
    const state = await openShare(
      { baseUrl: "https://x", code: "c", key: encodeShareKey(key) },
      undefined,
      noTicket
    )
    expect(state).toMatchObject({ status: "ready", files: { code: "c" } })
    if (state.status !== "ready") throw new Error("expected ready")
    expect(state.files).not.toHaveProperty("readTicket")
  })
})
