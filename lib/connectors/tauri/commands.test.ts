/**
 * Unit tests for the connectors Tauri command wrappers.
 *
 * @tauri-apps/api/core is auto-mocked via jest.config.ts moduleNameMapper →
 * __mocks__/tauri-api.js, which exports `invoke: jest.fn()`.
 */
import { invoke } from "@tauri-apps/api/core"
import {
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
  connectorsAttachmentFetch,
  type AdapterRegistration,
  type ConnectorsHealth,
  type TauriHttpRequest,
  type TauriHttpResponse,
  type AttachmentRef,
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
    })
  })
})
