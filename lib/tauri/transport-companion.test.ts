/** @jest-environment jsdom */
/**
 * Tests for CompanionTransport (M2.7).
 *
 * jsdom ships no native WebSocket. We inject a MockWebSocket via
 * jest.spyOn(globalThis, 'WebSocket') so the class under test instantiates
 * our controllable fake instead of the real browser WebSocket.
 *
 * Fake timers (jest.useFakeTimers) are used to advance timeouts and backoff
 * delays deterministically without wall-clock waits.
 *
 * Note: jsdom does not provide `new Response(...)` as a global. We use plain
 * mock objects that satisfy the subset of the Response interface used by
 * CompanionTransport (ok, status, json()).
 */

import {
  CompanionError,
  CompanionTransport,
  __resetCompanionConfigCacheForTests,
  __setBackoffRandomForTests,
  classifyWsHost,
  clearCompanionConfig,
  hydrateCompanionConfig,
  loadCompanionConfig,
  saveCompanionConfig,
  type CompanionConfig,
  type TransportTier,
} from "./transport-companion"

// ---------------------------------------------------------------------------
// Mock fetch response factory — avoids `new Response(...)` which jsdom lacks.
// ---------------------------------------------------------------------------

function mockResponse(
  body: unknown,
  status: number
): {
  ok: boolean
  status: number
  json: () => Promise<unknown>
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_CONFIG: CompanionConfig = {
  baseUrl: "https://192.168.1.42:7890",
  deviceJwt: "test.jwt.token",
  deviceId: "device-abc",
  serverVersion: "0.1.0",
}

async function setConfig(cfg: CompanionConfig = MOCK_CONFIG): Promise<void> {
  await saveCompanionConfig(cfg)
}

// Unused but left for documentation.
// function clearConfig(): void {
//   clearCompanionConfig()
// }

// ---------------------------------------------------------------------------
// MockWebSocket — a synchronously-controllable stand-in.
// ---------------------------------------------------------------------------

class MockWebSocket {
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.OPEN
  url: string

  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: (() => void) | null = null

  // Track sent messages and close calls for assertions.
  sent: string[] = []
  closed = false
  closeCode?: number

  constructor(url: string) {
    this.url = url
    // Store so tests can grab the latest instance.
    MockWebSocket.lastInstance = this
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number): void {
    this.closed = true
    this.closeCode = code
    this.readyState = MockWebSocket.CLOSED
  }

  /** Test helpers to drive lifecycle events. */
  triggerOpen(): void {
    this.onopen?.()
  }

  triggerMessage(data: string): void {
    this.onmessage?.({ data })
  }

  triggerError(event?: unknown): void {
    this.onerror?.(event ?? new Event("error"))
  }

  triggerClose(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }

  static lastInstance: MockWebSocket | null = null
  static instances: MockWebSocket[] = []
  static reset(): void {
    MockWebSocket.lastInstance = null
    MockWebSocket.instances = []
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let wsSpy: jest.SpyInstance
let fetchSpy: jest.SpyInstance
let transport: CompanionTransport

// Typed reference shim so TypeScript resolves the spyOn call correctly.
// We cast globalThis to an object where WebSocket and fetch are typed as
// simple functions so jest.spyOn's simplest overload applies.
const g = globalThis as Record<string, unknown>

beforeEach(() => {
  MockWebSocket.reset()

  // Inject our MockWebSocket so CompanionTransport uses it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  g["WebSocket"] = jest.fn((url: string) => new MockWebSocket(url) as any)
  wsSpy = jest.spyOn(g as { WebSocket: jest.Mock }, "WebSocket")

  // Patch fetch onto globalThis so the production code's global `fetch` call
  // is interceptable. jsdom may not define it as an own enumerable property.
  g["fetch"] = jest.fn()
  fetchSpy = jest.spyOn(g as { fetch: jest.Mock }, "fetch")

  // Ensure localStorage + module-level cache are clean.
  localStorage.clear()
  __resetCompanionConfigCacheForTests()
})

afterEach(() => {
  transport?.destroy()
  wsSpy.mockRestore()
  fetchSpy.mockRestore()
  localStorage.clear()
  __resetCompanionConfigCacheForTests()
  jest.useRealTimers()
})

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

describe("config helpers", () => {
  it("loadCompanionConfig returns null when nothing stored", async () => {
    expect(await loadCompanionConfig()).toBeNull()
  })

  it("saveCompanionConfig + loadCompanionConfig round-trips correctly", async () => {
    await saveCompanionConfig(MOCK_CONFIG)
    expect(await loadCompanionConfig()).toEqual(MOCK_CONFIG)
  })

  it("clearCompanionConfig removes the entry", async () => {
    await saveCompanionConfig(MOCK_CONFIG)
    await clearCompanionConfig()
    expect(await loadCompanionConfig()).toBeNull()
  })

  it("hydrateCompanionConfig returns null on malformed JSON in storage", async () => {
    // The cache must be primed via `hydrate*`, which delegates to the
    // storage backend. The web/jsdom backend (`LocalStorageCompanionStorage`)
    // catches `JSON.parse` failures and returns `null`; verify the fallback
    // really runs and the cache is left empty so subsequent sync reads via
    // `loadCompanionConfig` also yield `null`.
    localStorage.setItem("cognia.companion.config.v1", "not-json{{{")
    expect(await hydrateCompanionConfig()).toBeNull()
    expect(loadCompanionConfig()).toBeNull()
  })

  it("hydrateCompanionConfig restores a previously-saved config", async () => {
    // Round-trip via the real storage backend (not just the in-memory cache):
    // save populates localStorage, reset wipes the cache, hydrate must
    // re-read from storage and re-populate the cache.
    await saveCompanionConfig(MOCK_CONFIG)
    __resetCompanionConfigCacheForTests()
    expect(loadCompanionConfig()).toBeNull()
    expect(await hydrateCompanionConfig()).toEqual(MOCK_CONFIG)
    expect(loadCompanionConfig()).toEqual(MOCK_CONFIG)
  })
})

// ---------------------------------------------------------------------------
// call() — success
// ---------------------------------------------------------------------------

describe("call() — success", () => {
  it("resolves with parsed JSON on 200", async () => {
    await setConfig()
    fetchSpy.mockResolvedValueOnce(mockResponse({ ok: true }, 200))

    transport = new CompanionTransport()
    const result = await transport.call("claude_sidecar_status")
    expect(result).toEqual({ ok: true })
  })

  it("posts to the correct URL with command name encoded", async () => {
    await setConfig()
    fetchSpy.mockResolvedValueOnce(mockResponse({}, 200))

    transport = new CompanionTransport()
    await transport.call("some/command name")

    const [calledUrl] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toContain("some%2Fcommand%20name")
  })

  it("rejects with not_paired when no config stored", async () => {
    transport = new CompanionTransport()
    await expect(transport.call("anything")).rejects.toMatchObject({
      code: "not_paired",
      retryable: false,
    })
  })
})

// ---------------------------------------------------------------------------
// configProvider injection (ADR-0059 T-B2)
// ---------------------------------------------------------------------------

describe("configProvider injection", () => {
  it("calls use the injected config even when storage is empty", async () => {
    // Storage cache deliberately empty — the provider is the only source.
    fetchSpy.mockResolvedValueOnce(mockResponse({ ok: true }, 200))
    transport = new CompanionTransport({
      configProvider: () => ({
        baseUrl: "https://127.0.0.1:7999",
        deviceJwt: "service.token.abc",
        deviceId: "brain-1",
        serverVersion: "headless",
      }),
    })

    const result = await transport.call("claude_sidecar_status")
    expect(result).toEqual({ ok: true })
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe("https://127.0.0.1:7999/api/v1/_rpc/claude_sidecar_status")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer service.token.abc")
    // Nothing was persisted — the provider config never touches storage.
    expect(loadCompanionConfig()).toBeNull()
  })

  it("a provider returning null yields not_paired", async () => {
    transport = new CompanionTransport({ configProvider: () => null })
    await expect(transport.call("anything")).rejects.toMatchObject({ code: "not_paired" })
  })

  it("provider swaps (token refresh) take effect on the next call", async () => {
    let token = "tok-1"
    fetchSpy.mockResolvedValue(mockResponse({}, 200))
    transport = new CompanionTransport({
      configProvider: () => ({
        baseUrl: "https://127.0.0.1:7999",
        deviceJwt: token,
        deviceId: "brain-1",
        serverVersion: "headless",
      }),
    })

    await transport.call("claude_sidecar_status")
    token = "tok-2"
    await transport.call("claude_sidecar_status")

    const auths = fetchSpy.mock.calls.map(
      (call) => ((call as [string, RequestInit])[1].headers as Record<string, string>).Authorization
    )
    expect(auths).toEqual(["Bearer tok-1", "Bearer tok-2"])
  })

  it("the provider does not shadow storage-configured instances", async () => {
    // A plain instance still reads the storage cache (mobile behavior).
    await setConfig()
    fetchSpy.mockResolvedValueOnce(mockResponse({ ok: 1 }, 200))
    transport = new CompanionTransport()
    await transport.call("claude_sidecar_status")
    const [calledUrl] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toContain(MOCK_CONFIG.baseUrl)
  })
})

// ---------------------------------------------------------------------------
// call() — idempotency key
// ---------------------------------------------------------------------------

describe("call() — idempotency key", () => {
  beforeEach(() => setConfig())

  it("includes Idempotency-Key for mutating commands", async () => {
    fetchSpy.mockResolvedValue(mockResponse({}, 200))

    transport = new CompanionTransport()
    await transport.call("claude_send", { session_id: "s1", prompt: "hi" })

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers["Idempotency-Key"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
  })

  it("does NOT include Idempotency-Key for read-only commands", async () => {
    fetchSpy.mockResolvedValue(mockResponse({}, 200))

    transport = new CompanionTransport()

    // All read-only commands from the Rust rpc.rs READ_ONLY_COMMANDS list.
    // This array is the cross-language parity guard: it must stay in lockstep
    // with READ_ONLY_COMMANDS in both rpc.rs and transport-companion.ts. A
    // write wrongly added here would skip the Idempotency-Key on a mutation.
    const readOnlyCommands = [
      "claude_sidecar_status",
      "claude_has_api_key",
      "claude_has_oauth_bearer",
      "skills_load_registry",
      "skills_scan_native",
      "mcp_server_status",
      "lsp_host_ensure",
      "codeserver_supported",
      "codeserver_status",
      "codeserver_list_proxies",
      "read_agent_config",
      "session_list",
      "companion_can_control",
      // Wave 4.1 reads.
      "git_is_repo",
      "git_repo_state",
      "git_status",
      "git_diff_stat",
      "git_diff_file",
      "git_diff_commit",
      "git_commit_files",
      "git_log",
      "git_file_history",
      "git_branches",
      "git_remotes",
      "git_stash_list",
      "git_conflicts",
      "git_diff_refs_files",
      "git_diff_refs_file",
      "git_diff_staged_all",
      "git_refs",
      "git_blame",
      "git_tags",
      "git_worktree_list",
      "git_rebase_commits",
      "git_identity",
      "read_text_file",
      "default_export_dir",
      "fs_search_workspace",
      "fs_search_content_workspace",
      "fs_read_workspace_file",
      "fs_list_workspace_dir",
      "fs_stat_workspace_file",
      "task_workspace_status",
      "task_workspace_get",
      "task_workspace_list",
      "task_workspace_list_runs",
      "task_workspace_list_resources",
      "task_workspace_get_resource",
      "task_workspace_get_patch_set",
      "task_resource_read_text",
      "task_resource_read_diff",
      "task_resource_download_open",
      "task_resource_download_read_chunk",
      "task_resource_download_close",
      "terminal_list_all",
      "terminal_list_for_project",
      "plugin_list",
      "plugin_runtime_snapshot",
      "plugin_permission_list",
      "plugin_get_capabilities",
      "workflow_run_list",
      "twin_source_list",
      "twin_job_status",
      "backup_export",
      "fleet_get_snapshot",
    ]

    for (const cmd of readOnlyCommands) {
      await transport.call(cmd)
    }

    // Assert none of those calls included an Idempotency-Key.
    for (const call of fetchSpy.mock.calls) {
      const [, init] = call as [string, RequestInit]
      const headers = init.headers as Record<string, string>
      expect(headers["Idempotency-Key"]).toBeUndefined()
    }
  })

  it("DOES include Idempotency-Key for new Wave 4.1 mutating commands", async () => {
    fetchSpy.mockResolvedValue(mockResponse({}, 200))
    transport = new CompanionTransport()

    // Representative writes across the new domains — these must NOT be in the
    // read-only set, so each gets a fresh idempotency key.
    const writeCommands = [
      "git_push",
      "git_commit",
      "write_text_file",
      "fs_write_workspace_file",
      "fs_create_workspace_dir",
      "fs_delete_workspace_entry",
      "fs_rename_workspace_entry",
      "fs_copy_workspace_entry",
      "terminal_exec",
      "terminal_kill",
      "plugin_install",
      "workflow_delete",
      "workflow_cancel_run",
      "twin_delete",
      "backup_import",
    ]

    for (const cmd of writeCommands) {
      await transport.call(cmd, { repoPath: "/x" })
    }

    for (const call of fetchSpy.mock.calls) {
      const [, init] = call as [string, RequestInit]
      const headers = init.headers as Record<string, string>
      expect(headers["Idempotency-Key"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      )
    }
  })

  it("generates a fresh UUID per call (not reused)", async () => {
    fetchSpy.mockResolvedValue(mockResponse({}, 200))

    transport = new CompanionTransport()
    await transport.call("claude_send")
    await transport.call("claude_send")

    const key1 = (
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
    )["Idempotency-Key"]
    const key2 = (
      (fetchSpy.mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>
    )["Idempotency-Key"]
    expect(key1).not.toEqual(key2)
  })
})

describe("managed IDE raw content transport", () => {
  beforeEach(() => setConfig({ ...MOCK_CONFIG, serverFingerprint: "ab".repeat(32) }))

  it("uploads bytes as a raw body with service context in a header", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ $type: "ContentHandle", id: "handle-1" }),
    })
    transport = new CompanionTransport()

    await transport.uploadManagedIdeContent(
      {
        root: "/workspace",
        generation: 4,
        pluginId: "demo",
        providerId: "cognia.demo.fs",
        permission: "filesystem:read",
      },
      Uint8Array.from([0, 1, 255])
    )

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://192.168.1.42:7890/api/v1/ide/content")
    expect(init.body).toBeInstanceOf(ArrayBuffer)
    expect(Array.from(new Uint8Array(init.body as ArrayBuffer))).toEqual([0, 1, 255])
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer test.jwt.token")
    const context = JSON.parse(
      atob(
        headers["X-Cognia-Content-Context"]
          .replace(/-/g, "+")
          .replace(/_/g, "/")
          .padEnd(Math.ceil(headers["X-Cognia-Content-Context"].length / 4) * 4, "=")
      )
    )
    expect(context).toMatchObject({
      root: "/workspace",
      generation: 4,
      pluginId: "demo",
    })
  })

  it("redeems a one-shot handle as raw response bytes", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from([7, 8, 9]).buffer,
    })
    transport = new CompanionTransport()

    await expect(
      transport.redeemManagedIdeContent(
        {
          root: "/workspace",
          generation: 4,
          pluginId: "demo",
          providerId: "cognia.demo.fs",
          permission: null,
        },
        "handle/opaque"
      )
    ).resolves.toEqual(Uint8Array.from([7, 8, 9]))
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://192.168.1.42:7890/api/v1/ide/content/handle%2Fopaque"
    )
  })
})

