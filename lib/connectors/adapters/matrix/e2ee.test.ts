import { setConnectorCommandInvoker, type MatrixCryptoOutgoingRequest } from "../../tauri/commands"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import * as matrixPendingEvents from "@/lib/db/matrix-pending-events"
import { MatrixE2EERuntime } from "./e2ee"
import type { MatrixTimelineEvent } from "./parse"

jest.mock("@/lib/db/matrix-pending-events", () => {
  const actual = jest.requireActual("@/lib/db/matrix-pending-events")
  return {
    ...actual,
    persistMatrixPendingEncryptedEvent: jest.fn(actual.persistMatrixPendingEncryptedEvent),
  }
})

const actualPendingEvents = jest.requireActual<typeof matrixPendingEvents>(
  "@/lib/db/matrix-pending-events"
)

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function encryptedEvent(eventId = "$encrypted"): MatrixTimelineEvent {
  return {
    type: "m.room.encrypted",
    event_id: eventId,
    sender: "@alice:example.org",
    origin_server_ts: 1,
    content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "cipher" },
  }
}

function decryptedEnvelope(eventId = "$encrypted") {
  return {
    event: {
      event: {
        type: "m.room.message",
        event_id: eventId,
        sender: "@alice:example.org",
        origin_server_ts: 1,
        content: { msgtype: "m.text", body: "decrypted" },
      },
      encryption_info: {},
    },
  }
}

