/**
 * Unit tests for the connectors Tauri command wrappers.
 *
 * @tauri-apps/api/core is auto-mocked via jest.config.ts moduleNameMapper →
 * __mocks__/tauri-api.js, which exports `invoke: jest.fn()`.
 */
import { invoke } from "@tauri-apps/api/core"
import {
  setConnectorCommandInvoker,
  connectorsRegisterAdapter,
  connectorsUnregisterAdapter,
  connectorsHealth,
  connectorsStartServer,
  connectorsStopServer,
  connectorsKeyringSet,
  connectorsKeyringGet,
  connectorsKeyringDelete,
  connectorsKeyringList,
  connectorsHttpRequest,
  connectorsWsSend,
  connectorsWsClose,
  connectorsResetAllWs,
  connectorsRuntimeLeaseAcquire,
  connectorsRuntimeLeaseRenew,
  connectorsRuntimeLeaseRelease,
  connectorsAttachmentFetch,
  connectorsAttachmentRead,
  connectorsMediaUpload,
  connectorsDiscordUpload,
  connectorsMatrixCryptoInit,
  connectorsMatrixCryptoClose,
  connectorsMatrixCryptoOutgoingRequests,
  connectorsMatrixCryptoMarkRequestSent,
  connectorsMatrixCryptoReceiveSyncChanges,
  connectorsMatrixCryptoDecryptEvent,
  connectorsMatrixCryptoEncryptEvent,
  connectorsMatrixCryptoShareRoomKey,
  connectorsMatrixCryptoUpdateTrackedUsers,
  connectorsMatrixCryptoGetMissingSessions,
  connectorsMatrixCryptoEncryptAttachment,
  connectorsMatrixCryptoDecryptAttachment,
  connectorsMatrixEncryptedMediaUpload,
  connectorsMatrixEncryptedMediaFetch,
  type AdapterRegistration,
  type ConnectorsHealth,
  type TauriHttpRequest,
  type TauriHttpResponse,
  type AttachmentRef,
  type ConnectorMediaUploadRequest,
  type ConnectorDiscordUploadRequest,
  type MatrixCryptoInitRequest,
  type MatrixCryptoOutgoingRequest,
} from "./commands"

const mockInvoke = invoke as jest.Mock

beforeEach(() => {
  mockInvoke.mockReset()
})

// ---------------------------------------------------------------------------
// Task 19 — adapter registry
// ---------------------------------------------------------------------------

describe("connectorsRegisterAdapter", () => {
  it("invokes connectors_register_adapter with correct args", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    const reg: AdapterRegistration = {
      adapterId: "tg-personal",
      adapterType: "telegram",
      webhookPath: "/webhook/telegram/tg-personal",
    }
    await connectorsRegisterAdapter(reg)
    expect(mockInvoke).toHaveBeenCalledWith("connectors_register_adapter", { reg })
  })
})

describe("connectorsUnregisterAdapter", () => {
  it("invokes connectors_unregister_adapter with adapterId", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await connectorsUnregisterAdapter("tg-personal")
    expect(mockInvoke).toHaveBeenCalledWith("connectors_unregister_adapter", {
      adapterId: "tg-personal",
    })
  })
})

describe("connectorsHealth", () => {
  it("returns the ConnectorsHealth payload", async () => {
    const expected: ConnectorsHealth = {
      serverRunning: false,
      boundAddr: null,
      registeredAdapterCount: 0,
    }
    mockInvoke.mockResolvedValueOnce(expected)
    const result = await connectorsHealth()
    expect(result).toEqual(expected)
    expect(mockInvoke).toHaveBeenCalledWith("connectors_health")
  })
})

// ---------------------------------------------------------------------------
// Task 20 — server lifecycle
// ---------------------------------------------------------------------------