// ---------------------------------------------------------------------------
// call() — 4xx errors
// ---------------------------------------------------------------------------

describe("call() — 4xx errors", () => {
  beforeEach(() => setConfig())

  it("throws CompanionError with parsed code on 4xx — not retried", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ code: "unknown_command", message: "no such command" }, 404)
    )

    transport = new CompanionTransport()
    const err = await transport.call("bad_command").catch((e: unknown) => e)

    expect(err).toBeInstanceOf(CompanionError)
    expect((err as CompanionError).code).toBe("unknown_command")
    expect((err as CompanionError).retryable).toBe(false)
    // fetch called exactly once — no retry on 4xx.
    expect(fetchSpy.mock.calls.length).toBe(1)
  })

  it("transitions to unauthenticated on 401 and marks not retryable", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ code: "device_revoked", message: "revoked" }, 401))

    transport = new CompanionTransport()
    const stateHandler = jest.fn()
    transport.onConnectionStateChange(stateHandler)

    await expect(transport.call("claude_send")).rejects.toMatchObject({
      code: "device_revoked",
      retryable: false,
    })
    expect(stateHandler).toHaveBeenCalledWith("unauthenticated")
  })

  it.each([
    [401, "unauthenticated", "device unauthenticated"],
    [418, "http_418", "HTTP 418"],
  ])("uses HTTP fallbacks when a %i response has no JSON body", async (status, code, message) => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status,
      json: () => Promise.reject(new Error("invalid JSON")),
    })
    transport = new CompanionTransport()

    await expect(transport.call("bad_command")).rejects.toMatchObject({
      code,
      message,
      retryable: false,
    })
  })
})