describe("MatrixE2EERuntime", () => {
  let restoreInvoker: ReturnType<typeof setConnectorCommandInvoker>
  let invoke: jest.Mock

  beforeEach(() => {
    jest
      .mocked(matrixPendingEvents.persistMatrixPendingEncryptedEvent)
      .mockImplementation(actualPendingEvents.persistMatrixPendingEncryptedEvent)
    invoke = jest.fn(async (name: string) => {
      if (name === "connectors_matrix_crypto_outgoing_requests") return []
      return undefined
    })
    restoreInvoker = setConnectorCommandInvoker(invoke)
  })

  afterEach(() => {
    setConnectorCommandInvoker(restoreInvoker)
  })

  function runtime(request = jest.fn(async () => ({}))) {
    return new MatrixE2EERuntime({
      adapterId: "mx-1",
      userId: "@bot:example.org",
      deviceId: "DEVICE",
      request,
      onRecoveredEvent: jest.fn(async () => undefined),
      onDegraded: jest.fn(),
    })
  }

  it("initializes, drains once, and closes the in-memory crypto session", async () => {
    const e2ee = runtime()
    await e2ee.initialize()
    await e2ee.close()

    expect(invoke).toHaveBeenCalledWith("connectors_matrix_crypto_init", {
      req: { adapterId: "mx-1", userId: "@bot:example.org", deviceId: "DEVICE" },
    })
    expect(invoke).toHaveBeenCalledWith("connectors_matrix_crypto_close", {
      adapterId: "mx-1",
    })
  })

  it("marks a crypto request only after the Matrix response succeeds", async () => {
    const outgoing: MatrixCryptoOutgoingRequest = {
      requestId: "request-1",
      kind: "keysUpload",
      method: "POST",
      path: "/_matrix/client/v3/keys/upload",
      body: { device_keys: {} },
    }
    let returnedOutgoing = false
    invoke.mockImplementation(async (name: string) => {
      if (name === "connectors_matrix_crypto_outgoing_requests" && !returnedOutgoing) {
        returnedOutgoing = true
        return [outgoing]
      }
      if (name === "connectors_matrix_crypto_outgoing_requests") return []
      return undefined
    })
    const request = jest.fn(async () => ({ one_time_key_counts: {} }))
    const e2ee = runtime(request)

    await e2ee.initialize()

    expect(request).toHaveBeenCalledWith("POST", outgoing.path, outgoing.body)
    expect(invoke).toHaveBeenCalledWith("connectors_matrix_crypto_mark_request_sent", {
      req: expect.objectContaining({ requestId: "request-1", kind: "keysUpload" }),
    })
    await e2ee.close()
  })

  it("honors Matrix retry_after_ms before marking a crypto request sent", async () => {
    const outgoing: MatrixCryptoOutgoingRequest = {
      requestId: "request-rate-limit",
      kind: "keysQuery",
      method: "POST",
      path: "/_matrix/client/v3/keys/query",
      body: { device_keys: {} },
    }
    let returnedOutgoing = false
    invoke.mockImplementation(async (name: string) => {
      if (name === "connectors_matrix_crypto_outgoing_requests" && !returnedOutgoing) {
        returnedOutgoing = true
        return [outgoing]
      }
      if (name === "connectors_matrix_crypto_outgoing_requests") return []
      return undefined
    })
    const request = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("limited"), { retryAfterMs: 1 }))
      .mockResolvedValueOnce({ failures: {} })
    const e2ee = runtime(request)

    await e2ee.initialize()

    expect(request).toHaveBeenCalledTimes(2)
    const markIndex = invoke.mock.calls.findIndex(
      ([name]) => name === "connectors_matrix_crypto_mark_request_sent"
    )
    expect(markIndex).toBeGreaterThan(-1)
    await e2ee.close()
  })

  it("fails closed when room encryption state cannot be resolved", async () => {
    const request = jest.fn(async () => {
      throw Object.assign(new Error("offline"), { status: 503 })
    })
    const e2ee = runtime(request)
    await e2ee.initialize()

    await expect(e2ee.prepareRoomEvent("!room:example.org", "m.room.message", {})).rejects.toThrow(
      "refusing plaintext"
    )
    await e2ee.close()
  })

  it("passes through confirmed unencrypted rooms and encrypts known encrypted rooms", async () => {
    const request = jest.fn(async (_method: string, path: string) => {
      if (path.endsWith("/joined_members")) return { joined: { "@bot:example.org": {} } }
      throw Object.assign(new Error("missing"), { status: 404 })
    })
    const plain = runtime(request)
    await plain.initialize()
    await expect(
      plain.prepareRoomEvent("!plain:example.org", "m.room.message", { body: "plain" })
    ).resolves.toEqual({ eventType: "m.room.message", content: { body: "plain" } })
    await plain.close()

    invoke.mockImplementation(async (name: string) => {
      if (name === "connectors_matrix_crypto_outgoing_requests") return []
      if (name === "connectors_matrix_crypto_get_missing_sessions") return []
      if (name === "connectors_matrix_crypto_share_room_key") return []
      if (name === "connectors_matrix_crypto_encrypt_event") return { content: { ciphertext: "c" } }
      return undefined
    })
    const encryptedRequest = jest.fn(async (_method: string, path: string) =>
      path.endsWith("/joined_members") ? { joined: { "@bot:example.org": {} } } : {}
    )
    const encrypted = runtime(encryptedRequest)
    await encrypted.initialize()
    await expect(
      encrypted.prepareRoomEvent("!encrypted:example.org", "m.reaction", { key: "👍" })
    ).resolves.toEqual({ eventType: "m.room.encrypted", content: { ciphertext: "c" } })
    await encrypted.close()
  })

  it("applies encryption state before timelines and reconciles only authoritative joined members", async () => {
    invoke.mockImplementation(async (name: string) => {
      if (name === "connectors_matrix_crypto_outgoing_requests") return []
      if (name === "connectors_matrix_crypto_get_missing_sessions") return []
      if (name === "connectors_matrix_crypto_share_room_key") return []
      if (name === "connectors_matrix_crypto_encrypt_event") return { content: { ciphertext: "c" } }
      return undefined
    })
    const request = jest.fn(async (_method: string, path: string) => {
      if (path.endsWith("/joined_members")) {
        return { joined: { "@bot:example.org": {}, "@alice:example.org": {} } }
      }
      throw new Error(`unexpected request ${path}`)
    })
    const e2ee = runtime(request)
    await e2ee.initialize()

    await e2ee.receiveSync(
      {
        next_batch: "s1",
        rooms: {
          join: {
            "!room:example.org": {
              state: {
                events: [
                  {
                    type: "m.room.encryption",
                    state_key: "",
                    event_id: "$enc-state",
                    sender: "@bot:example.org",
                    origin_server_ts: 1,
                    content: { algorithm: "m.megolm.v1.aes-sha2" },
                  },
                  {
                    type: "m.room.member",
                    state_key: "@invitee:example.org",
                    event_id: "$invite",
                    sender: "@bot:example.org",
                    origin_server_ts: 1,
                    content: { membership: "invite" },
                  },
                ],
              },
            },
          },
        },
      },
      false
    )
    await e2ee.prepareRoomEvent("!room:example.org", "m.room.message", { body: "secret" })

    expect(request).toHaveBeenCalledWith(
      "GET",
      "/_matrix/client/v3/rooms/!room%3Aexample.org/joined_members",
      undefined
    )
    expect(invoke).toHaveBeenCalledWith("connectors_matrix_crypto_update_tracked_users", {
      req: {
        adapterId: "mx-1",
        userIds: ["@bot:example.org", "@alice:example.org"],
      },
    })
    await e2ee.close()
  })

  it("unwraps nested decrypted events and persists missing-key events before cursor advance", async () => {
    invoke.mockImplementation(async (name: string) => {
      if (name === "connectors_matrix_crypto_outgoing_requests") return []
      if (name === "connectors_matrix_crypto_decrypt_event") return decryptedEnvelope()
      return undefined
    })
    const e2ee = runtime()
    await e2ee.initialize()
    await expect(e2ee.decryptOrQueue("!room:example.org", encryptedEvent())).resolves.toMatchObject(
      {
        type: "m.room.message",
        event_id: "$encrypted",
        content: { body: "decrypted" },
      }
    )

    invoke.mockRejectedValueOnce(new Error("missing room key"))
    await expect(
      e2ee.decryptOrQueue("!room:example.org", encryptedEvent("$late"))
    ).resolves.toBeNull()
    expect(await getDb().matrixPendingEncryptedEvents.get("mx-1\u0000$late")).toBeDefined()
    expect(e2ee.canAdvanceCursor()).toBe(true)
    await e2ee.close()
  })

  it("holds the cursor until the exact capacity-rejected event is durable on replay", async () => {
    invoke.mockImplementation(async (name: string) => {
      if (name === "connectors_matrix_crypto_outgoing_requests") return []
      if (name === "connectors_matrix_crypto_decrypt_event") throw new Error("missing room key")
      return undefined
    })
    jest
      .spyOn(matrixPendingEvents, "persistMatrixPendingEncryptedEvent")
      .mockResolvedValueOnce({ ok: false, reason: "capacity" })
      .mockResolvedValueOnce({
        ok: true,
        deduplicated: false,
        row: {
          id: "mx-1\u0000$overflow",
          adapterId: "mx-1",
          eventId: "$overflow",
          roomId: "!room:example.org",
          rawEvent: encryptedEvent("$overflow"),
          attempts: 0,
          firstSeenAt: 1,
          updatedAt: 1,
          nextAttemptAt: 1,
          state: "pending",
        },
      })
    const e2ee = runtime()
    await e2ee.initialize()

    await e2ee.decryptOrQueue("!room:example.org", encryptedEvent("$overflow"))
    expect(e2ee.canAdvanceCursor()).toBe(false)

    await e2ee.decryptOrQueue("!room:example.org", encryptedEvent("$overflow"))
    expect(e2ee.canAdvanceCursor()).toBe(true)

    await e2ee.close()
  })
})