describe("connectorsStartServer", () => {
  it("invokes connectors_start_server and returns bound addr", async () => {
    mockInvoke.mockResolvedValueOnce("127.0.0.1:8080")
    const addr = await connectorsStartServer(8080)
    expect(addr).toBe("127.0.0.1:8080")
    expect(mockInvoke).toHaveBeenCalledWith("connectors_start_server", {
      port: 8080,
      bindLoopbackOnly: true,
    })
  })
})

describe("connectorsStopServer", () => {
  it("invokes connectors_stop_server", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await connectorsStopServer()
    expect(mockInvoke).toHaveBeenCalledWith("connectors_stop_server")
  })
})

// ---------------------------------------------------------------------------
// Task 21 — keyring
// ---------------------------------------------------------------------------

describe("connectorsKeyringSet", () => {
  it("invokes connectors_keyring_set with correct args", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await connectorsKeyringSet("tg-personal", "botToken", "secret")
    expect(mockInvoke).toHaveBeenCalledWith("connectors_keyring_set", {
      adapterId: "tg-personal",
      credential: "botToken",
      value: "secret",
    })
  })
})

describe("connectorsKeyringGet", () => {
  it("returns the stored value", async () => {
    mockInvoke.mockResolvedValueOnce("secret")
    const result = await connectorsKeyringGet("tg-personal", "botToken")
    expect(result).toBe("secret")
  })

  it("returns null when not set", async () => {
    mockInvoke.mockResolvedValueOnce(null)
    const result = await connectorsKeyringGet("tg-personal", "missing")
    expect(result).toBeNull()
  })
})

describe("connectorsKeyringDelete", () => {
  it("invokes connectors_keyring_delete", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await connectorsKeyringDelete("tg-personal", "botToken")
    expect(mockInvoke).toHaveBeenCalledWith("connectors_keyring_delete", {
      adapterId: "tg-personal",
      credential: "botToken",
    })
  })
})

describe("connectorsKeyringList", () => {
  it("returns list of found accounts", async () => {
    mockInvoke.mockResolvedValueOnce(["userToken", "botToken"])
    const result = await connectorsKeyringList("slack-work", [
      "userToken",
      "botToken",
      "signingSecret",
    ])
    expect(result).toEqual(["userToken", "botToken"])
    expect(mockInvoke).toHaveBeenCalledWith("connectors_keyring_list", {
      adapterId: "slack-work",
      accounts: ["userToken", "botToken", "signingSecret"],
    })
  })
})

// ---------------------------------------------------------------------------
// Task 22 — HTTP client
// ---------------------------------------------------------------------------

describe("connectorsHttpRequest", () => {
  it("invokes connectors_http_request and returns response", async () => {
    const expectedResp: TauriHttpResponse = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    }
    mockInvoke.mockResolvedValueOnce(expectedResp)
    const req: TauriHttpRequest = {
      url: "https://api.example.com/health",
      method: "GET",
    }
    const result = await connectorsHttpRequest(req)
    expect(result).toEqual(expectedResp)
    expect(mockInvoke).toHaveBeenCalledWith("connectors_http_request", { req })
  })
})

// ---------------------------------------------------------------------------
// Task 23 — WS client
// ---------------------------------------------------------------------------

describe("connectorsWsSend", () => {
  it("invokes connectors_ws_send with handleId and data", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await connectorsWsSend("handle-abc", "ping")
    expect(mockInvoke).toHaveBeenCalledWith("connectors_ws_send", {
      handleId: "handle-abc",
      data: "ping",
    })
  })
})

describe("connectorsWsClose", () => {
  it("invokes connectors_ws_close with handleId", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    await connectorsWsClose("handle-abc")
    expect(mockInvoke).toHaveBeenCalledWith("connectors_ws_close", { handleId: "handle-abc" })
  })
})

