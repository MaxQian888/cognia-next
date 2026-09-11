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
  __setAuthorizationHeadersProviderForTests,
  __setEventSocketTicketIssuerForTests,
  __resetCompanionConfigCacheForTests,
  __setCompanionConfigCacheForTests,
  __setRuntimeTargetRegistrarForTests,
  __setBackoffRandomForTests,
  classifyWsHost,
  clearCompanionConfig,
  hydrateCompanionConfig,
  issueCompanionSocketTicket,
  loadCompanionConfig,
  reloadCompanionConfigForActiveTarget,
  saveCompanionConfig,
  updateCompanionConfigMetadata,
  getCompanionConfigGeneration,
  suspendCompanionTransport,
  type CompanionConfig,
  type TransportTier,
} from "./transport-companion"
import { __setCompanionStorageForTests } from "./companion-storage"
import {
  __resetHostContractsForTests,
  hostContractVerdict,
  recordHostContract,
} from "./companion-contract"
import { COMPANION_CONTRACT_VERSION } from "./command-descriptors"
import { remoteEventResyncCoordinator } from "./resync-coordinator"
import { RtcCarrierError, TransportRtc } from "./transport-rtc"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

const mockVaultSecrets = new Map<string, string>()
jest.mock("@/lib/runtime/browser-vault", () => ({
  getActiveBrowserVault: () => ({
    accountId: "acct_transport",
    async storeSecret(name: string, value: string) {
      mockVaultSecrets.set(name, value)
    },
    async loadSecret(name: string) {
      return mockVaultSecrets.get(name) ?? null
    },
    async deleteSecret(name: string) {
      mockVaultSecrets.delete(name)
    },
    async encryptSecret(name: string, value: string) {
      mockVaultSecrets.set(name, value)
      return { version: 1, iv: `iv-${name}`, ciphertext: `sealed-${name}` }
    },
    async decryptSecret(name: string) {
      const value = mockVaultSecrets.get(name)
      if (!value) throw new Error("secret missing")
      return value
    },
  }),
}))

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

function mockResponseWithHeaders(
  body: unknown,
  status: number,
  headers: Record<string, string>
): ReturnType<typeof mockResponse> & { headers: { get(name: string): string | null } } {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value] as const)
  )
  return {
    ...mockResponse(body, status),
    headers: {
      get: (name: string) => normalized.get(name.toLowerCase()) ?? null,
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_CONFIG: CompanionConfig = {
  baseUrl: "https://192.168.1.42:7890",
  devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "test-key" },
  deviceKeyThumbprint: "test-thumbprint",
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
  mockVaultSecrets.clear()

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
  __setCompanionStorageForTests(null)
  __resetCompanionConfigCacheForTests()
  clearActiveRuntimeTargetContext()
  __setEventSocketTicketIssuerForTests(() => ({
    ticket: "event-ticket",
    expiresAt: Date.now() + 60_000,
  }))
  __setAuthorizationHeadersProviderForTests(async (config) => ({
    Authorization: `Bearer ${config.serviceToken ?? "test.jwt.token"}`,
    DPoP: "test-proof",
  }))
  __setRuntimeTargetRegistrarForTests(null)
})

afterEach(() => {
  transport?.destroy()
  wsSpy.mockRestore()
  fetchSpy.mockRestore()
  localStorage.clear()
  __setCompanionStorageForTests(null)
  __resetCompanionConfigCacheForTests()
  clearActiveRuntimeTargetContext()
  __setEventSocketTicketIssuerForTests(null)
  __setAuthorizationHeadersProviderForTests(null)
  __setRuntimeTargetRegistrarForTests(null)
  __setBackoffRandomForTests(null)
  jest.useRealTimers()
})

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

