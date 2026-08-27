/**
 * Unit tests for the connectors Tauri command wrappers.
 *
 * @tauri-apps/api/core is auto-mocked via jest.config.ts moduleNameMapper →
 * __mocks__/tauri-api.js, which exports `invoke: jest.fn()`.
 */
import { invoke } from "@tauri-apps/api/core"

jest.mock("@/lib/platform/capabilities", () => ({
  ...jest.requireActual("@/lib/platform/capabilities"),
  detectHostProfile: jest.fn(() => "desktop"),
}))
import { transport } from "@/lib/tauri/transport-instance"
import { detectHostProfile } from "@/lib/platform/capabilities"
import { setConnectorDeviceLease } from "@/lib/connectors/device-plane"
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
const mockProfile = detectHostProfile as jest.Mock

beforeEach(() => {
  mockInvoke.mockReset()
  setConnectorDeviceLease(null)
  // The default invoker is no longer unconditional: the four keyring arms
  // ADR-0152 put on the device plane go over the companion transport on a
  // paired shell. Everything below asserts the host-side behaviour unless it
  // says otherwise.
  mockProfile.mockReturnValue("desktop")
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
    await expect(connectorsKeyringGet("tg-personal", "botToken")).resolves.toBe("secret")
  })

  it("returns null when not set", async () => {
    mockInvoke.mockResolvedValueOnce(null)
    await expect(connectorsKeyringGet("tg-personal", "missing")).resolves.toBeNull()
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
// ADR-0152 — the keyring arms on the device plane
// ---------------------------------------------------------------------------

describe("keyring wrappers on a paired shell", () => {
  let call: jest.SpyInstance

  beforeEach(() => {
    mockProfile.mockReturnValue("cloud-companion")
    call = jest.spyOn(transport, "call").mockResolvedValue(undefined as never)
  })

  afterEach(() => call.mockRestore())

  it("routes the read over the transport rather than Tauri invoke", async () => {
    call.mockResolvedValueOnce("secret")

    await expect(connectorsKeyringGet("tg-1", "botToken")).resolves.toBe("secret")

    expect(call).toHaveBeenCalledWith("connectors_keyring_get", {
      adapterId: "tg-1",
      credential: "botToken",
    })
    // The direct import is what used to fail here with a bare
    // `__TAURI_INTERNALS__` error on every companion shell.
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("attaches the admin lease the step-up gate reads", async () => {
    setConnectorDeviceLease("lease-token")

    await connectorsKeyringSet("tg-1", "botToken", "secret")

    expect(call).toHaveBeenCalledWith("connectors_keyring_set", {
      adapterId: "tg-1",
      credential: "botToken",
      value: "secret",
      adminLease: "lease-token",
    })
  })

  it("sends the call without a lease rather than failing locally", async () => {
    // The host answers REMOTE_CONSENT_REQUIRED, which the form turns into
    // "stored, unlock to read" — a local short-circuit could not tell that
    // apart from "no such credential".
    await connectorsKeyringList("slack-1", ["botToken"])

    expect(call).toHaveBeenCalledWith("connectors_keyring_list", {
      adapterId: "slack-1",
      accounts: ["botToken"],
    })
  })

  it("leaves the runtime-process commands on Tauri invoke", async () => {
    mockInvoke.mockResolvedValueOnce(undefined)

    await connectorsStopServer()

    expect(mockInvoke).toHaveBeenCalledWith("connectors_stop_server")
    expect(call).not.toHaveBeenCalled()
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
      cacheKey: "a".repeat(64),
      remoteRef: "file/BQACAgIA123",
      sizeBytes: 20_480,
      createdAt: 1_000,
      lastAccessedAt: 1_000,
      expiresAt: 605_800_000,
      cached: false,
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
      ttlMs: undefined,
    })
  })

  it("passes optional headers for authenticated attachment fetches", async () => {
    const expectedRef: AttachmentRef = {
      cacheKey: "b".repeat(64),
      remoteRef: "mxc://matrix.org/media",
      sizeBytes: 512,
      createdAt: 2_000,
      lastAccessedAt: 2_000,
      cached: true,
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

  /**
   * Every wrapper here is reachable two ways: the desktop calls it over Tauri
   * IPC, and the brain calls the SAME wrapper over companion RPC through
   * `headlessConnectorInvoker` (lib/headless/runtimes/connector-runtime.ts),
   * whose default arm forwards the name verbatim. A wrapper that is only a
   * `#[tauri::command]` therefore fails on a headless host with
   * `CompanionError: the requested command is not registered` — which is what
   * the four `connectors_attachment_*` upkeep commands did, silently, on every
   * housekeeping cycle. Nothing caught it: `audit:companion-command-manifest`
   * checks descriptor↔handler, never wrapper↔remote-plane.
   */
  it("gives every connectors_* command it can send a remote dispatch arm", async () => {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const repoRoot = path.join(__dirname, "..", "..", "..")
    const rpcDir = path.join(repoRoot, "src-tauri", "src", "companion_api", "rpc")
    const rpcRs = path.join(repoRoot, "src-tauri", "src", "companion_api", "rpc.rs")

    const wrapperSource = await fs.readFile(path.join(__dirname, "commands.ts"), "utf8")
    const sent = new Set(
      [...wrapperSource.matchAll(/"(connectors_[a-z0-9_]+)"/g)].map((match) => match[1])
    )
    // A sweep that scanned nothing would pass vacuously.
    expect(sent.size).toBeGreaterThan(30)

    // The two names the headless invoker answers locally: the companion
    // server's /connectors ingress is always mounted and the brain owns no
    // local WS handles, so neither name ever crosses the wire.
    for (const local of ["connectors_start_server", "connectors_stop_server"]) sent.delete(local)
    // ...and the two it renames onto the current arms.
    sent.delete("connectors_register_adapter")
    sent.delete("connectors_unregister_adapter")
    sent.add("connectors_register")
    sent.add("connectors_unregister")

    const known = await fs.readFile(rpcRs, "utf8")
    const dispatchSources = await Promise.all(
      (await fs.readdir(rpcDir))
        // tests.rs names commands as fixtures; a fixture must not stand in for
        // a production arm.
        .filter((name) => name.endsWith(".rs") && name !== "tests.rs")
        .map((name) => fs.readFile(path.join(rpcDir, name), "utf8"))
    )
    const dispatch = [known, ...dispatchSources].join("\n")

    // A wrapper that genuinely cannot cross the wire is listed here WITH a
    // reason, never dropped silently. A stale entry fails below.
    const NOT_YET_REMOTE = new Map([
      [
        "connectors_ensure_server",
        "ADR-0134 remote-document OAuth needs a plaintext loopback listener on a " +
          "specific port to serve Google's redirect URI. A headless host binds only " +
          "the TLS companion listener, so what `ensure` should return there is an " +
          "open design question, not a missing arm.",
      ],
    ])

    const unreachable = [...sent].filter(
      (name) => !known.includes(`"${name}"`) || !new RegExp(`"${name}"\\s*=>`, "u").test(dispatch)
    )
    expect(unreachable.filter((name) => !NOT_YET_REMOTE.has(name))).toEqual([])
    // Once a listed command gains an arm, delete its entry rather than leaving
    // a note that describes a gap nobody has any more.
    expect([...NOT_YET_REMOTE.keys()].filter((name) => !unreachable.includes(name))).toEqual([])
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