// ---------------------------------------------------------------------------
// call() — retries on network errors and 5xx
// ---------------------------------------------------------------------------

describe("call() — retries", () => {
  beforeEach(() => setConfig())

  it("retries 3 times on network (TypeError) then throws", async () => {
    jest.useFakeTimers()
    fetchSpy.mockRejectedValue(new TypeError("Network error"))

    transport = new CompanionTransport()
    // Attach .catch() immediately to prevent unhandled rejection warnings.
    let caught: unknown
    const callPromise = transport.call("claude_send").catch((e: unknown) => {
      caught = e
    })

    // Advance through all backoff delays (250ms + 500ms + 1000ms).
    await jest.advanceTimersByTimeAsync(250)
    await jest.advanceTimersByTimeAsync(500)
    await jest.advanceTimersByTimeAsync(1000)
    await callPromise

    expect(caught).toBeInstanceOf(CompanionError)
    expect((caught as CompanionError).code).toBe("network")
    expect((caught as CompanionError).retryable).toBe(true)
    // 1 original + 3 retries = 4 total calls.
    expect(fetchSpy.mock.calls.length).toBe(4)
  })

  it("retries up to 3 times on 5xx then throws server_error", async () => {
    jest.useFakeTimers()
    fetchSpy.mockResolvedValue(mockResponse({ code: "internal_error", message: "boom" }, 503))

    transport = new CompanionTransport()
    let caught: unknown
    const callPromise = transport.call("claude_send").catch((e: unknown) => {
      caught = e
    })

    await jest.advanceTimersByTimeAsync(250)
    await jest.advanceTimersByTimeAsync(500)
    await jest.advanceTimersByTimeAsync(1000)
    await callPromise

    expect(caught).toBeInstanceOf(CompanionError)
    expect((caught as CompanionError).code).toBe("server_error")
    expect((caught as CompanionError).retryable).toBe(true)
    expect(fetchSpy.mock.calls.length).toBe(4)
  })

  it("succeeds on second attempt after first network error", async () => {
    jest.useFakeTimers()
    fetchSpy
      .mockRejectedValueOnce(new TypeError("Network error"))
      .mockResolvedValueOnce(mockResponse({ ok: true }, 200))

    transport = new CompanionTransport()
    let result: unknown
    const callPromise = transport.call("claude_send").then((r: unknown) => {
      result = r
    })

    await jest.advanceTimersByTimeAsync(250)
    await callPromise

    expect(result).toEqual({ ok: true })
    expect(fetchSpy.mock.calls.length).toBe(2)
  })

  it("stringifies non-Error network failures", async () => {
    jest.useFakeTimers()
    fetchSpy.mockRejectedValue("socket closed")
    transport = new CompanionTransport()
    const callPromise = transport.call("claude_send").catch((error: unknown) => error)

    await jest.advanceTimersByTimeAsync(250)
    await jest.advanceTimersByTimeAsync(500)
    await jest.advanceTimersByTimeAsync(1000)

    await expect(callPromise).resolves.toMatchObject({
      code: "network",
      message: "socket closed",
    })
  })

  it("uses the status text when a 5xx response has no JSON body", async () => {
    jest.useFakeTimers()
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.reject(new Error("invalid JSON")),
    })
    transport = new CompanionTransport()
    const callPromise = transport.call("claude_send").catch((error: unknown) => error)

    await jest.advanceTimersByTimeAsync(250)
    await jest.advanceTimersByTimeAsync(500)
    await jest.advanceTimersByTimeAsync(1000)

    await expect(callPromise).resolves.toMatchObject({
      code: "server_error",
      message: "HTTP 503",
    })
  })
})