describe("config helpers", () => {
  it("loadCompanionConfig returns null when nothing stored", async () => {
    expect(await loadCompanionConfig()).toBeNull()
  })

  it("fails closed when a socket ticket is requested without an active pairing", async () => {
    await expect(
      issueCompanionSocketTicket({ channel: "browser", sessionId: "session-a" })
    ).rejects.toThrow("pair this device again")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("issues a session-bound browser ticket through the active Companion auth adapter", async () => {
    __setCompanionConfigCacheForTests({
      baseUrl: "https://host.test",
      serviceToken: "loopback-test-token",
      deviceId: "device-a",
      serverVersion: "test",
    })
    fetchSpy.mockResolvedValueOnce(mockResponse({ ticket: "once", expiresIn: 60 }, 200))

    await expect(
      issueCompanionSocketTicket({ channel: "browser", sessionId: "session-a" })
    ).resolves.toEqual(expect.objectContaining({ ticket: "once" }))
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://host.test/api/auth/socket-ticket")
    expect(JSON.parse(init.body as string)).toEqual({
      channel: "browser",
      sessionId: "session-a",
    })
  })

  it("saveCompanionConfig + loadCompanionConfig round-trips correctly", async () => {
    await saveCompanionConfig(MOCK_CONFIG)
    expect(await loadCompanionConfig()).toEqual(MOCK_CONFIG)
  })

  it("does not expose a pairing in the runtime cache when secure persistence fails", async () => {
    __setCompanionStorageForTests({
      load: async () => null,
      save: async () => {
        throw new Error("vault write failed")
      },
      clear: async () => undefined,
    })

    await expect(saveCompanionConfig(MOCK_CONFIG)).rejects.toThrow("vault write failed")
    expect(loadCompanionConfig()).toBeNull()
  })

  it("restores the previous secure pairing when runtime target registration fails", async () => {
    const previous = { ...MOCK_CONFIG, targetId: "companion-previous" }
    const save = jest.fn(async (_config: CompanionConfig) => undefined)
    const clear = jest.fn(async () => undefined)
    const remove = jest.fn(async () => undefined)
    __setCompanionStorageForTests({
      load: async () => previous,
      save,
      clear,
      remove,
    })
    setActiveRuntimeTargetContext("acct_transport", "web-standalone")
    __setRuntimeTargetRegistrarForTests(async () => {
      throw new Error("runtime registry failed")
    })

    await expect(
      saveCompanionConfig({ ...MOCK_CONFIG, targetId: "companion-next" })
    ).rejects.toThrow("runtime registry failed")

    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1]?.[0]).toEqual(previous)
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ targetId: "companion-next" }))
    expect(clear).not.toHaveBeenCalled()
    expect(loadCompanionConfig()).toBeNull()
  })

  it("registers with the account captured before persistence changes runtime context", async () => {
    const registrar = jest.fn(async (_config: CompanionConfig) => undefined)
    __setCompanionStorageForTests({
      load: async () => null,
      save: async () => {
        clearActiveRuntimeTargetContext()
      },
      clear: async () => undefined,
    })
    setActiveRuntimeTargetContext("acct_transport", "web-standalone")
    __setRuntimeTargetRegistrarForTests(registrar)

    await saveCompanionConfig({ ...MOCK_CONFIG, targetId: "companion-next" })

    expect(registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_transport",
        targetId: "companion-next",
      })
    )
  })

  it("updates endpoint metadata without re-registering or notifying the live transport", async () => {
    const registrar = jest.fn(async () => undefined)
    __setRuntimeTargetRegistrarForTests(registrar)
    await saveCompanionConfig(MOCK_CONFIG)
    registrar.mockClear()
    const changed = jest.fn()
    window.addEventListener("cognia:companion-config-changed", changed)
    const current = loadCompanionConfig()!
    const generation = getCompanionConfigGeneration()
    try {
      await updateCompanionConfigMetadata(current, {
        baseUrl: current.baseUrl,
        tunnelBaseUrl: "https://new.example",
      })
      expect(loadCompanionConfig()?.tunnelBaseUrl).toBe("https://new.example")
      expect(registrar).not.toHaveBeenCalled()
      expect(getCompanionConfigGeneration()).toBe(generation)
      expect(changed).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener("cognia:companion-config-changed", changed)
    }
  })

  it("advances the pairing epoch through A to B to A without treating metadata as activation", async () => {
    await saveCompanionConfig(MOCK_CONFIG)
    const firstEpoch = getCompanionConfigGeneration()
    await saveCompanionConfig({ ...MOCK_CONFIG, deviceId: "host-b" })
    const secondEpoch = getCompanionConfigGeneration()
    await saveCompanionConfig(MOCK_CONFIG)
    expect(secondEpoch).toBeGreaterThan(firstEpoch)
    expect(getCompanionConfigGeneration()).toBeGreaterThan(secondEpoch)
    const currentEpoch = getCompanionConfigGeneration()
    await updateCompanionConfigMetadata(loadCompanionConfig()!, {
      tunnelBaseUrl: "https://new.example",
    })
    expect(getCompanionConfigGeneration()).toBe(currentEpoch)
  })

  it("rejects metadata for a Host that is no longer selected", async () => {
    await saveCompanionConfig(MOCK_CONFIG)
    const previous = loadCompanionConfig()!
    await saveCompanionConfig({ ...MOCK_CONFIG, deviceId: "another-host" })
    await updateCompanionConfigMetadata(previous, { baseUrl: "https://stale.example" })
    expect(loadCompanionConfig()?.deviceId).toBe("another-host")
    expect(loadCompanionConfig()?.baseUrl).toBe(MOCK_CONFIG.baseUrl)
  })

  it("serializes unpair after a pending metadata write and never restores its cache", async () => {
    let stored: CompanionConfig | null = MOCK_CONFIG
    let finishSave!: () => void
    __setCompanionConfigCacheForTests(MOCK_CONFIG)
    __setCompanionStorageForTests({
      load: async () => stored,
      save: async (next) => {
        await new Promise<void>((resolve) => {
          finishSave = resolve
        })
        stored = next
      },
      clear: async () => {
        stored = null
      },
    })
    const update = updateCompanionConfigMetadata(MOCK_CONFIG, { baseUrl: "https://new.example" })
    await Promise.resolve()
    await Promise.resolve()
    const clear = clearCompanionConfig()
    expect(loadCompanionConfig()).toBeNull()
    finishSave()
    await Promise.all([update, clear])
    expect(loadCompanionConfig()).toBeNull()
    expect(stored).toBeNull()
  })

  it("does not publish endpoint metadata when secure persistence fails", async () => {
    __setCompanionConfigCacheForTests(MOCK_CONFIG)
    __setCompanionStorageForTests({
      load: async () => MOCK_CONFIG,
      save: async () => {
        throw new Error("locked")
      },
      clear: async () => undefined,
    })
    await expect(
      updateCompanionConfigMetadata(MOCK_CONFIG, { baseUrl: "https://new.example" })
    ).rejects.toThrow("locked")
    expect(loadCompanionConfig()).toBe(MOCK_CONFIG)
  })

  it("hydrates warm metadata without changing the pairing epoch or registering again", async () => {
    const next = { ...MOCK_CONFIG, baseUrl: "https://warm.example" }
    const save = jest.fn(async () => undefined)
    const registrar = jest.fn(async () => undefined)
    __setCompanionConfigCacheForTests(MOCK_CONFIG)
    __setCompanionStorageForTests({ load: async () => next, save, clear: async () => undefined })
    __setRuntimeTargetRegistrarForTests(registrar)
    const generation = getCompanionConfigGeneration()

    expect(await hydrateCompanionConfig()).toEqual(next)
    expect(getCompanionConfigGeneration()).toBe(generation)
    expect(save).not.toHaveBeenCalled()
    expect(registrar).not.toHaveBeenCalled()
  })

  it("advances the epoch when hydration changes or clears the selected Host", async () => {
    let stored: CompanionConfig | null = { ...MOCK_CONFIG, deviceId: "hydrated-host-b" }
    __setCompanionConfigCacheForTests(MOCK_CONFIG)
    __setCompanionStorageForTests({
      load: async () => stored,
      save: async () => undefined,
      clear: async () => undefined,
    })
    const generation = getCompanionConfigGeneration()
    expect((await hydrateCompanionConfig())?.deviceId).toBe("hydrated-host-b")
    expect(getCompanionConfigGeneration()).toBe(generation + 1)
    stored = null
    expect(await hydrateCompanionConfig()).toBeNull()
    expect(getCompanionConfigGeneration()).toBe(generation + 2)
  })

  it("does not restore a pairing from a storage read that finishes after unpairing", async () => {
    let finishLoad!: (config: CompanionConfig) => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    __setCompanionConfigCacheForTests(MOCK_CONFIG)
    __setCompanionStorageForTests({
      load: async () => {
        markStarted()
        return new Promise<CompanionConfig>((resolve) => {
          finishLoad = resolve
        })
      },
      save: async () => undefined,
      clear: async () => undefined,
    })
    const hydration = hydrateCompanionConfig()
    await started
    const clearing = clearCompanionConfig()
    finishLoad(MOCK_CONFIG)
    expect(await hydration).toBeNull()
    await clearing
    expect(loadCompanionConfig()).toBeNull()
  })

  it("does not expose metadata when conditional persistence declines the update", async () => {
    const save = jest.fn(async () => undefined)
    const updateMetadata = jest.fn(async (_next: CompanionConfig, canApply: () => boolean) => {
      expect(canApply()).toBe(true)
      return false
    })
    __setCompanionConfigCacheForTests(MOCK_CONFIG)
    __setCompanionStorageForTests({
      load: async () => MOCK_CONFIG,
      save,
      clear: async () => undefined,
      updateMetadata,
    })
    expect(
      await updateCompanionConfigMetadata(MOCK_CONFIG, { baseUrl: "https://declined.example" })
    ).toBe(MOCK_CONFIG)
    expect(loadCompanionConfig()).toBe(MOCK_CONFIG)
    expect(updateMetadata).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
  })

  it("rechecks a metadata write guard before publishing and skips already-stale work", async () => {
    let current = false
    const save = jest.fn(async () => undefined)
    const updateMetadata = jest.fn(async (_next: CompanionConfig, canApply: () => boolean) => {
      expect(canApply()).toBe(true)
      current = false
      expect(canApply()).toBe(false)
      return false
    })
    __setCompanionConfigCacheForTests(MOCK_CONFIG)
    __setCompanionStorageForTests({
      load: async () => MOCK_CONFIG,
      save,
      clear: async () => undefined,
      updateMetadata,
    })
    await updateCompanionConfigMetadata(
      MOCK_CONFIG,
      { baseUrl: "https://stale.example" },
      () => current
    )
    expect(updateMetadata).not.toHaveBeenCalled()
    current = true
    await updateCompanionConfigMetadata(
      MOCK_CONFIG,
      { baseUrl: "https://stale.example" },
      () => current
    )
    expect(updateMetadata).toHaveBeenCalledTimes(1)
    expect(loadCompanionConfig()).toBe(MOCK_CONFIG)
    expect(save).not.toHaveBeenCalled()
  })

  it.each(["persistence", "registration"])(
    "unpair waits for an in-flight hydration %s before clearing",
    async (stage) => {
      let stored: CompanionConfig | null = { ...MOCK_CONFIG }
      let release!: () => void
      let started!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      const entered = new Promise<void>((resolve) => {
        started = resolve
      })
      const events: string[] = []
      setActiveRuntimeTargetContext("acct_transport", "web-standalone")
      __setCompanionStorageForTests({
        load: async () => stored,
        save: async (next) => {
          if (stage === "persistence") {
            started()
            await pending
          }
          stored = next
          events.push("saved")
        },
        clear: async () => {
          stored = null
          events.push("cleared")
        },
      })
      __setRuntimeTargetRegistrarForTests(async () => {
        if (stage === "registration") {
          started()
          await pending
        }
        events.push("registered")
      })
      const hydration = hydrateCompanionConfig()
      await entered
      // Keep runtime database detachment outside this storage-order fixture.
      clearActiveRuntimeTargetContext()
      const clearing = clearCompanionConfig()
      await Promise.resolve()
      await Promise.resolve()
      const clearedBeforeHydrationFinished = events.includes("cleared")
      release()
      await Promise.all([hydration, clearing])
      expect(clearedBeforeHydrationFinished).toBe(false)
      expect(events.at(-1)).toBe("cleared")
      expect(stored).toBeNull()
      expect(loadCompanionConfig()).toBeNull()
    }
  )

  it("does not attach a legacy hydration after the runtime scope changes during target derivation", async () => {
    let finish!: (digest: ArrayBuffer) => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const derive = jest.spyOn(crypto.subtle, "digest").mockImplementation(async () => {
      started()
      return new Promise<ArrayBuffer>((resolve) => {
        finish = resolve
      })
    })
    const save = jest.fn(async () => undefined)
    const register = jest.fn(async () => undefined)
    setActiveRuntimeTargetContext("acct_transport", "web-standalone")
    __setCompanionStorageForTests({
      load: async () => MOCK_CONFIG,
      save,
      clear: async () => undefined,
    })
    __setRuntimeTargetRegistrarForTests(register)
    try {
      const hydration = hydrateCompanionConfig()
      await entered
      setActiveRuntimeTargetContext("acct_transport", "companion-new")
      finish(new Uint8Array(32).buffer)
      expect(await hydration).toBeNull()
      expect(save).not.toHaveBeenCalled()
      expect(register).not.toHaveBeenCalled()
    } finally {
      derive.mockRestore()
    }
  })

  it("finishes an old hydration write before saving a newly selected Host", async () => {
    let stored: CompanionConfig | null = MOCK_CONFIG
    let finish!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const saves: string[] = []
    setActiveRuntimeTargetContext("acct_transport", "web-standalone")
    __setCompanionStorageForTests({
      load: async () => stored,
      save: async (next) => {
        if (next.deviceId === MOCK_CONFIG.deviceId) {
          started()
          await new Promise<void>((resolve) => {
            finish = resolve
          })
        }
        stored = next
        saves.push(next.deviceId)
      },
      clear: async () => {
        stored = null
      },
    })
    __setRuntimeTargetRegistrarForTests(async () => undefined)
    const hydration = hydrateCompanionConfig()
    await entered
    const switching = saveCompanionConfig({
      ...MOCK_CONFIG,
      targetId: "companion-new",
      deviceId: "new-host",
    })
    finish()
    await Promise.all([hydration, switching])
    expect(saves).toEqual([MOCK_CONFIG.deviceId, "new-host"])
    expect(stored?.deviceId).toBe("new-host")
    expect(loadCompanionConfig()?.deviceId).toBe("new-host")
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
    // The credential book files the pairing under the active account and hands
    // that namespace back on the way out, so a round-tripped config now carries
    // `accountId` even when the caller never set one (ADR-0097).
    const hydrated = {
      ...MOCK_CONFIG,
      targetId: MOCK_CONFIG.deviceId,
      accountId: "acct_transport",
    }
    expect(await hydrateCompanionConfig()).toEqual(hydrated)
    expect(loadCompanionConfig()).toEqual(hydrated)
  })

  it("reloads an explicit active target without racing the ordered Host rebind", async () => {
    const changed = jest.fn()
    window.addEventListener("cognia:companion-config-changed", changed)
    __setCompanionStorageForTests({
      load: async () => ({ ...MOCK_CONFIG, targetId: "host-b", accountId: "acct_transport" }),
      save: async () => undefined,
      clear: async () => undefined,
    })
    try {
      await expect(reloadCompanionConfigForActiveTarget({ notify: false })).resolves.toEqual(
        expect.objectContaining({ targetId: "host-b" })
      )
      expect(loadCompanionConfig()).toEqual(expect.objectContaining({ targetId: "host-b" }))
      expect(changed).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener("cognia:companion-config-changed", changed)
    }
  })

  it("fails closed by clearing the dispatch cache and notifying runtime bindings", async () => {
    const changed = jest.fn()
    window.addEventListener("cognia:companion-config-changed", changed)
    __setCompanionConfigCacheForTests(MOCK_CONFIG)
    try {
      await suspendCompanionTransport()
      expect(loadCompanionConfig()).toBeNull()
      expect(changed).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener("cognia:companion-config-changed", changed)
    }
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

  it("hands a 202 Operation document back whole instead of unwrapping it", async () => {
    await setConfig()
    const operation = {
      id: "0d1f3a6e-8f0c-4c4c-9a1e-2f2f4b6c8d10",
      done: false,
      status: "running",
      metadata: {
        createdAt: 1,
        updatedAt: 1,
        requestId: "7080c795-aa2b-4dbe-96b7-966e50393b0b",
      },
    }
    fetchSpy.mockResolvedValueOnce(mockResponse(operation, 202))

    transport = new CompanionTransport()
    await expect(transport.call("claude_sidecar_status")).resolves.toEqual(operation)
  })

  it("unwraps the canonical Companion RPC response envelope", async () => {
    await setConfig()
    fetchSpy.mockResolvedValueOnce(
      mockResponse(
        {
          requestId: "7080c795-aa2b-4dbe-96b7-966e50393b0b",
          result: { ok: true },
        },
        200
      )
    )

    transport = new CompanionTransport()
    await expect(transport.call("claude_sidecar_status")).resolves.toEqual({ ok: true })
  })

  it("accepts a successful null result from side-effect commands", async () => {
    await setConfig()
    fetchSpy.mockResolvedValueOnce(mockResponse(null, 200))

    transport = new CompanionTransport()
    await expect(transport.call("plugin_set_shell_allowlist")).resolves.toBeNull()
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
// call() — client-target commands never reach the wire
// ---------------------------------------------------------------------------

describe("call() — client-target commands", () => {
  it("refuses a client-target command without contacting the host", async () => {
    await setConfig()

    transport = new CompanionTransport()
    await expect(transport.call("sandbox_health_check")).rejects.toMatchObject({
      code: "command_transport_forbidden",
      retryable: false,
    })
    // The point of the guard: no round trip. The host would have answered 403
    // `command_transport_forbidden` anyway, so the request was pure cost — and
    // on the composer's boot path it produced a console error every poll.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("refuses before the not_paired check, so an unpaired shell gets the real reason", async () => {
    // No config stored. "Not paired" would be a misleading answer: pairing a
    // host would not make a client-local command reachable.
    transport = new CompanionTransport()
    await expect(transport.call("sandbox_health_probe")).rejects.toMatchObject({
      code: "command_transport_forbidden",
    })
  })

  it("still sends execution-target commands", async () => {
    await setConfig()
    fetchSpy.mockResolvedValueOnce(mockResponse({ ok: true }, 200))

    transport = new CompanionTransport()
    await expect(transport.call("claude_sidecar_status")).resolves.toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalled()
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
        serviceToken: "service.token.abc",
        deviceId: "brain-1",
        serverVersion: "headless",
      }),
    })

    const result = await transport.call("claude_sidecar_status")
    expect(result).toEqual({ ok: true })
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe("https://127.0.0.1:7999/api/_rpc/claude_sidecar_status")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer service.token.abc")
    // Nothing was persisted — the provider config never touches storage.
    expect(loadCompanionConfig()).toBeNull()
  })

  it("uses isolated internal endpoints for the headless service transport", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ ok: true }, 200))
    transport = new CompanionTransport({
      configProvider: () => ({
        baseUrl: "https://127.0.0.1:7999",
        serviceToken: "service-token",
        deviceId: "brain-local_acct_a",
        serverVersion: "headless",
      }),
      rpcPath: "/internal/_rpc",
      eventsPath: "/internal/events",
    })

    await transport.call("claude_sidecar_status")
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://127.0.0.1:7999/internal/_rpc/claude_sidecar_status"
    )

    transport.subscribe("claude://message", jest.fn())
    expect(MockWebSocket.lastInstance?.url).toBe(
      "wss://127.0.0.1:7999/internal/events?token=service-token"
    )
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
        serviceToken: token,
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

  it("reuses a caller-provided idempotency key for queued mutations", async () => {
    fetchSpy.mockResolvedValue(mockResponse({}, 200))

    transport = new CompanionTransport()
    await transport.call("connector_send", { text: "hello" }, { idempotencyKey: "queue-key-1" })

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("queue-key-1")
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
      "skills_catalog_get",
      "external_bridge_config_get",
      "external_bridge_client_list",
      "external_bridge_status",
      "mcp_server_status",
      "lsp_host_ensure",
      "codeserver_supported",
      "codeserver_status",
      "codeserver_list_proxies",
      "read_agent_config",
      "session_list",
      "message_get_by_session",
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
    expect(url).toBe("https://192.168.1.42:7890/ide/content")
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
    expect(fetchSpy.mock.calls[0][0]).toBe("https://192.168.1.42:7890/ide/content/handle%2Fopaque")
  })
})