describe("connectorsResetAllWs", () => {
  it("invokes connectors_reset_all_ws with no args and returns the reaped count", async () => {
    mockInvoke.mockResolvedValueOnce(3)
    const reaped = await connectorsResetAllWs()
    expect(mockInvoke).toHaveBeenCalledWith("connectors_reset_all_ws")
    expect(reaped).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Task 24 — attachment cache
// ---------------------------------------------------------------------------

describe("connectorsAttachmentFetch", () => {
  it("invokes connectors_attachment_fetch and returns AttachmentRef", async () => {
    const expectedRef: AttachmentRef = {
      localUrl: "/var/data/cognia/connectors/cache/abc123",
      remoteRef: "file/BQACAgIA123",
    }
    mockInvoke.mockResolvedValueOnce(expectedRef)
    const result = await connectorsAttachmentFetch(
      "tg-personal",
      "file/BQACAgIA123",
      "https://cdn.example.com/file.jpg"
    )
    expect(result).toEqual(expectedRef)
    expect(mockInvoke).toHaveBeenCalledWith("connectors_attachment_fetch", {
      adapterId: "tg-personal",
      remoteRef: "file/BQACAgIA123",
      sourceUrl: "https://cdn.example.com/file.jpg",
      headers: undefined,
    })
  })

  it("passes optional headers for authenticated attachment fetches", async () => {
    const expectedRef: AttachmentRef = {
      localUrl: "/var/data/cognia/connectors/cache/mxc",
      remoteRef: "mxc://matrix.org/media",
    }
    mockInvoke.mockResolvedValueOnce(expectedRef)
    const headers = { Authorization: "Bearer tok" }
    await connectorsAttachmentFetch(
      "mx-1",
      "mxc://matrix.org/media",
      "https://matrix.org/_matrix/client/v1/media/download/matrix.org/media",
      headers
    )
    expect(mockInvoke).toHaveBeenCalledWith("connectors_attachment_fetch", {
      adapterId: "mx-1",
      remoteRef: "mxc://matrix.org/media",
      sourceUrl: "https://matrix.org/_matrix/client/v1/media/download/matrix.org/media",
      headers,
    })
  })
})

describe("connectorsAttachmentRead", () => {
  it("invokes connectors_attachment_read with the size cap and returns base64", async () => {
    mockInvoke.mockResolvedValueOnce("aGVsbG8=")
    const result = await connectorsAttachmentRead("mx-1", "mxc://matrix.org/media", 1024)
    expect(result).toBe("aGVsbG8=")
    expect(mockInvoke).toHaveBeenCalledWith("connectors_attachment_read", {
      adapterId: "mx-1",
      remoteRef: "mxc://matrix.org/media",
      maxBytes: 1024,
    })
  })

  it("returns null for uncached or over-cap attachments", async () => {
    mockInvoke.mockResolvedValueOnce(null)
    await expect(connectorsAttachmentRead("mx-1", "mxc://matrix.org/big", 8)).resolves.toBeNull()
  })
})

describe("connectorsMediaUpload", () => {
  it("invokes connectors_media_upload and returns the Matrix content_uri", async () => {
    mockInvoke.mockResolvedValueOnce("mxc://matrix.org/uploaded")
    const req: ConnectorMediaUploadRequest = {
      uploadUrl: "https://matrix.org/_matrix/media/v3/upload?filename=pic.png",
      headers: { Authorization: "Bearer tok" },
      sourceUrl: "https://example.com/pic.png",
      contentType: "image/png",
    }

    await expect(connectorsMediaUpload(req)).resolves.toBe("mxc://matrix.org/uploaded")
    expect(mockInvoke).toHaveBeenCalledWith("connectors_media_upload", { req })
  })
})

describe("connectorsDiscordUpload", () => {
  it("invokes connectors_discord_upload and returns the created message id", async () => {
    mockInvoke.mockResolvedValueOnce("991122334455")
    const req: ConnectorDiscordUploadRequest = {
      botToken: "TOKEN",
      channelId: "chan-1",
      files: [
        { sourceUrl: "https://example.com/pic.png", filename: "pic.png", contentType: "image/png" },
      ],
      flags: 1 << 13,
    }

    await expect(connectorsDiscordUpload(req)).resolves.toBe("991122334455")
    expect(mockInvoke).toHaveBeenCalledWith("connectors_discord_upload", { req })
  })
})

describe("Matrix crypto command wrappers", () => {
  it("initializes the OlmMachine with adapter identity", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    const req: MatrixCryptoInitRequest = {
      adapterId: "mx-1",
      userId: "@bot:matrix.org",
      deviceId: "DEVICEID",
    }

    await connectorsMatrixCryptoInit(req)

    expect(mockInvoke).toHaveBeenCalledWith("connectors_matrix_crypto_init", { req })
  })

  it("closes only the adapter's in-memory crypto session", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)

    await connectorsMatrixCryptoClose("mx-1")

    expect(mockInvoke).toHaveBeenCalledWith("connectors_matrix_crypto_close", {
      adapterId: "mx-1",
    })
  })

  it("returns pending outgoing crypto requests", async () => {
    const expected: MatrixCryptoOutgoingRequest[] = [
      {
        requestId: "txn",
        kind: "keysUpload",
        method: "POST",
        path: "/_matrix/client/v3/keys/upload",
        body: { device_keys: {} },
      },
    ]
    mockInvoke.mockResolvedValueOnce(expected)

    await expect(connectorsMatrixCryptoOutgoingRequests("mx-1")).resolves.toEqual(expected)
    expect(mockInvoke).toHaveBeenCalledWith("connectors_matrix_crypto_outgoing_requests", {
      adapterId: "mx-1",
    })
  })

  it("marks an outgoing crypto request as sent with its server response", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    const req = {
      adapterId: "mx-1",
      requestId: "txn",
      kind: "keysUpload",
      response: { one_time_key_counts: { signed_curve25519: 20 } },
    }

    await connectorsMatrixCryptoMarkRequestSent(req)

    expect(mockInvoke).toHaveBeenCalledWith("connectors_matrix_crypto_mark_request_sent", {
      req,
    })
  })

  it("passes sync crypto deltas into the native machine", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    const req = {
      adapterId: "mx-1",
      toDeviceEvents: [{ type: "m.room_key", content: {} }],
      changedDevices: ["@alice:matrix.org"],
      leftDevices: [],
      oneTimeKeyCounts: { signed_curve25519: 1 },
      unusedFallbackKeys: ["signed_curve25519"],
      nextBatchToken: "s123",
    }

    await connectorsMatrixCryptoReceiveSyncChanges(req)

    expect(mockInvoke).toHaveBeenCalledWith("connectors_matrix_crypto_receive_sync_changes", {
      req,
    })
  })

  it("decrypts an encrypted room event", async () => {
    const expected = { event: { type: "m.room.message", content: { body: "hi" } } }
    mockInvoke.mockResolvedValueOnce(expected)
    const req = { adapterId: "mx-1", roomId: "!r:matrix.org", event: { type: "m.room.encrypted" } }

    await expect(connectorsMatrixCryptoDecryptEvent(req)).resolves.toEqual(expected)
    expect(mockInvoke).toHaveBeenCalledWith("connectors_matrix_crypto_decrypt_event", { req })
  })

  it("encrypts plaintext event content", async () => {
    const expected = { content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "abc" } }
    mockInvoke.mockResolvedValueOnce(expected)
    const req = {
      adapterId: "mx-1",
      roomId: "!r:matrix.org",
      eventType: "m.room.message",
      content: { msgtype: "m.text", body: "hi" },
    }

    await expect(connectorsMatrixCryptoEncryptEvent(req)).resolves.toEqual(expected)
    expect(mockInvoke).toHaveBeenCalledWith("connectors_matrix_crypto_encrypt_event", { req })
  })

  it("uploads and fetches encrypted Matrix media through thin native wrappers", async () => {
    const file = {
      url: "mxc://matrix.org/encrypted",
      key: { kty: "oct" },
      iv: "iv",
      hashes: { sha256: "digest" },
      v: "v2",
    }
    const upload = {
      uploadUrl: "https://matrix.org/_matrix/media/v3/upload",
      sourceUrl: "https://example.com/a.png",
    }
    mockInvoke.mockResolvedValueOnce({ contentUri: file.url, file })
    await expect(connectorsMatrixEncryptedMediaUpload(upload)).resolves.toEqual({
      contentUri: file.url,
      file,
    })
    expect(mockInvoke).toHaveBeenLastCalledWith("connectors_matrix_encrypted_media_upload", {
      req: upload,
    })

    const fetch = {
      adapterId: "mx-1",
      remoteRef: file.url,
      sourceUrl: "https://matrix.org/_matrix/client/v1/media/download/matrix.org/encrypted",
      file,
    }
    mockInvoke.mockResolvedValueOnce({ localUrl: "/cache/plain", remoteRef: file.url })
    await expect(connectorsMatrixEncryptedMediaFetch(fetch)).resolves.toEqual({
      localUrl: "/cache/plain",
      remoteRef: file.url,
    })
    expect(mockInvoke).toHaveBeenLastCalledWith("connectors_matrix_encrypted_media_fetch", {
      req: fetch,
    })
  })

  it("shares a room key and returns to-device requests", async () => {
    const expected: MatrixCryptoOutgoingRequest[] = [
      { requestId: "txn", kind: "toDevice", method: "PUT", path: "/send", body: {} },
    ]
    mockInvoke.mockResolvedValueOnce(expected)
    const req = { adapterId: "mx-1", roomId: "!r:matrix.org", userIds: ["@alice:matrix.org"] }

    await expect(connectorsMatrixCryptoShareRoomKey(req)).resolves.toEqual(expected)
    expect(mockInvoke).toHaveBeenCalledWith("connectors_matrix_crypto_share_room_key", { req })
  })

  it("updates tracked users", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)
    const req = { adapterId: "mx-1", userIds: ["@alice:matrix.org"] }

    await connectorsMatrixCryptoUpdateTrackedUsers(req)

    expect(mockInvoke).toHaveBeenCalledWith("connectors_matrix_crypto_update_tracked_users", {
      req,
    })
  })

  it("requests missing Olm sessions", async () => {
    const expected: MatrixCryptoOutgoingRequest[] = [
      { requestId: "txn", kind: "keysClaim", method: "POST", path: "/keys/claim", body: {} },
    ]
    mockInvoke.mockResolvedValueOnce(expected)
    const req = { adapterId: "mx-1", userIds: ["@alice:matrix.org"] }

    await expect(connectorsMatrixCryptoGetMissingSessions(req)).resolves.toEqual(expected)
    expect(mockInvoke).toHaveBeenCalledWith("connectors_matrix_crypto_get_missing_sessions", {
      req,
    })
  })

  it("encrypts and decrypts attachment bytes", async () => {
    const encrypted = { bytesBase64: "cipher", info: { key: {} } }
    mockInvoke.mockResolvedValueOnce(encrypted)
    await expect(
      connectorsMatrixCryptoEncryptAttachment({ bytesBase64: "plain" })
    ).resolves.toEqual(encrypted)
    expect(mockInvoke).toHaveBeenLastCalledWith("connectors_matrix_crypto_encrypt_attachment", {
      req: { bytesBase64: "plain" },
    })

    const decrypted = { bytesBase64: "plain" }
    mockInvoke.mockResolvedValueOnce(decrypted)
    await expect(
      connectorsMatrixCryptoDecryptAttachment({ bytesBase64: "cipher", info: encrypted.info })
    ).resolves.toEqual(decrypted)
    expect(mockInvoke).toHaveBeenLastCalledWith("connectors_matrix_crypto_decrypt_attachment", {
      req: { bytesBase64: "cipher", info: encrypted.info },
    })
  })
})