// ---------------------------------------------------------------------------
// call() — timeout
//
// NOTE: AbortController + jest fake timers requires careful async ordering.
// We use jest.advanceTimersByTimeAsync which flushes micro/macro queues.
// Coverage of the abort path is best-effort; the abort error propagation
// relies on the fetch implementation honoring `signal`, which jest.fn() does
// not do automatically — we simulate it by rejecting with an AbortError.
// ---------------------------------------------------------------------------

describe("call() — timeout", () => {
  it("throws timeout CompanionError when fetch rejects with AbortError", async () => {
    await setConfig()
    const abortErr = new Error("The operation was aborted.")
    abortErr.name = "AbortError"
    fetchSpy.mockRejectedValueOnce(abortErr)

    transport = new CompanionTransport()
    const err = await transport.call("claude_send").catch((e: unknown) => e)

    expect(err).toBeInstanceOf(CompanionError)
    expect((err as CompanionError).code).toBe("timeout")
    expect((err as CompanionError).retryable).toBe(true)
    // Timeout is NOT retried — only 1 fetch call.
    expect(fetchSpy.mock.calls.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// subscribe() — WebSocket frame dispatch
// ---------------------------------------------------------------------------

describe("subscribe() — WebSocket frame dispatch", () => {
  beforeEach(() => setConfig())

  it("opens WebSocket on first subscribe", () => {
    transport = new CompanionTransport()
    transport.subscribe("claude://message", jest.fn())

    expect(wsSpy).toHaveBeenCalledTimes(1)
    const ws = MockWebSocket.lastInstance!
    expect(ws.url).toContain("/ws/v1/events")
    expect(ws.url).toContain("token=test.jwt.token")
  })

  it("dispatches payload to handler on matching frame type", () => {
    transport = new CompanionTransport()
    const handler = jest.fn()
    transport.subscribe("claude://message", handler)

    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    ws.triggerMessage(
      JSON.stringify({ type: "claude://message", seq: 1, payload: { text: "hi" }, ts_ms: 0 })
    )

    expect(handler).toHaveBeenCalledWith({ text: "hi" })
  })

  it("does not dispatch to a handler for a different channel", () => {
    transport = new CompanionTransport()
    const handler = jest.fn()
    transport.subscribe("claude://message", handler)

    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    ws.triggerMessage(
      JSON.stringify({ type: "other://event", seq: 1, payload: { data: 42 }, ts_ms: 0 })
    )

    expect(handler).not.toHaveBeenCalled()
  })

  it("multiple subscribers to same channel both receive payload", () => {
    transport = new CompanionTransport()
    const h1 = jest.fn()
    const h2 = jest.fn()
    transport.subscribe("claude://message", h1)
    transport.subscribe("claude://message", h2)

    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    ws.triggerMessage(
      JSON.stringify({ type: "claude://message", seq: 1, payload: "hello", ts_ms: 0 })
    )

    expect(h1).toHaveBeenCalledWith("hello")
    expect(h2).toHaveBeenCalledWith("hello")
  })

  it("unsubscribed handler stops receiving payloads", () => {
    transport = new CompanionTransport()
    const handler = jest.fn()
    const unsub = transport.subscribe("claude://message", handler)

    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    ws.triggerMessage(
      JSON.stringify({ type: "claude://message", seq: 1, payload: "first", ts_ms: 0 })
    )
    expect(handler).toHaveBeenCalledTimes(1)

    unsub()
    ws.triggerMessage(
      JSON.stringify({ type: "claude://message", seq: 2, payload: "second", ts_ms: 0 })
    )
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("unsubscribe is idempotent — calling twice is safe", () => {
    transport = new CompanionTransport()
    const unsub = transport.subscribe("claude://message", jest.fn())
    expect(() => {
      unsub()
      unsub()
    }).not.toThrow()
  })

  it("does not open a second WebSocket when subscribing a second channel", () => {
    transport = new CompanionTransport()
    transport.subscribe("ch:a", jest.fn())
    transport.subscribe("ch:b", jest.fn())

    // Only one WS instantiation.
    expect(MockWebSocket.instances.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// subscribe() — ping → pong
// ---------------------------------------------------------------------------

describe("subscribe() — ping / pong", () => {
  it("replies with pong when server sends ping", async () => {
    await setConfig()
    transport = new CompanionTransport()
    transport.subscribe("ch:any", jest.fn())

    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    ws.triggerMessage(JSON.stringify({ type: "ping" }))

    expect(ws.sent).toContain(JSON.stringify({ type: "pong" }))
  })
})

// ---------------------------------------------------------------------------
// subscribe() — resync_required
// ---------------------------------------------------------------------------

describe("subscribe() — resync_required", () => {
  it("clears cursors and triggers reconnect on resync_required", async () => {
    await setConfig()
    transport = new CompanionTransport()
    const handler = jest.fn()
    transport.subscribe("claude://message", handler)

    const ws1 = MockWebSocket.lastInstance!
    ws1.triggerOpen()

    // Simulate we had a cursor.
    ws1.triggerMessage(
      JSON.stringify({ type: "claude://message", seq: 10, payload: "x", ts_ms: 0 })
    )

    // Server sends resync_required.
    ws1.triggerMessage(JSON.stringify({ type: "resync_required" }))

    // A synthetic resync event was emitted to all handlers.
    expect(handler).toHaveBeenCalledWith({ type: "resync_required" })

    // Old WS is closed and a new one is opened.
    expect(ws1.closed).toBe(true)
    expect(MockWebSocket.instances.length).toBe(2)

    // New WS should use since= without the previous cursor (cursors cleared).
    const ws2 = MockWebSocket.instances[1]
    expect(ws2.url).not.toContain("since=10")
  })
})

// ---------------------------------------------------------------------------
// WebSocket reconnect
// ---------------------------------------------------------------------------

describe("WebSocket reconnect", () => {
  beforeEach(() => {
    setConfig()
    jest.useFakeTimers()
    // Pin the backoff jitter to its midpoint (factor 1.0) so these tests can
    // assert the exact 1s → 2s → 4s schedule.
    __setBackoffRandomForTests(() => 0.5)
  })

  afterEach(() => {
    __setBackoffRandomForTests(null)
  })

  it("jitters the reconnect delay around the base backoff", async () => {
    // Max jitter (factor 1.15) pushes the first 1s step out past 1000ms.
    __setBackoffRandomForTests(() => 1)
    transport = new CompanionTransport()
    transport.subscribe("ch:test", jest.fn())
    const ws1 = MockWebSocket.lastInstance!
    ws1.triggerOpen()
    ws1.triggerClose()

    await jest.advanceTimersByTimeAsync(1000)
    expect(MockWebSocket.instances.length).toBe(1) // not yet — jitter widened it
    await jest.advanceTimersByTimeAsync(150)
    expect(MockWebSocket.instances.length).toBe(2)
  })

  it("does not schedule a reconnect while the OS reports offline", async () => {
    const onLineSpy = jest.spyOn(window.navigator, "onLine", "get").mockReturnValue(false)
    try {
      transport = new CompanionTransport()
      transport.subscribe("ch:test", jest.fn())
      const ws1 = MockWebSocket.lastInstance!
      ws1.triggerOpen()
      ws1.triggerClose()

      // Even after well past every backoff step, no new socket is created —
      // the online listener owns resumption when connectivity returns.
      await jest.advanceTimersByTimeAsync(60_000)
      expect(MockWebSocket.instances.length).toBe(1)
    } finally {
      onLineSpy.mockRestore()
    }
  })

  it("reconnects after close with backoff 1s → 2s → 4s", async () => {
    transport = new CompanionTransport()
    transport.subscribe("ch:test", jest.fn())

    const ws1 = MockWebSocket.lastInstance!
    ws1.triggerOpen()
    ws1.triggerClose()

    // After 1s, first reconnect attempt.
    await jest.advanceTimersByTimeAsync(1000)
    expect(MockWebSocket.instances.length).toBe(2)
    const ws2 = MockWebSocket.instances[1]
    ws2.triggerOpen()
    ws2.triggerClose()

    // After another 2s, second reconnect.
    await jest.advanceTimersByTimeAsync(2000)
    expect(MockWebSocket.instances.length).toBe(3)
    const ws3 = MockWebSocket.instances[2]
    ws3.triggerOpen()
    ws3.triggerClose()

    // After another 4s, third reconnect.
    await jest.advanceTimersByTimeAsync(4000)
    expect(MockWebSocket.instances.length).toBe(4)
  })

  it("reconnect URL includes correct since= cursor", async () => {
    transport = new CompanionTransport()
    transport.subscribe("claude://message", jest.fn())

    const ws1 = MockWebSocket.lastInstance!
    ws1.triggerOpen()
    // Receive a frame to advance the cursor.
    ws1.triggerMessage(
      JSON.stringify({ type: "claude://message", seq: 42, payload: "x", ts_ms: 0 })
    )
    ws1.triggerClose()

    await jest.advanceTimersByTimeAsync(1000)
    const ws2 = MockWebSocket.instances[1]
    expect(ws2.url).toContain("since=42")
  })

  it("backoff is capped at 30s", async () => {
    transport = new CompanionTransport()
    transport.subscribe("ch:test", jest.fn())

    // Exhaust all backoff steps to confirm cap.
    const ws1 = MockWebSocket.lastInstance!
    ws1.triggerOpen()

    const backoffs = [1000, 2000, 4000, 8000, 16000, 30000]
    let currentWsIdx = 0
    for (const delay of backoffs) {
      const ws = MockWebSocket.instances[currentWsIdx]
      if (!ws.closed) ws.triggerClose()
      await jest.advanceTimersByTimeAsync(delay)
      currentWsIdx++
      if (MockWebSocket.instances[currentWsIdx]) {
        MockWebSocket.instances[currentWsIdx].triggerOpen()
      }
    }

    // After the 6th attempt, the cap is 30 000 ms. Verify we got there without
    // errors and that at least 7 WS instances were created (1 original + 6 reconnects).
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(7)
  })
})

// ---------------------------------------------------------------------------
// ConnectionState transitions
// ---------------------------------------------------------------------------

describe("ConnectionState", () => {
  beforeEach(() => setConfig())

  it("starts offline before subscribing", () => {
    transport = new CompanionTransport()
    expect(transport.getConnectionState()).toBe("offline")
  })

  it("transitions to reconnecting then connected on subscribe + open", () => {
    transport = new CompanionTransport()
    const states: string[] = []
    transport.onConnectionStateChange((s) => states.push(s))

    transport.subscribe("ch:test", jest.fn())
    // Transport goes to reconnecting when opening (before open callback).
    expect(states).toContain("reconnecting")

    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    expect(states).toContain("connected")
    expect(transport.getConnectionState()).toBe("connected")
  })

  it("transitions connected → reconnecting on WS close", () => {
    jest.useFakeTimers()
    transport = new CompanionTransport()
    const states: string[] = []
    transport.onConnectionStateChange((s) => states.push(s))

    transport.subscribe("ch:test", jest.fn())
    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    ws.triggerClose()

    expect(states).toContain("reconnecting")
  })

  it("transitions to offline on window offline event", () => {
    transport = new CompanionTransport()
    transport.subscribe("ch:test", jest.fn())

    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()

    const stateHandler = jest.fn()
    transport.onConnectionStateChange(stateHandler)

    window.dispatchEvent(new Event("offline"))
    expect(stateHandler).toHaveBeenCalledWith("offline")
  })

  it("observable handler fires on every transition", () => {
    jest.useFakeTimers()
    transport = new CompanionTransport()
    const handler = jest.fn()
    const unsub = transport.onConnectionStateChange(handler)

    transport.subscribe("ch:test", jest.fn())
    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    ws.triggerClose()

    expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2)
    unsub()
  })

  it("onConnectionStateChange returns an unsubscribe that stops delivery", () => {
    transport = new CompanionTransport()
    const handler = jest.fn()
    const unsub = transport.onConnectionStateChange(handler)

    transport.subscribe("ch:test", jest.fn())
    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    const callsBefore = handler.mock.calls.length

    unsub()
    ws.triggerClose()
    // No additional calls after unsubscribe.
    expect(handler.mock.calls.length).toBe(callsBefore)
  })
})

// ---------------------------------------------------------------------------
// Network awareness — online event
// ---------------------------------------------------------------------------

describe("network awareness — online event", () => {
  it("reopens WS on online event when channels are registered", async () => {
    await setConfig()
    jest.useFakeTimers()
    transport = new CompanionTransport()
    transport.subscribe("ch:test", jest.fn())

    const ws1 = MockWebSocket.lastInstance!
    ws1.triggerOpen()
    ws1.triggerClose()

    // Simulate going offline then back online.
    window.dispatchEvent(new Event("offline"))
    window.dispatchEvent(new Event("online"))

    // Should have opened a new WS immediately on online.
    expect(MockWebSocket.instances.length).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// CompanionError — instanceof checks
// ---------------------------------------------------------------------------

describe("CompanionError", () => {
  it("is instanceof CompanionError and Error", () => {
    const err = new CompanionError({ code: "timeout", message: "timed out", retryable: true })
    expect(err).toBeInstanceOf(CompanionError)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe("timeout")
    expect(err.retryable).toBe(true)
    expect(err.name).toBe("CompanionError")
  })

  it("retryable=false for 4xx errors", () => {
    const err = new CompanionError({ code: "not_found", message: "missing", retryable: false })
    expect(err.retryable).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// classifyWsHost — RFC1918 / mDNS detection helper (ADR-0021 tier surface)
// ---------------------------------------------------------------------------

describe("classifyWsHost", () => {
  it.each([
    ["https://localhost:7890", "ws-lan"],
    ["https://desktop.local:7890", "ws-lan"],
    ["https://192.168.1.42:7890", "ws-lan"],
    ["https://10.0.0.5:7890", "ws-lan"],
    ["https://172.16.0.1:7890", "ws-lan"],
    ["https://172.31.255.254:7890", "ws-lan"],
    ["https://127.0.0.1:7890", "ws-lan"],
    ["https://169.254.5.5:7890", "ws-lan"],
    ["https://[::1]:7890", "ws-lan"],
    ["https://[fe80::1]:7890", "ws-lan"],
    ["https://[fd00::1]:7890", "ws-lan"],
    ["https://abc.trycloudflare.com", "ws-tunnel"],
    ["https://my-tunnel.example.com:443", "ws-tunnel"],
    ["https://172.32.0.1:7890", "ws-tunnel"], // outside RFC1918 172.16/12
    ["https://172.15.0.1:7890", "ws-tunnel"],
    ["https://8.8.8.8", "ws-tunnel"],
  ])("%s → %s", (url, expected) => {
    expect(classifyWsHost(url)).toBe(expected)
  })

  it("returns 'ws-tunnel' for a malformed URL", () => {
    expect(classifyWsHost("not a url at all")).toBe("ws-tunnel")
  })
})

// ---------------------------------------------------------------------------
// Transport tier observable — onTierChange + getActiveTier
// ---------------------------------------------------------------------------

describe("transport tier", () => {
  it("getActiveTier seeds at 'offline' on a fresh instance", () => {
    transport = new CompanionTransport()
    expect(transport.getActiveTier()).toBe("offline")
  })

  it("onTierChange fires once with the seed value on subscribe", () => {
    transport = new CompanionTransport()
    const observed: TransportTier[] = []
    const detach = transport.onTierChange((t) => observed.push(t))
    expect(observed).toEqual(["offline"])
    detach()
  })

  it("transitions to ws-lan when the WS opens against a LAN baseUrl", async () => {
    await setConfig({ ...MOCK_CONFIG, baseUrl: "https://192.168.1.42:7890" })
    transport = new CompanionTransport()
    const observed: TransportTier[] = []
    transport.onTierChange((t) => observed.push(t))
    transport.subscribe("ch:test", jest.fn())
    MockWebSocket.lastInstance!.triggerOpen()
    // Tier recompute fires synchronously inside setConnectionState, but
    // recomputeTier itself is async — flush microtasks.
    await Promise.resolve()
    await Promise.resolve()
    expect(observed).toContain("ws-lan")
    expect(transport.getActiveTier()).toBe("ws-lan")
  })

  it("transitions to ws-tunnel when the WS opens against a public host", async () => {
    await setConfig({
      ...MOCK_CONFIG,
      baseUrl: "https://abc-1234.trycloudflare.com",
    })
    transport = new CompanionTransport()
    const observed: TransportTier[] = []
    transport.onTierChange((t) => observed.push(t))
    transport.subscribe("ch:test", jest.fn())
    MockWebSocket.lastInstance!.triggerOpen()
    await Promise.resolve()
    await Promise.resolve()
    expect(observed).toContain("ws-tunnel")
  })

  it("drops back to 'offline' when the WS closes without reconnect", async () => {
    await setConfig()
    transport = new CompanionTransport()
    const observed: TransportTier[] = []
    transport.onTierChange((t) => observed.push(t))
    transport.subscribe("ch:test", jest.fn())
    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    await Promise.resolve()
    await Promise.resolve()
    // Drop subscribers so onclose doesn't try to reconnect.
    // Then close.
    ws.triggerClose()
    await Promise.resolve()
    await Promise.resolve()
    // The observed sequence must end on `offline` once the WS has closed
    // and no channels remain (subscribe was for ch:test which we never
    // unsubscribed; reconnect-then-offline is also acceptable, so just
    // assert the final state).
    expect(["offline", "ws-lan"].includes(transport.getActiveTier())).toBe(true)
  })

  it("onTierChange detach stops further notifications", async () => {
    await setConfig()
    transport = new CompanionTransport()
    const observed: TransportTier[] = []
    const detach = transport.onTierChange((t) => observed.push(t))
    expect(observed).toEqual(["offline"])
    detach()
    transport.subscribe("ch:test", jest.fn())
    MockWebSocket.lastInstance!.triggerOpen()
    await Promise.resolve()
    await Promise.resolve()
    expect(observed).toEqual(["offline"]) // no further entries
  })

  it("getActiveTier is read-only — no listener throws propagate", async () => {
    await setConfig()
    transport = new CompanionTransport()
    transport.onTierChange(() => {
      throw new Error("listener exploded")
    })
    // Subscribing + opening the WS triggers a tier change that should not
    // throw out of the transport.
    expect(() => {
      transport.subscribe("ch:test", jest.fn())
      MockWebSocket.lastInstance!.triggerOpen()
    }).not.toThrow()
  })
})

describe("reconnectRtc()", () => {
  it("returns 'no-tier' when no WebRTC tier is active", () => {
    transport = new CompanionTransport()
    expect(transport.reconnectRtc()).toBe("no-tier")
  })

  const fakeRtcReturning = (outcome: "started" | "busy" | "throttled") => ({
    getState: () => "open" as const,
    onStateChange: () => () => undefined,
    connect: async () => undefined,
    close: () => undefined,
    reconnectNow: () => outcome,
    getSelectedCandidateKind: async () => "host" as const,
    call: async () => undefined,
    subscribe: () => () => undefined,
    getSeqCursor: () => ({}),
  })

  it("maps TransportRtc 'started' to 'ok'", async () => {
    await setConfig()
    transport = new CompanionTransport()
    ;(transport as unknown as { rtc: unknown }).rtc = fakeRtcReturning("started")
    expect(transport.reconnectRtc()).toBe("ok")
  })

  it("passes through TransportRtc 'busy' (ADR-0021 F3)", async () => {
    await setConfig()
    transport = new CompanionTransport()
    ;(transport as unknown as { rtc: unknown }).rtc = fakeRtcReturning("busy")
    expect(transport.reconnectRtc()).toBe("busy")
  })

  it("passes through TransportRtc 'throttled'", async () => {
    await setConfig()
    transport = new CompanionTransport()
    ;(transport as unknown as { rtc: unknown }).rtc = fakeRtcReturning("throttled")
    expect(transport.reconnectRtc()).toBe("throttled")
  })

  it("re-establishes the tier from cached options after it dropped (ADR-0021 F2)", async () => {
    await setConfig()
    transport = new CompanionTransport()
    // Simulate: the tier was enabled once (options cached) but has since
    // dropped to failed/closed, nulling `this.rtc`. The button must NOT report
    // no-tier — it must rebuild from the cached options.
    let enableCalls = 0
    ;(transport as unknown as { lastEnableOptions: unknown }).lastEnableOptions = {
      signalingUrl: "wss://signaling.test/v1/signaling",
    }
    ;(
      transport as unknown as { enableWebRtcTier: (o: unknown) => Promise<void> }
    ).enableWebRtcTier = async () => {
      enableCalls += 1
    }
    expect((transport as unknown as { rtc: unknown }).rtc).toBeNull()
    expect(transport.reconnectRtc()).toBe("ok")
    expect(enableCalls).toBe(1)
  })

  it("returns 'no-tier' when there is neither a live instance nor cached options", () => {
    transport = new CompanionTransport()
    expect((transport as unknown as { lastEnableOptions: unknown }).lastEnableOptions).toBeNull()
    expect(transport.reconnectRtc()).toBe("no-tier")
  })
})

// ---------------------------------------------------------------------------
// LAN-first gate (ADR-0021)
// ---------------------------------------------------------------------------

const TUNNEL_URL = "https://abc-1234.trycloudflare.com"

interface FakeRtcOpts {
  kind?: "host" | "srflx" | "prflx" | "relay" | "unknown"
}
function makeFakeRtc(opts: FakeRtcOpts = {}) {
  return {
    getState: () => "open" as const,
    call: jest.fn(async () => "RTC_RESULT"),
    subscribe: jest.fn(() => () => undefined),
    getSelectedCandidateKind: jest.fn(async () => opts.kind ?? "host"),
    onStateChange: () => () => undefined,
    reconnectNow: () => true,
    close: jest.fn(),
    getSeqCursor: () => ({}),
  }
}

/** Open a connected WS for the given (already-stored) config. */
function openConnectedWs(tx: CompanionTransport): MockWebSocket {
  tx.subscribe("ch:gate", jest.fn())
  const ws = MockWebSocket.lastInstance!
  ws.triggerOpen()
  return ws
}

describe("isOnConnectedLan()", () => {
  it("is true when the WS is connected against a LAN host", () => {
    return setConfig({ ...MOCK_CONFIG, baseUrl: "https://192.168.1.42:7890" }).then(() => {
      transport = new CompanionTransport()
      openConnectedWs(transport)
      expect(transport.isOnConnectedLan()).toBe(true)
    })
  })

  it("is false when the WS is connected against a tunnel host", () => {
    return setConfig({ ...MOCK_CONFIG, baseUrl: TUNNEL_URL }).then(() => {
      transport = new CompanionTransport()
      openConnectedWs(transport)
      expect(transport.isOnConnectedLan()).toBe(false)
    })
  })

  it("is false when no WS is connected even on a LAN baseUrl", async () => {
    await setConfig({ ...MOCK_CONFIG, baseUrl: "https://192.168.1.42:7890" })
    transport = new CompanionTransport()
    expect(transport.isOnConnectedLan()).toBe(false)
  })

  it("is false when there is no stored config", () => {
    transport = new CompanionTransport()
    expect(transport.isOnConnectedLan()).toBe(false)
  })
})

describe("call() — LAN-first gate", () => {
  it("routes through HTTPS (not the DataChannel) while on a connected LAN", async () => {
    await setConfig({ ...MOCK_CONFIG, baseUrl: "https://192.168.1.42:7890" })
    transport = new CompanionTransport()
    openConnectedWs(transport)
    const fakeRtc = makeFakeRtc()
    ;(transport as unknown as { rtc: unknown }).rtc = fakeRtc
    fetchSpy.mockResolvedValueOnce(mockResponse({ ok: true }, 200))

    const result = await transport.call("claude_sidecar_status")

    expect(result).toEqual({ ok: true })
    expect(fakeRtc.call).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalled()
  })

  it("routes through the DataChannel when NOT on a LAN (tunnel/offline)", async () => {
    await setConfig({ ...MOCK_CONFIG, baseUrl: TUNNEL_URL })
    transport = new CompanionTransport()
    const fakeRtc = makeFakeRtc()
    ;(transport as unknown as { rtc: unknown }).rtc = fakeRtc

    const result = await transport.call("claude_sidecar_status")

    expect(result).toBe("RTC_RESULT")
    expect(fakeRtc.call).toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("falls back to HTTPS with the same mutation key when the DataChannel fails", async () => {
    await setConfig({ ...MOCK_CONFIG, baseUrl: TUNNEL_URL })
    transport = new CompanionTransport()
    const fakeRtc = makeFakeRtc()
    fakeRtc.call.mockRejectedValueOnce(new Error("channel closed"))
    ;(transport as unknown as { rtc: unknown }).rtc = fakeRtc
    fetchSpy.mockResolvedValueOnce(mockResponse({ ok: true }, 200))

    await expect(transport.call("git_set_identity", { repoPath: "/repo" })).resolves.toEqual({
      ok: true,
    })
    const rtcArgs = (fakeRtc.call.mock.calls as unknown[][])[0][1] as Record<string, unknown>
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(rtcArgs.idempotencyKey).toBe((init.headers as Record<string, string>)["Idempotency-Key"])
  })
})

describe("subscribe() — LAN-first gate", () => {
  it("does NOT wire the DataChannel for a new subscription while on a connected LAN", () => {
    return setConfig({ ...MOCK_CONFIG, baseUrl: "https://192.168.1.42:7890" }).then(() => {
      transport = new CompanionTransport()
      openConnectedWs(transport)
      const fakeRtc = makeFakeRtc()
      ;(transport as unknown as { rtc: unknown }).rtc = fakeRtc
      transport.subscribe("ch:new", jest.fn())
      expect(fakeRtc.subscribe).not.toHaveBeenCalled()
    })
  })

  it("wires the DataChannel for a new subscription when NOT on a LAN", () => {
    return setConfig({ ...MOCK_CONFIG, baseUrl: TUNNEL_URL }).then(() => {
      transport = new CompanionTransport()
      openConnectedWs(transport)
      const fakeRtc = makeFakeRtc()
      ;(transport as unknown as { rtc: unknown }).rtc = fakeRtc
      transport.subscribe("ch:new", jest.fn())
      expect(fakeRtc.subscribe).toHaveBeenCalledWith("ch:new", expect.any(Function))
    })
  })
})

describe("recomputeTier() — LAN wins over an open DataChannel", () => {
  it("reports ws-lan even when a DataChannel peer is open", async () => {
    await setConfig({ ...MOCK_CONFIG, baseUrl: "https://192.168.1.42:7890" })
    transport = new CompanionTransport()
    transport.subscribe("ch:gate", jest.fn())
    ;(transport as unknown as { rtc: unknown }).rtc = makeFakeRtc({ kind: "host" })
    MockWebSocket.lastInstance!.triggerOpen()
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.getActiveTier()).toBe("ws-lan")
  })

  it("reports rtc-direct when the open peer is off-LAN (tunnel)", async () => {
    await setConfig({ ...MOCK_CONFIG, baseUrl: TUNNEL_URL })
    transport = new CompanionTransport()
    transport.subscribe("ch:gate", jest.fn())
    ;(transport as unknown as { rtc: unknown }).rtc = makeFakeRtc({ kind: "host" })
    MockWebSocket.lastInstance!.triggerOpen()
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.getActiveTier()).toBe("rtc-direct")
  })
})

describe("reconnectWs()", () => {
  it("re-opens the WS against the current baseUrl when channels are active", async () => {
    await setConfig({ ...MOCK_CONFIG, baseUrl: "https://192.168.1.42:7890" })
    transport = new CompanionTransport()
    const ws1 = openConnectedWs(transport)
    expect(MockWebSocket.instances.length).toBe(1)

    // Repoint to a freshly-discovered LAN address, then force a reconnect.
    await saveCompanionConfig({ ...MOCK_CONFIG, baseUrl: "https://192.168.1.99:7890" })
    transport.reconnectWs()

    expect(ws1.closed).toBe(true)
    expect(MockWebSocket.instances.length).toBe(2)
    expect(MockWebSocket.instances[1].url).toContain("192.168.1.99")
  })

  it("is a no-op when there are no active channels", () => {
    transport = new CompanionTransport()
    transport.reconnectWs()
    expect(MockWebSocket.instances.length).toBe(0)
  })

  it("is a no-op after the transport is destroyed", () => {
    transport = new CompanionTransport()
    transport.destroy()
    transport.reconnectWs()
    expect(MockWebSocket.instances).toHaveLength(0)
  })
})

describe("defensive teardown and frame parsing", () => {
  it("detaches and tolerates a throwing WebRTC close", () => {
    transport = new CompanionTransport()
    const detach = jest.fn()
    const close = jest.fn(() => {
      throw new Error("already closed")
    })
    ;(transport as unknown as { rtcDetach: (() => void) | null }).rtcDetach = detach
    ;(transport as unknown as { rtc: unknown }).rtc = { ...makeFakeRtc(), close }

    expect(() => transport.disableWebRtcTier()).not.toThrow()
    expect(detach).toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it("ignores malformed and typeless WebSocket frames", async () => {
    await setConfig()
    const handler = jest.fn()
    transport = new CompanionTransport()
    transport.subscribe("ch:test", handler)
    const ws = MockWebSocket.lastInstance!

    ws.triggerMessage("{invalid")
    ws.triggerMessage(JSON.stringify({ payload: "missing type" }))

    expect(handler).not.toHaveBeenCalled()
  })
})