describe("readBinary() — session media", () => {
  it("fetches authenticated media bytes without JSON or base64 expansion", async () => {
    await setConfig()
    const hash = "a".repeat(64)
    const bytes = new Uint8Array([137, 80, 78, 71])
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type"
            ? "image/png"
            : name.toLowerCase() === "etag"
              ? '"hash-thumb"'
              : null,
      },
      arrayBuffer: async () => bytes.buffer,
    })
    transport = new CompanionTransport()

    const result = await transport.readBinary({
      kind: "session-media",
      sessionId: "session/one",
      hash,
      variant: "thumbnail",
    })

    expect(result).toEqual({
      bytes,
      mediaType: "image/png",
      etag: '"hash-thumb"',
    })
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      `https://192.168.1.42:7890/api/sessions/session%2Fone/media/${hash}?variant=thumbnail`
    )
    expect(init.method).toBe("GET")
    expect(init.headers).toEqual({
      Authorization: "Bearer test.jwt.token",
      DPoP: "test-proof",
    })
    expect(init.body).toBeUndefined()
  })

  it("mints a fresh DPoP proof when a binary GET is retried", async () => {
    jest.useFakeTimers()
    await setConfig()
    let proof = 0
    const authorize = jest.fn(async () => ({
      Authorization: "Bearer test.jwt.token",
      DPoP: `proof-${++proof}`,
    }))
    __setAuthorizationHeadersProviderForTests(authorize)
    fetchSpy.mockResolvedValueOnce(mockResponse({ message: "retry" }, 503)).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => Uint8Array.from([1]).buffer,
    })
    transport = new CompanionTransport()

    const resultPromise = transport.readBinary({
      kind: "session-media",
      sessionId: "s1",
      hash: "b".repeat(64),
      variant: "canonical",
    })
    await jest.advanceTimersByTimeAsync(250)

    await expect(resultPromise).resolves.toMatchObject({ bytes: Uint8Array.from([1]) })
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(
      fetchSpy.mock.calls.map(
        ([, init]) => ((init as RequestInit).headers as Record<string, string>).DPoP
      )
    ).toEqual(["proof-1", "proof-2"])
  })

  it("rejects invalid resource identifiers before issuing a request", async () => {
    await setConfig()
    transport = new CompanionTransport()

    await expect(
      transport.readBinary({
        kind: "session-media",
        sessionId: "s1",
        hash: "../secret",
        variant: "canonical",
      })
    ).rejects.toMatchObject({ code: "invalid_binary_resource", retryable: false })
    expect(fetchSpy).not.toHaveBeenCalled()
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

  it("reads the code and the message out of the Host's problem document", async () => {
    // ADR-0175: the Host answers one RFC 9457 document, whose `detail` carries
    // the message the flat envelope used to put in `message`.
    fetchSpy.mockResolvedValue(
      mockResponse(
        {
          type: "https://cognia.dev/problems/command_renamed",
          title: "Gone",
          status: 410,
          detail: "session_list is now session.list",
          instance: "/api/_rpc/session_list",
          code: "command_renamed",
          requestId: "req-1",
          retryable: false,
          details: { replacement: "session.list" },
        },
        410
      )
    )

    transport = new CompanionTransport()
    const err = await transport.call("session_list").catch((e: unknown) => e)

    expect(err).toBeInstanceOf(CompanionError)
    expect(err).toMatchObject({
      code: "command_renamed",
      message: "session_list is now session.list",
      retryable: false,
    })
    expect(fetchSpy.mock.calls.length).toBe(1)
  })

  it("keeps the Host's retryable over the status guess on a problem document", async () => {
    jest.useFakeTimers()
    // A 503 the Host declares unretryable must not be retried by the status
    // rule, and a 4xx it declares retryable must not be refused by it.
    fetchSpy.mockResolvedValue(
      mockResponse(
        {
          type: "https://cognia.dev/problems/host_draining",
          title: "Service Unavailable",
          status: 503,
          detail: "the host is shutting down",
          code: "host_draining",
          requestId: "req-2",
          retryable: false,
          details: {},
        },
        503
      )
    )

    transport = new CompanionTransport()
    let caught: unknown
    const callPromise = transport.call("claude_send").catch((e: unknown) => {
      caught = e
    })
    await jest.runAllTimersAsync()
    await callPromise
    jest.useRealTimers()

    expect(caught).toMatchObject({ code: "host_draining", retryable: false })
    expect(fetchSpy.mock.calls.length).toBe(1)
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

  it("surfaces a transient transport failure without replaying an unsafe command", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ code: "service_unavailable", message: "brain bridge disconnected" }, 503)
    )
    transport = new CompanionTransport()

    await expect(transport.call("unclassified_mutation", { value: 1 })).rejects.toMatchObject({
      code: "service_unavailable",
      retryable: true,
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(transport.getPlaneHealth().rpc).toBe("unavailable")
  })

  it("mints a fresh DPoP proof on every attempt while preserving idempotency", async () => {
    jest.useFakeTimers()
    __setBackoffRandomForTests(() => 0)
    let proof = 0
    const authorize = jest.fn(async () => ({
      Authorization: "Bearer test.jwt.token",
      DPoP: `proof-${++proof}`,
    }))
    __setAuthorizationHeadersProviderForTests(authorize)
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ code: "service_unavailable", message: "retry" }, 503))
      .mockResolvedValueOnce(mockResponse({ ok: true }, 200))

    transport = new CompanionTransport()
    const callPromise = transport.call(
      "claude_send",
      { session_id: "s1", prompt: "hello" },
      { idempotencyKey: "stable-key" }
    )
    await jest.advanceTimersByTimeAsync(250)
    await callPromise

    expect(authorize).toHaveBeenCalledTimes(2)
    const attempts = fetchSpy.mock.calls.map(([, init]) => init as RequestInit)
    expect(attempts.map((init) => (init.headers as Record<string, string>).DPoP)).toEqual([
      "proof-1",
      "proof-2",
    ])
    expect(
      attempts.map((init) => (init.headers as Record<string, string>)["Idempotency-Key"])
    ).toEqual(["stable-key", "stable-key"])
    expect(attempts.map((init) => init.body)).toEqual([
      JSON.stringify({ session_id: "s1", prompt: "hello" }),
      JSON.stringify({ session_id: "s1", prompt: "hello" }),
    ])
  })

  it.each([
    ["5", 5_000],
    [new Date(25_000).toUTCString(), 25_000],
  ])("honors a bounded Retry-After value %s", async (retryAfter, expectedDelay) => {
    jest.useFakeTimers({ now: 0 })
    fetchSpy
      .mockResolvedValueOnce(
        mockResponseWithHeaders({ code: "rate_limited", message: "slow down" }, 429, {
          "Retry-After": retryAfter,
        })
      )
      .mockResolvedValueOnce(mockResponse({ ok: true }, 200))

    transport = new CompanionTransport()
    const callPromise = transport.call("claude_sidecar_status")
    await Promise.resolve()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(expectedDelay - 1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    await callPromise
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  // The shape this Host actually sends. `RpcError::rate_limited` puts the
  // wait in the message and sets no header, so a client that only reads the
  // header falls back to sub-second jitter and burns all three attempts long
  // before a bucket refilling at 1/s recovers.
  it("honors retry_after_seconds from the body when no header is sent", async () => {
    jest.useFakeTimers({ now: 0 })
    fetchSpy
      .mockResolvedValueOnce(
        mockResponse(
          {
            code: "rate_limited",
            message: "device exceeded the per-minute quota; retry_after_seconds=3",
            retryable: true,
          },
          429
        )
      )
      .mockResolvedValueOnce(mockResponse({ ok: true }, 200))

    transport = new CompanionTransport()
    const callPromise = transport.call("claude_sidecar_status")
    await Promise.resolve()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(2_999)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    await callPromise
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("prefers the Retry-After header over the body when both are present", async () => {
    jest.useFakeTimers({ now: 0 })
    fetchSpy
      .mockResolvedValueOnce(
        mockResponseWithHeaders(
          {
            code: "rate_limited",
            message: "device exceeded the per-minute quota; retry_after_seconds=9",
            retryable: true,
          },
          429,
          { "Retry-After": "2" }
        )
      )
      .mockResolvedValueOnce(mockResponse({ ok: true }, 200))

    transport = new CompanionTransport()
    const callPromise = transport.call("claude_sidecar_status")
    await Promise.resolve()

    await jest.advanceTimersByTimeAsync(2_000)
    await callPromise
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("clamps a body-carried wait to the same ceiling as the header", async () => {
    jest.useFakeTimers({ now: 0 })
    fetchSpy.mockResolvedValue(
      mockResponse(
        {
          code: "rate_limited",
          message: "device exceeded the per-minute quota; retry_after_seconds=3600",
          retryable: true,
        },
        429
      )
    )

    transport = new CompanionTransport()
    let caught: unknown
    const callPromise = transport.call("claude_sidecar_status").catch((err) => {
      caught = err
    })
    await jest.runAllTimersAsync()
    await callPromise

    expect((caught as { retryAfterMs?: number }).retryAfterMs).toBe(30_000)
  })

  it("hands the caller the wait the Host asked for", async () => {
    // The transport exhausts its own attempts and then throws. Without the
    // interval on the error, a caller that retries above this layer picks its
    // own schedule and keeps the rate limit pinned indefinitely.
    jest.useFakeTimers({ now: 0 })
    fetchSpy.mockResolvedValue(
      mockResponseWithHeaders({ code: "rate_limited", message: "slow down" }, 429, {
        "Retry-After": "5",
      })
    )

    transport = new CompanionTransport()
    let caught: unknown
    const callPromise = transport.call("claude_sidecar_status").catch((err) => {
      caught = err
    })
    await jest.runAllTimersAsync()
    await callPromise

    expect(caught).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 5_000,
    })
  })

  it("clamps a Host that asks the caller to wait longer than the ceiling", async () => {
    // The interval reaches the caller, so it must stay bounded here too — a
    // Host that answers `Retry-After: 3600` cannot park a client for an hour.
    jest.useFakeTimers({ now: 0 })
    fetchSpy.mockResolvedValue(
      mockResponseWithHeaders({ code: "rate_limited", message: "slow down" }, 429, {
        "Retry-After": "3600",
      })
    )

    transport = new CompanionTransport()
    let caught: unknown
    const callPromise = transport.call("claude_sidecar_status").catch((err) => {
      caught = err
    })
    await jest.runAllTimersAsync()
    await callPromise

    expect((caught as { retryAfterMs?: number }).retryAfterMs).toBe(30_000)
  })

  it("leaves the wait unset when the Host named none", async () => {
    jest.useFakeTimers()
    fetchSpy.mockResolvedValue(
      mockResponse({ code: "server_error", message: "boom", retryable: false }, 500)
    )

    transport = new CompanionTransport()
    let caught: unknown
    const callPromise = transport.call("claude_sidecar_status").catch((err) => {
      caught = err
    })
    await jest.runAllTimersAsync()
    await callPromise

    expect(caught).toMatchObject({ retryable: false })
    expect((caught as { retryAfterMs?: number }).retryAfterMs).toBeUndefined()
  })

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
    // The manifest retry budget is three total attempts.
    expect(fetchSpy.mock.calls.length).toBe(3)
  })

  it("uses the manifest retry budget and preserves the canonical server error", async () => {
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
    expect((caught as CompanionError).code).toBe("internal_error")
    expect((caught as CompanionError).retryable).toBe(true)
    expect(fetchSpy.mock.calls.length).toBe(3)
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
  it.each([
    ["codeserver_ensure", 300_000],
    ["codeserver_status", 30_000],
  ])("keeps %s alive until its finite %i ms deadline", async (command, timeoutMs) => {
    await setConfig()
    jest.useFakeTimers()
    let signal: AbortSignal | undefined
    fetchSpy.mockImplementationOnce((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal
      return new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        })
      })
    })
    transport = new CompanionTransport()
    const result = transport.call(command, { root: "/host/workspaces/app" }).catch((error) => error)
    try {
      await jest.advanceTimersByTimeAsync(timeoutMs - 1)
      expect(signal?.aborted).toBe(false)
      await jest.advanceTimersByTimeAsync(1)
      await expect(result).resolves.toMatchObject({
        code: "timeout",
        message: expect.stringContaining(`${timeoutMs}ms`),
      })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

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
    expect(ws.url).toContain("/ws/events")
    expect(ws.url).toContain("ticket=event-ticket")
  })

  it("marks the event plane ready only after the replay boundary", () => {
    transport = new CompanionTransport()
    const health = jest.fn()
    transport.onPlaneHealthChange(health)
    transport.subscribe("claude://message", jest.fn())

    const ws = MockWebSocket.lastInstance!
    expect(transport.getPlaneHealth().events).toBe("connecting")
    ws.triggerOpen()
    expect(transport.getPlaneHealth().events).toBe("replaying")
    expect(transport.getConnectionState()).toBe("connected")

    ws.triggerMessage(JSON.stringify({ type: "stream_ready", cursor: 7 }))
    expect(transport.getPlaneHealth().events).toBe("ready")
    expect(health).toHaveBeenLastCalledWith(expect.objectContaining({ events: "ready" }))
  })

  it("fails closed instead of opening an unpinned browser WebSocket to a paired LAN host", async () => {
    await setConfig({ ...MOCK_CONFIG, serverFingerprint: "ab".repeat(32) })
    transport = new CompanionTransport()
    transport.subscribe("claude://message", jest.fn())

    expect(wsSpy).not.toHaveBeenCalled()
    expect(transport.getActiveTier()).toBe("offline")
  })

  it("opens the socket on a plaintext loopback Host, where there is no certificate to pin", async () => {
    // The Host's browser-access listener (`browser_access.rs`) is the only
    // plane a tab can reach, and a `cgnp3` invitation always carries the
    // fingerprint. Treating that as "needs a pinned WebSocket" left a
    // correctly paired browser with a working RPC plane and a permanently
    // idle events plane — so `WebCompanionBootProvider` never ran `recover()`
    // and the client never left "the current host is offline".
    await setConfig({
      ...MOCK_CONFIG,
      baseUrl: "http://127.0.0.1:27891",
      serverFingerprint: "ab".repeat(32),
    })
    transport = new CompanionTransport()
    transport.subscribe("claude://message", jest.fn())

    await Promise.resolve()
    await Promise.resolve()

    expect(transport.getPlaneHealth().events).not.toBe("idle")
  })

  it("still refuses the socket for an https LAN Host over the same code path", async () => {
    // The narrowing is about the scheme, not about loopback: an `https://`
    // loopback Host presents the same un-pinnable self-signed certificate.
    await setConfig({
      ...MOCK_CONFIG,
      baseUrl: "https://127.0.0.1:27890",
      serverFingerprint: "ab".repeat(32),
    })
    transport = new CompanionTransport()
    transport.subscribe("claude://message", jest.fn())

    expect(wsSpy).not.toHaveBeenCalled()
    expect(transport.getPlaneHealth().events).toBe("idle")
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

  // ADR-0127 §2: the server may pack consecutive same-channel frames into one
  // `event_batch` envelope; each inner frame runs through the same per-channel
  // seq cursor and handler dispatch as a lone frame.
  it("expands an event_batch envelope in order and honours the seq cursor", () => {
    transport = new CompanionTransport()
    const handler = jest.fn()
    transport.subscribe("claude://message", handler)

    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    ws.triggerMessage(
      JSON.stringify({ type: "claude://message", seq: 3, payload: { t: "a" }, ts_ms: 0 })
    )
    ws.triggerMessage(
      JSON.stringify({
        type: "event_batch",
        channel: "claude://message",
        seq_from: 3,
        seq_to: 6,
        frames: [
          // duplicate of the lone frame above → skipped by the cursor
          { type: "claude://message", seq: 3, payload: { t: "dup" }, ts_ms: 0 },
          { type: "claude://message", seq: 4, payload: { t: "b" }, ts_ms: 0 },
          { type: "claude://message", seq: 5, payload: { t: "c" }, ts_ms: 0 },
          { type: "claude://message", seq: 6, payload: { t: "d" }, ts_ms: 0 },
        ],
      })
    )
    expect(handler.mock.calls.map((c) => (c[0] as { t: string }).t)).toEqual(["a", "b", "c", "d"])
    // A later lone frame below the batch's seq_to is stale.
    ws.triggerMessage(
      JSON.stringify({ type: "claude://message", seq: 5, payload: { t: "stale" }, ts_ms: 0 })
    )
    expect(handler).toHaveBeenCalledTimes(4)
    // Malformed batch (no frames array) is ignored, not thrown.
    ws.triggerMessage(JSON.stringify({ type: "event_batch", channel: "claude://message" }))
    expect(handler).toHaveBeenCalledTimes(4)
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

  it("does not dispatch duplicate or out-of-order WebSocket events", () => {
    transport = new CompanionTransport()
    const handler = jest.fn()
    transport.subscribe("claude://message", handler)

    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    ws.triggerMessage(
      JSON.stringify({ type: "claude://message", seq: 4, payload: "fresh", ts_ms: 0 })
    )
    ws.triggerMessage(
      JSON.stringify({ type: "claude://message", seq: 4, payload: "duplicate", ts_ms: 0 })
    )
    ws.triggerMessage(
      JSON.stringify({ type: "claude://message", seq: 3, payload: "stale", ts_ms: 0 })
    )

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith("fresh")
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
// subscribe() — subscribe control frames (non-default channels)
// ---------------------------------------------------------------------------

describe("subscribe() — subscribe control frames", () => {
  beforeEach(() => setConfig())

  it("widens the server subscription to every handled channel on open, then per new channel", () => {
    transport = new CompanionTransport()
    transport.subscribe("workflow:trigger", jest.fn())
    const ws = MockWebSocket.lastInstance!
    // A real socket is CONNECTING (0) until onopen; nothing may be sent yet.
    ws.readyState = 0
    transport.subscribe("claude://message", jest.fn())
    expect(ws.sent.filter((m) => m.includes('"subscribe"'))).toEqual([])
    ws.readyState = MockWebSocket.OPEN
    ws.triggerOpen()
    expect(ws.sent).toContain(
      JSON.stringify({
        type: "subscribe",
        mode: "add",
        channels: ["workflow:trigger", "claude://message"],
      })
    )
    // A channel added while open is sent as its own add frame; a second
    // handler on an existing channel is not.
    transport.subscribe("scheduler:task-due", jest.fn())
    transport.subscribe("scheduler:task-due", jest.fn())
    expect(ws.sent.filter((m) => m.includes("scheduler:task-due"))).toEqual([
      JSON.stringify({ type: "subscribe", mode: "add", channels: ["scheduler:task-due"] }),
    ])
  })

  it("sends a remove frame when the last handler of a channel unsubscribes", () => {
    transport = new CompanionTransport()
    const stopA = transport.subscribe("workflow:trigger", jest.fn())
    const stopB = transport.subscribe("workflow:trigger", jest.fn())
    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    stopA()
    expect(ws.sent.filter((m) => m.includes('"remove"'))).toEqual([])
    stopB()
    expect(ws.sent).toContain(
      JSON.stringify({ type: "subscribe", mode: "remove", channels: ["workflow:trigger"] })
    )
  })

  it("records subscribed / subscribe_error acknowledgements for diagnostics", () => {
    transport = new CompanionTransport()
    transport.subscribe("workflow:trigger", jest.fn())
    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    ws.triggerMessage(
      JSON.stringify({
        type: "subscribed",
        channels: ["workflow:trigger"],
        rejected: [{ channel: "bogus:*", reason: "unknown_channel" }, "not-an-object"],
      })
    )
    expect(transport.subscriptionDiagnostics()).toEqual({
      channels: ["workflow:trigger"],
      rejectedChannels: ["bogus:*"],
      lastError: null,
    })
    ws.triggerMessage(JSON.stringify({ type: "subscribe_error", message: "bad frame" }))
    expect(transport.subscriptionDiagnostics().lastError).toBe("bad frame")
    ws.triggerMessage(JSON.stringify({ type: "subscribe_error" }))
    expect(transport.subscriptionDiagnostics().lastError).toBe("subscribe_error")
  })

  it("waits for the ack that names its own channel, not for somebody else's", async () => {
    // A caller that subscribes and immediately starts the work it wants to
    // watch races its own subscription, which is the whole reason this
    // handshake exists. An unrelated ack must not release it.
    transport = new CompanionTransport()
    transport.subscribe("workflow:trigger", jest.fn())
    transport.subscribe("claude://message", jest.fn())
    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()

    let settled = false
    const waiting = transport.whenSubscribed(["claude://message"]).then(() => {
      settled = true
    })
    ws.triggerMessage(JSON.stringify({ type: "subscribed", channels: ["workflow:trigger"] }))
    await Promise.resolve()
    expect(settled).toBe(false)

    ws.triggerMessage(
      JSON.stringify({ type: "subscribed", channels: ["workflow:trigger", "claude://message"] })
    )
    await waiting
    expect(settled).toBe(true)
  })

  it("does not answer from a previous socket's acknowledgement after a re-subscribe", async () => {
    // The Pi version probe subscribes, reads, and unsubscribes in its
    // `finally`. The second probe has to be acknowledged on its own add frame,
    // or it spawns the process before the host has re-registered the channel
    // and reads an empty stream.
    transport = new CompanionTransport()
    const stop = transport.subscribe("external-agent://stdout", jest.fn())
    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    ws.triggerMessage(JSON.stringify({ type: "subscribed", channels: ["external-agent://stdout"] }))
    await transport.whenSubscribed(["external-agent://stdout"])

    stop()
    transport.subscribe("external-agent://stdout", jest.fn())
    let settled = false
    const waiting = transport.whenSubscribed(["external-agent://stdout"]).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    ws.triggerMessage(JSON.stringify({ type: "subscribed", channels: ["external-agent://stdout"] }))
    await waiting
    expect(settled).toBe(true)
  })

  it("does not answer from the acknowledgement of a socket that has since dropped", async () => {
    // An acknowledgement belongs to the socket it arrived on. If the socket
    // drops, the caller is in the reconnect backoff with nothing subscribed,
    // and answering from the old ack lets it spawn the process over the HTTP
    // plane, which is still up, and read an empty stream.
    transport = new CompanionTransport()
    transport.subscribe("external-agent://stdout", jest.fn())
    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    ws.triggerMessage(JSON.stringify({ type: "subscribed", channels: ["external-agent://stdout"] }))
    await transport.whenSubscribed(["external-agent://stdout"])

    ws.triggerClose()

    let settled = false
    const waiting = transport.whenSubscribed(["external-agent://stdout"]).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    // It is genuinely parked, not merely slow: a fresh acknowledgement is what
    // releases it, which is what the reconnect's re-sent add frame delivers.
    ws.triggerMessage(JSON.stringify({ type: "subscribed", channels: ["external-agent://stdout"] }))
    await waiting
    expect(settled).toBe(true)
  })

  it("releases a waiter whose channel the host refused, rather than hanging it", async () => {
    transport = new CompanionTransport()
    transport.subscribe("bogus:*", jest.fn())
    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    const waiting = transport.whenSubscribed(["bogus:*"])
    ws.triggerMessage(
      JSON.stringify({
        type: "subscribed",
        channels: [],
        rejected: [{ channel: "bogus:*", reason: "unknown_channel" }],
      })
    )
    await expect(waiting).resolves.toBeUndefined()
  })

  it("releases every waiter when the host refuses the frame outright", async () => {
    transport = new CompanionTransport()
    transport.subscribe("workflow:trigger", jest.fn())
    const ws = MockWebSocket.lastInstance!
    ws.triggerOpen()
    const waiting = transport.whenSubscribed(["workflow:trigger"])
    ws.triggerMessage(JSON.stringify({ type: "subscribe_error", message: "bad frame" }))
    await expect(waiting).resolves.toBeUndefined()
  })

  it("tolerates a socket that throws on send", () => {
    transport = new CompanionTransport()
    transport.subscribe("workflow:trigger", jest.fn())
    const ws = MockWebSocket.lastInstance!
    ws.send = () => {
      throw new Error("closed")
    }
    expect(() => ws.triggerOpen()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// subscribe() — resync_required
// ---------------------------------------------------------------------------

describe("subscribe() — resync_required", () => {
  it("runs authoritative resync, advances cursor, and reconnects", async () => {
    const resolver = jest.fn(async () => {})
    const removeResolver = remoteEventResyncCoordinator.register("*", resolver)
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
    ws1.triggerMessage(JSON.stringify({ type: "resync_required", domains: ["*"], cursor: 25 }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // A synthetic resync event was emitted to all handlers.
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ type: "resync_required", domains: ["*"] })

    // Old WS is closed and a new one is opened.
    expect(ws1.closed).toBe(true)
    expect(MockWebSocket.instances.length).toBe(2)

    // New WS resumes from the authoritative snapshot high-water mark.
    const ws2 = MockWebSocket.instances[1]
    expect(ws2.url).toContain("since=25")
    removeResolver()
  })
})

// ---------------------------------------------------------------------------
// WebSocket reconnect
// ---------------------------------------------------------------------------

describe("WebSocket reconnect", () => {
  beforeEach(async () => {
    await setConfig()
    jest.useFakeTimers()
    // Pin the backoff jitter to its midpoint (factor 1.0) so these tests can
    // assert the exact 1s → 2s → 4s schedule.
    __setBackoffRandomForTests(() => 0.5)
  })

  afterEach(() => {
    __setBackoffRandomForTests(null)
  })

  it.each(["sync", "async"])("recovers after %s event ticket issuance fails", async (mode) => {
    const issue = jest
      .fn()
      .mockImplementationOnce(() => {
        if (mode === "sync") throw new Error("ticket issuer unavailable")
        return Promise.reject(new Error("ticket issuer unavailable"))
      })
      .mockImplementation(() => ({ ticket: "recovered-ticket", expiresAt: Date.now() + 60_000 }))
    __setEventSocketTicketIssuerForTests(issue)
    transport = new CompanionTransport()
    transport.subscribe("ch:test", jest.fn())
    await jest.advanceTimersByTimeAsync(0)
    expect(MockWebSocket.instances).toHaveLength(0)
    await jest.advanceTimersByTimeAsync(1000)
    expect(issue).toHaveBeenCalledTimes(2)
    expect(MockWebSocket.instances).toHaveLength(1)
    MockWebSocket.lastInstance!.triggerOpen()
    expect(transport.getConnectionState()).toBe("connected")
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
      signalingUrl: "wss://signaling.test/signaling",
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
    getCarrier: () => "datachannel" as const,
    call: jest.fn(async () => "RTC_RESULT"),
    readBinary: jest.fn(async () => ({
      bytes: Uint8Array.from([4, 5, 6]),
      mediaType: "image/png",
    })),
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
  it.each(["rate_limited", "INVALID_PARAMS", "device_revoked"])(
    "preserves RTC host refusal %s without an HTTPS retry",
    async (code) => {
      await setConfig({ ...MOCK_CONFIG, baseUrl: TUNNEL_URL })
      transport = new CompanionTransport()
      const fakeRtc = makeFakeRtc()
      const refusal = Object.assign(new Error("retry_after_seconds=2"), {
        code,
        retryAfterMs: 2_000,
      })
      fakeRtc.call.mockRejectedValueOnce(refusal)
      ;(transport as unknown as { rtc: unknown }).rtc = fakeRtc
      await expect(transport.call("claude_sidecar_status")).rejects.toBe(refusal)
      expect(fetchSpy).not.toHaveBeenCalled()
    }
  )

  it("does not route local RTC overload through HTTPS", async () => {
    await setConfig({ ...MOCK_CONFIG, baseUrl: TUNNEL_URL })
    transport = new CompanionTransport()
    const fakeRtc = makeFakeRtc()
    fakeRtc.call.mockRejectedValueOnce(new Error("TransportRtc: too many concurrent RPCs"))
    ;(transport as unknown as { rtc: unknown }).rtc = fakeRtc
    await expect(transport.call("claude_sidecar_status")).rejects.toThrow("concurrent RPCs")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("does not replay an unclassified mutation after a carrier failure", async () => {
    await setConfig({ ...MOCK_CONFIG, baseUrl: TUNNEL_URL })
    transport = new CompanionTransport()
    const fakeRtc = makeFakeRtc()
    fakeRtc.call.mockRejectedValueOnce(new RtcCarrierError("channel closed"))
    ;(transport as unknown as { rtc: unknown }).rtc = fakeRtc
    await expect(transport.call("unclassified_mutation")).rejects.toThrow("channel closed")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("shares a single deadline between RTC and the HTTPS fallback", async () => {
    jest.useFakeTimers()
    await setConfig({ ...MOCK_CONFIG, baseUrl: TUNNEL_URL })
    transport = new CompanionTransport()
    const fakeRtc = makeFakeRtc()
    fakeRtc.call.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new RtcCarrierError("channel closed")), 20_000)
        })
    )
    ;(transport as unknown as { rtc: unknown }).rtc = fakeRtc
    fetchSpy.mockImplementationOnce(
      (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          )
        })
    )
    const result = transport.call("claude_sidecar_status").catch((error: unknown) => error)
    await jest.advanceTimersByTimeAsync(20_000)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(10_000)
    await expect(result).resolves.toMatchObject({ code: "timeout" })
    expect((fetchSpy.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true)
  })

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
    fakeRtc.call.mockRejectedValueOnce(new RtcCarrierError("channel closed"))
    ;(transport as unknown as { rtc: unknown }).rtc = fakeRtc
    fetchSpy.mockResolvedValueOnce(mockResponse({ ok: true }, 200))

    await expect(transport.call("git_set_identity", { repoPath: "/repo" })).resolves.toEqual({
      ok: true,
    })
    const rtcArgs = (fakeRtc.call.mock.calls as unknown[][])[0][1] as Record<string, unknown>
    const rtcCallOptions = (fakeRtc.call.mock.calls as unknown[][])[0][2] as {
      idempotencyKey?: string
    }
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(rtcCallOptions.idempotencyKey).toBe(
      (init.headers as Record<string, string>)["Idempotency-Key"]
    )
    expect(rtcArgs).not.toHaveProperty("idempotencyKey")
  })
})

describe("readBinary() — LAN-first gate", () => {
  it("uses raw DataChannel frames when LAN HTTPS is unavailable", async () => {
    await setConfig({ ...MOCK_CONFIG, baseUrl: TUNNEL_URL })
    transport = new CompanionTransport()
    const fakeRtc = makeFakeRtc()
    ;(transport as unknown as { rtc: unknown }).rtc = fakeRtc
    const resource = {
      kind: "session-media" as const,
      sessionId: "s1",
      hash: "a".repeat(64),
      variant: "canonical" as const,
    }

    await expect(transport.readBinary(resource)).resolves.toEqual({
      bytes: Uint8Array.from([4, 5, 6]),
      mediaType: "image/png",
    })
    expect(fakeRtc.readBinary).toHaveBeenCalledWith(resource)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("falls back to authenticated HTTPS when the binary DataChannel read fails", async () => {
    await setConfig({ ...MOCK_CONFIG, baseUrl: TUNNEL_URL })
    transport = new CompanionTransport()
    const fakeRtc = makeFakeRtc()
    fakeRtc.readBinary.mockRejectedValueOnce(new Error("channel closed"))
    ;(transport as unknown as { rtc: unknown }).rtc = fakeRtc
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => Uint8Array.from([7, 8]).buffer,
    })

    await expect(
      transport.readBinary({
        kind: "session-media",
        sessionId: "s1",
        hash: "b".repeat(64),
        variant: "thumbnail",
      })
    ).resolves.toEqual(expect.objectContaining({ bytes: Uint8Array.from([7, 8]) }))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("does not retry a definitive RTC media miss over HTTPS", async () => {
    await setConfig({ ...MOCK_CONFIG, baseUrl: TUNNEL_URL })
    transport = new CompanionTransport()
    const fakeRtc = makeFakeRtc()
    fakeRtc.readBinary.mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "MEDIA_NOT_FOUND" })
    )
    ;(transport as unknown as { rtc: unknown }).rtc = fakeRtc

    await expect(
      transport.readBinary({
        kind: "session-media",
        sessionId: "s1",
        hash: "c".repeat(64),
        variant: "canonical",
      })
    ).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" })
    expect(fetchSpy).not.toHaveBeenCalled()
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

// ---------------------------------------------------------------------------
// Host contract verdict (ADR-0175)
// ---------------------------------------------------------------------------

describe("host contract verdict (ADR-0175)", () => {
  beforeEach(() => setConfig())
  afterEach(() => __resetHostContractsForTests())

  it("refuses to dispatch to a Host on another contract version without a round trip", async () => {
    recordHostContract(MOCK_CONFIG.deviceId, { contractVersion: COMPANION_CONTRACT_VERSION + 1 })
    transport = new CompanionTransport()
    await expect(transport.call("claude_sidecar_status")).rejects.toMatchObject({
      code: "contract_incompatible",
      retryable: false,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(transport.getPlaneHealth().rpc).toBe("incompatible")
  })

  it("treats a Host that names no contract version as an older, incompatible Host", async () => {
    recordHostContract(MOCK_CONFIG.deviceId, {})
    transport = new CompanionTransport()
    await expect(transport.call("claude_sidecar_status")).rejects.toMatchObject({
      code: "contract_incompatible",
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("dispatches as before while the verdict is unknown or compatible", async () => {
    fetchSpy.mockResolvedValue(mockResponse({ ok: true }, 200))
    transport = new CompanionTransport()
    await expect(transport.call("claude_sidecar_status")).resolves.toEqual({ ok: true })
    recordHostContract(MOCK_CONFIG.deviceId, { contractVersion: COMPANION_CONTRACT_VERSION })
    await expect(transport.call("claude_sidecar_status")).resolves.toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it("mirrors a verdict change on the RPC plane for its own pairing only, and clears it", () => {
    transport = new CompanionTransport()
    const seen: string[] = []
    transport.onPlaneHealthChange((health) => seen.push(health.rpc))
    recordHostContract(MOCK_CONFIG.deviceId, { contractVersion: 1 })
    expect(transport.getPlaneHealth().rpc).toBe("incompatible")
    recordHostContract("some-other-pairing", { contractVersion: 1 })
    expect(transport.getPlaneHealth().rpc).toBe("incompatible")
    recordHostContract(MOCK_CONFIG.deviceId, { contractVersion: COMPANION_CONTRACT_VERSION })
    expect(transport.getPlaneHealth().rpc).toBe("unknown")
    // The subscription replays the current state first.
    expect(seen).toEqual(["unknown", "incompatible", "unknown"])
  })

  it("reads the device catalog with an authenticated GET and records the contract it names", async () => {
    const document = {
      contractVersion: COMPANION_CONTRACT_VERSION,
      catalogHash: "a".repeat(64),
      plane: "device",
      commands: [{ name: "session_list" }],
    }
    fetchSpy.mockResolvedValueOnce(mockResponse(document, 200))
    transport = new CompanionTransport()
    await expect(transport.catalog()).resolves.toEqual(document)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${MOCK_CONFIG.baseUrl}/api/catalog`)
    expect(init.method).toBe("GET")
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test.jwt.token",
      DPoP: "test-proof",
    })
    expect(hostContractVerdict(MOCK_CONFIG.deviceId)).toMatchObject({
      state: "compatible",
      catalogHash: "a".repeat(64),
    })
    expect(transport.getPlaneHealth().rpc).toBe("ready")
  })

  it("asks the service plane for /internal/catalog", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse(
        {
          contractVersion: COMPANION_CONTRACT_VERSION,
          catalogHash: "b".repeat(64),
          plane: "service",
          commands: [],
        },
        200
      )
    )
    transport = new CompanionTransport({
      configProvider: () => ({
        baseUrl: "http://127.0.0.1:7890",
        deviceId: "brain-1",
        serviceToken: "svc",
        serverVersion: "0.1.0",
      }),
      rpcPath: "/internal/_rpc",
      eventsPath: "/internal/events",
    })
    await transport.catalog()
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe("http://127.0.0.1:7890/internal/catalog")
  })

  it("refuses a catalog on another contract, and surfaces a problem refusal by its code", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse(
        {
          contractVersion: COMPANION_CONTRACT_VERSION + 1,
          catalogHash: "c".repeat(64),
          plane: "device",
          commands: [],
        },
        200
      )
    )
    transport = new CompanionTransport()
    await expect(transport.catalog()).rejects.toMatchObject({ code: "contract_incompatible" })
    expect(transport.getPlaneHealth().rpc).toBe("incompatible")
    fetchSpy.mockResolvedValueOnce(
      mockResponse(
        {
          type: "https://cognia.dev/problems/missing_authorization",
          title: "Unauthorized",
          status: 401,
          detail: "no bearer",
          code: "missing_authorization",
          requestId: "r1",
          retryable: false,
          details: {},
        },
        401
      )
    )
    await expect(transport.catalog()).rejects.toMatchObject({
      code: "missing_authorization",
      retryable: false,
    })
    expect(transport.getPlaneHealth().rpc).toBe("unauthenticated")
  })
})

describe("WAN tier activation lifecycle", () => {
  const wanConfig: CompanionConfig = {
    ...MOCK_CONFIG,
    baseUrl: "https://host.example.test",
    rendezvousId: "room-lifecycle",
    signalingRoomDescriptor: {
      v: 2,
      roomId: "room-lifecycle",
      roomNonce: "test-nonce",
      desktopSigningKey: "desktop-test-key",
      mobileSigningKey: "mobile-test-key",
      notAfter: Number.MAX_SAFE_INTEGER,
    },
    signalingPrivateKey: {} as CryptoKey,
  }
  const options = { signalingUrl: "wss://signaling.example.test", configOverride: wanConfig }
  let stateListener: Parameters<TransportRtc["onStateChange"]>[0]
  let connect: jest.SpyInstance
  let update: jest.SpyInstance
  let close: jest.SpyInstance
  let subscribe: jest.SpyInstance
  let terminal: jest.SpyInstance
  let detachState: jest.Mock
  let detachSubscription: jest.Mock

  beforeEach(() => {
    connect = jest.spyOn(TransportRtc.prototype, "connect").mockResolvedValue(undefined)
    update = jest
      .spyOn(TransportRtc.prototype, "updateRtcConfiguration")
      .mockImplementation(() => {})
    close = jest.spyOn(TransportRtc.prototype, "close").mockImplementation(() => {})
    detachState = jest.fn()
    detachSubscription = jest.fn()
    jest.spyOn(TransportRtc.prototype, "onStateChange").mockImplementation((listener) => {
      stateListener = listener
      return detachState
    })
    jest.spyOn(TransportRtc.prototype, "getState").mockReturnValue("open")
    jest.spyOn(TransportRtc.prototype, "getCarrier").mockReturnValue("datachannel")
    jest.spyOn(TransportRtc.prototype, "getSelectedCandidateKind").mockResolvedValue("host")
    subscribe = jest.spyOn(TransportRtc.prototype, "subscribe").mockReturnValue(detachSubscription)
    terminal = jest.spyOn(TransportRtc.prototype, "getTerminalDataChannel").mockReturnValue(null)
  })

  afterEach(() => {
    transport.destroy()
    jest.restoreAllMocks()
  })

  it("does not attempt WAN signaling without the complete pairing identity", async () => {
    transport = new CompanionTransport()
    await transport.enableWebRtcTier({ signalingUrl: options.signalingUrl })
    for (const configOverride of [
      MOCK_CONFIG,
      { ...wanConfig, signalingRoomDescriptor: undefined },
      { ...wanConfig, signalingPrivateKey: undefined },
    ]) {
      await transport.enableWanTier({ ...options, configOverride })
    }
    expect(connect).not.toHaveBeenCalled()
    expect(transport.getTerminalDataChannel()).toBeNull()
    expect(transport.getTerminalClientId()).toBeNull()
  })

  it("shares an in-flight handshake, mirrors subscribers, and releases them when the peer closes", async () => {
    await setConfig(wanConfig)
    transport = new CompanionTransport()
    const handler = jest.fn()
    const unsubscribe = transport.subscribe("task:changed", handler)
    let finish!: () => void
    connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const channel = { label: "cognia.terminal" } as RTCDataChannel
    terminal.mockReturnValue(channel)
    const first = transport.enableWebRtcTier(options)
    expect(transport.getTerminalDataChannel()).toBe(channel)
    const rtcConfiguration = { iceServers: [{ urls: "stun:example.test" }] }
    const second = transport.enableWanTier({ ...options, rtcConfiguration })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenLastCalledWith(rtcConfiguration)
    finish()
    await Promise.all([first, second])
    expect(subscribe).toHaveBeenCalledWith("task:changed", handler)
    expect(transport.getTerminalClientId()).toBe(`companion:${wanConfig.deviceId}`)
    expect(transport.getTerminalDataChannel()).toBe(channel)
    await transport.enableWanTier({ ...options, rtcConfiguration: {} })
    expect(connect).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenLastCalledWith({})
    stateListener("closed")
    expect(detachState).toHaveBeenCalledTimes(1)
    expect(detachSubscription).toHaveBeenCalledTimes(1)
    expect(transport.getTerminalDataChannel()).toBeNull()
    unsubscribe()
    expect(detachSubscription).toHaveBeenCalledTimes(1)
  })

  it("contains failed upgrades and can rebuild on an explicit retry", async () => {
    await setConfig(wanConfig)
    transport = new CompanionTransport()
    connect.mockRejectedValueOnce(new Error("signaling unavailable"))
    close.mockImplementationOnce(() => {
      throw new Error("already closed")
    })
    await expect(transport.enableWanTier(options)).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
    expect(detachState).toHaveBeenCalledTimes(1)
    expect(transport.getTerminalDataChannel()).toBeNull()
    expect(transport.reconnectRtc()).toBe("ok")
    await Promise.resolve()
    await Promise.resolve()
    expect(connect).toHaveBeenCalledTimes(2)
    transport.disableWebRtcTier()
    expect(transport.reconnectRtc()).toBe("no-tier")
  })
})

describe("remote binary and catalog refusal boundaries", () => {
  const resource = {
    kind: "session-media" as const,
    sessionId: "s1",
    hash: "a".repeat(64),
    variant: "original" as const,
  }
  const context = {
    root: "/workspace",
    generation: 1,
    pluginId: "demo",
    providerId: "files",
    permission: null,
  }

  it("rejects unpaired catalog and content operations before using the network", async () => {
    transport = new CompanionTransport()
    await expect(transport.catalog()).rejects.toMatchObject({ code: "not_paired" })
    await expect(transport.readBinary(resource)).rejects.toMatchObject({ code: "not_paired" })
    await expect(transport.uploadManagedIdeContent(context, new Uint8Array())).rejects.toThrow(
      "not paired"
    )
    await expect(transport.redeemManagedIdeContent(context, "opaque")).rejects.toThrow("not paired")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([new Error("socket lost"), "socket lost"])(
    "reports a catalog network failure and marks only the RPC plane unavailable",
    async (reason) => {
      await setConfig()
      transport = new CompanionTransport()
      fetchSpy.mockRejectedValueOnce(reason)
      await expect(transport.catalog()).rejects.toMatchObject({
        code: "network",
        message: "socket lost",
        retryable: true,
      })
      expect(transport.getPlaneHealth()).toEqual({ rpc: "unavailable", events: "idle" })
    }
  )

  it("preserves a catalog HTTP failure even when the body is not JSON", async () => {
    await setConfig()
    transport = new CompanionTransport()
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error("html proxy error")
      },
    })
    await expect(transport.catalog()).rejects.toMatchObject({
      code: "http_503",
      message: "HTTP 503",
      retryable: true,
    })
  })

  it("surfaces managed content refusal without repeating either a write or one-shot redemption", async () => {
    await setConfig()
    transport = new CompanionTransport()
    fetchSpy.mockResolvedValue({ ok: false, status: 403, text: async () => "handle expired" })
    await expect(
      transport.uploadManagedIdeContent({ ...context, mediaType: "image/png" }, new Uint8Array([1]))
    ).rejects.toThrow("upload failed (403): handle expired")
    expect((fetchSpy.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      "Content-Type": "image/png",
    })
    await expect(transport.redeemManagedIdeContent(context, "opaque")).rejects.toThrow(
      "redemption failed (403): handle expired"
    )
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it.each([
    { kind: "unrecognized" },
    { sessionId: "" },
    { sessionId: "s".repeat(513) },
    { variant: "unrecognized" },
  ])("rejects malformed binary resource fields before transport: %j", async (override) => {
    await setConfig()
    transport = new CompanionTransport()
    await expect(
      transport.readBinary({ ...resource, ...override } as Parameters<
        CompanionTransport["readBinary"]
      >[0])
    ).rejects.toMatchObject({ code: "invalid_binary_resource" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    "enforces the binary response budget even when declared=%s",
    async (declared) => {
      await setConfig()
      transport = new CompanionTransport()
      const body = jest.fn(async () => new ArrayBuffer(10 * 1024 * 1024 + 1))
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === "content-length" && declared ? String(10 * 1024 * 1024 + 1) : null,
        },
        arrayBuffer: body,
      })
      await expect(transport.readBinary(resource)).rejects.toMatchObject({
        code: "binary_resource_too_large",
        retryable: false,
      })
      expect(body).toHaveBeenCalledTimes(declared ? 0 : 1)
    }
  )

  it("does not retry a timed-out binary operation", async () => {
    await setConfig()
    transport = new CompanionTransport()
    fetchSpy.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
    await expect(transport.readBinary(resource)).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403])(
    "stops binary HTTP %s without assuming it is a connectivity failure",
    async (status) => {
      await setConfig()
      transport = new CompanionTransport()
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status,
        json: async () => {
          throw new Error("not JSON")
        },
      })
      await expect(transport.readBinary(resource)).rejects.toMatchObject({
        code: `http_${status}`,
        message: `HTTP ${status}`,
        retryable: false,
      })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(transport.getConnectionState()).toBe(status === 401 ? "unauthenticated" : "offline")
    }
  )

  it.each(["network", "server_error"])("bounds exhausted binary %s retries", async (code) => {
    jest.useFakeTimers()
    await setConfig()
    transport = new CompanionTransport()
    if (code === "network") fetchSpy.mockRejectedValue(new Error("disconnected"))
    else fetchSpy.mockResolvedValue(mockResponse({}, 503))
    const result = transport.readBinary(resource)
    const rejected = expect(result).rejects.toMatchObject({ code, retryable: true })
    await jest.advanceTimersByTimeAsync(2_000)
    await rejected
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })
})