// ---------------------------------------------------------------------------
// ADR-0059 T-A5 — swappable command transport (headless brain seam)
// ---------------------------------------------------------------------------

describe("setConnectorCommandInvoker", () => {
  afterEach(() => {
    // Restore the default Tauri transport so this suite can't leak a custom
    // invoker into the wrapper tests above (Jest may interleave describes).
    setConnectorCommandInvoker(null)
  })

  it("routes every wrapper through the custom invoker instead of Tauri invoke", async () => {
    const custom = jest.fn().mockResolvedValue({ status: 200, headers: {}, body: "{}" })
    setConnectorCommandInvoker(custom as never)

    await connectorsHttpRequest({ url: "https://api.example.com", method: "GET" })
    await connectorsKeyringSet("tg-1", "botToken", "secret")

    expect(custom).toHaveBeenCalledWith("connectors_http_request", {
      req: { url: "https://api.example.com", method: "GET" },
    })
    expect(custom).toHaveBeenCalledWith("connectors_keyring_set", {
      adapterId: "tg-1",
      credential: "botToken",
      value: "secret",
    })
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("passing null restores the default Tauri invoke", async () => {
    const custom = jest.fn().mockResolvedValue(undefined)
    setConnectorCommandInvoker(custom as never)
    setConnectorCommandInvoker(null)

    mockInvoke.mockResolvedValueOnce(undefined)
    await connectorsStopServer()

    expect(custom).not.toHaveBeenCalled()
    expect(mockInvoke).toHaveBeenCalledWith("connectors_stop_server")
  })

  it("returns the previously-active invoker so callers can restore it", async () => {
    const first = jest.fn().mockResolvedValue(undefined)
    const second = jest.fn().mockResolvedValue(undefined)

    const initial = setConnectorCommandInvoker(first as never)
    const prev = setConnectorCommandInvoker(second as never)
    expect(prev).toBe(first)

    // Restoring the returned handle re-activates it.
    setConnectorCommandInvoker(prev)
    await connectorsStopServer()
    expect(first).toHaveBeenCalledWith("connectors_stop_server")
    expect(second).not.toHaveBeenCalled()

    setConnectorCommandInvoker(initial)
  })
})

describe("runtime lease wrappers", () => {
  it("passes the owner id and TTL through to each lease arm", async () => {
    const mockInvoke = invoke as jest.Mock
    mockInvoke.mockResolvedValueOnce("acquired").mockResolvedValue(true)

    await expect(connectorsRuntimeLeaseAcquire("desktop:abc", 15_000)).resolves.toBe("acquired")
    expect(mockInvoke).toHaveBeenLastCalledWith("connectors_runtime_lease_acquire", {
      ownerId: "desktop:abc",
      ttlMs: 15_000,
      handoffAware: true,
    })

    await expect(connectorsRuntimeLeaseRenew("brain:abc", 15_000)).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenLastCalledWith("connectors_runtime_lease_renew", {
      ownerId: "brain:abc",
      ttlMs: 15_000,
    })

    await expect(connectorsRuntimeLeaseRelease("brain:abc")).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenLastCalledWith("connectors_runtime_lease_release", {
      ownerId: "brain:abc",
    })
  })

  it("routes through the swappable invoker so the brain reaches the same arms", async () => {
    const calls: string[] = []
    const previous = setConnectorCommandInvoker(async (name) => {
      calls.push(name)
      return false as never
    })
    try {
      // The desktop reaches these over Tauri IPC and the brain over companion
      // RPC; the wrappers must not hard-code either.
      await expect(connectorsRuntimeLeaseAcquire("brain:x", 15_000)).resolves.toBe(false)
      expect(calls).toEqual(["connectors_runtime_lease_acquire"])
    } finally {
      setConnectorCommandInvoker(previous)
    }
  })
})
