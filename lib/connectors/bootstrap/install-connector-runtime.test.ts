/**
 * @jest-environment jsdom
 *
 * installConnectorRuntime — the shared connector bootstrap (extracted from
 * ConnectorBusProvider; this suite is the ported provider suite plus the
 * installer-only options: rowFilter, log, skipHostGate).
 */

import { installConnectorRuntime } from "./install-connector-runtime"
import { isTauri } from "@/lib/tauri"
import { hasTaskExecutor, unregisterTaskExecutor } from "@/lib/scheduler"
import type { NormalizedInboundEvent } from "@/types/connectors"

// ── Mock isTauri ─────────────────────────────────────────────────────────────
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

// ── Mock listEnabledAdapterInstances ─────────────────────────────────────────
const mockListEnabled = jest.fn()
jest.mock("@/lib/db/adapter-instances", () => ({
  listEnabledAdapterInstances: (...args: unknown[]) => mockListEnabled(...args),
}))

// ── Mock installRuntime ───────────────────────────────────────────────────────
const mockInstallRuntime = jest.fn()
const mockInsertInboundMessage = jest.fn().mockResolvedValue({ id: "stored-message" })
const mockInboundEventToSendContent = jest.fn((event: NormalizedInboundEvent) => event.plainText)
jest.mock("@/lib/connectors/runtime", () => ({
  installRuntime: (...args: unknown[]) => mockInstallRuntime(...args),
  insertInboundMessage: (...args: unknown[]) => mockInsertInboundMessage(...args),
  inboundEventToSendContent: (...args: [NormalizedInboundEvent]) =>
    mockInboundEventToSendContent(...args),
}))

const mockSteerSession = jest.fn().mockResolvedValue({ accepted: true })
jest.mock("@/lib/claude/ipc", () => ({
  steerSession: (...args: unknown[]) => mockSteerSession(...args),
}))

const mockIsPiiSafeSendContent = jest.fn((..._args: unknown[]) => true)
jest.mock("@/lib/connectors/ai-loop/safe-send-prompt", () => ({
  safeSendPrompt: jest.fn(),
  isPiiSafeSendContent: (...args: unknown[]) => mockIsPiiSafeSendContent(...args),
  PiiGateBlocked: class PiiGateBlocked extends Error {},
}))

// ── Mock startOutboundRunner ─────────────────────────────────────────────────
const mockStartOutboundRunner = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/connectors/outbound-runner", () => ({
  startOutboundRunner: (...args: unknown[]) => mockStartOutboundRunner(...args),
}))

// ── Mock getBus + registerAdapter ────────────────────────────────────────────
const mockRegisterAdapter = jest.fn()
const mockUnregisterAdapterBus = jest.fn()
const mockListAdapters = jest.fn().mockReturnValue([])
const mockResumeDurableInboundJobs = jest
  .fn()
  .mockResolvedValue({ resumed: 0, recoveryRequired: 0 })
const mockRecoverActiveConversationHistory = jest
  .fn()
  .mockResolvedValue({ conversations: 0, executed: 0, historyOnly: 0 })
const mockBus = {
  registerAdapter: mockRegisterAdapter,
  unregisterAdapter: mockUnregisterAdapterBus,
  listAdapters: mockListAdapters,
  resumeDurableInboundJobs: mockResumeDurableInboundJobs,
  recoverActiveConversationHistory: mockRecoverActiveConversationHistory,
}
jest.mock("@/lib/connectors/bus", () => ({
  getBus: () => mockBus,
}))

// ── Mock buildAdapterFromRow ──────────────────────────────────────────────────
const mockBuildAdapterFromRow = jest.fn()
jest.mock("@/lib/connectors/adapter-registry", () => ({
  buildAdapterFromRow: (...args: unknown[]) => mockBuildAdapterFromRow(...args),
}))

// ── Mock Tauri keyring / http / server lifecycle ─────────────────────────────
const mockStartServer = jest.fn().mockResolvedValue("127.0.0.1:7842")
const mockStopServer = jest.fn().mockResolvedValue(undefined)
const mockRegisterAdapterCmd = jest.fn().mockResolvedValue(undefined)
const mockUnregisterAdapterCmd = jest.fn().mockResolvedValue(undefined)
const mockResetAllWs = jest.fn().mockResolvedValue(0)
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringGet: jest.fn().mockResolvedValue(null),
  connectorsHttpRequest: jest.fn().mockResolvedValue({ status: 200, body: "{}", headers: {} }),
  connectorsStartServer: (...args: unknown[]) => mockStartServer(...args),
  connectorsStopServer: (...args: unknown[]) => mockStopServer(...args),
  connectorsRegisterAdapter: (...args: unknown[]) => mockRegisterAdapterCmd(...args),
  connectorsUnregisterAdapter: (...args: unknown[]) => mockUnregisterAdapterCmd(...args),
  connectorsResetAllWs: (...args: unknown[]) => mockResetAllWs(...args),
}))

// ── Mock the AdapterContext factory (no IndexedDB needed for unit test) ──
const mockBuildAdapterContext = jest.fn().mockReturnValue({
  adapterId: "stub",
  signal: new AbortController().signal,
  emit: jest.fn(),
  tauri: {},
  secrets: {},
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
})
jest.mock("@/lib/connectors/adapter-context", () => ({
  buildAdapterContext: (...args: unknown[]) => mockBuildAdapterContext(...args),
}))

// ── Mock appendAudit (writes to Dexie; jsdom has no IDB) ─────────────────
const mockAppendAudit = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/connectors/audit", () => ({
  appendAudit: (...args: unknown[]) => mockAppendAudit(...args),
}))

// ── Mock the consolidated heartbeat sweep (writes to Dexie; jsdom has no IDB) ─
const mockSweepDispose = jest.fn()
const mockStartHeartbeatSweep = jest.fn().mockImplementation(() => ({ dispose: mockSweepDispose }))
jest.mock("@/lib/connectors/health/heartbeat-sweep", () => ({
  startHeartbeatSweep: (...args: unknown[]) => mockStartHeartbeatSweep(...args),
}))

// ── Mock the durable low-frequency housekeeping schedule ─────────────────────
const mockInstallHousekeepingSchedule = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/connectors/housekeeping-scheduler", () => ({
  installConnectorHousekeepingSchedule: (...args: unknown[]) =>
    mockInstallHousekeepingSchedule(...args),
}))

jest.mock("@/lib/connectors/daily-schedule", () => ({
  // The Lark surface + bind-request sweeps build on the generic scheduler, so
  // a partial mock of this module leaves them calling `undefined` and takes
  // the whole runtime boot down with it.
  startDailySchedule: () => ({ dispose: jest.fn(), runNow: jest.fn(async () => undefined) }),
}))

// ── Mock the immediate per-boot heartbeat (writes to Dexie; jsdom has no IDB) ─
const mockRecordHeartbeatNow = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/connectors/health/heartbeat", () => ({
  recordHeartbeatNow: (...args: unknown[]) => mockRecordHeartbeatNow(...args),
}))

// ── Mock the lifecycle registry so we can assert registration calls ──────
interface MockLifecycleEntry {
  adapter: { id: string; stop: jest.Mock }
  abortController: AbortController
  restart: jest.Mock
  owner?: "adapter-instance" | "plugin"
}
const lifecycleRegistry = new Map<string, MockLifecycleEntry>()
const mockRegisterRunning = jest.fn((id: string, entry: unknown) => {
  lifecycleRegistry.set(id, entry as MockLifecycleEntry)
})
const mockUnregisterRunning = jest.fn((id: string) => {
  const entry = lifecycleRegistry.get(id)
  lifecycleRegistry.delete(id)
  if (!entry) return
  entry.abortController.abort()
  // Same fire-and-forget shape as the production implementation,
  // including the error log so the "swallows adapter.stop()" test passes.
  void entry.adapter.stop().catch((err: unknown) => {
    console.error(
      `[lifecycle] adapter ${id} failed to stop: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  })
})
const mockListRunning = jest.fn(() => Array.from(lifecycleRegistry.values()))
const suspendedLifecycleRegistry = new Map<string, MockLifecycleEntry>()
const mockSuspendRunningByOwner = jest.fn((owner: "adapter-instance" | "plugin") => {
  for (const [id, entry] of lifecycleRegistry) {
    if (entry.owner !== owner) continue
    lifecycleRegistry.delete(id)
    suspendedLifecycleRegistry.set(id, entry)
    entry.abortController.abort()
    void entry.adapter.stop().catch(() => undefined)
  }
})
const mockResumeSuspendedByOwner = jest.fn(async (owner: "adapter-instance" | "plugin") => {
  for (const [id, entry] of Array.from(suspendedLifecycleRegistry.entries())) {
    if (entry.owner !== owner) continue
    suspendedLifecycleRegistry.delete(id)
    await entry.restart()
  }
})
jest.mock("@/lib/connectors/lifecycle", () => ({
  registerRunningAdapter: (...args: [string, unknown]) => mockRegisterRunning(...args),
  unregisterRunningAdapter: (...args: [string]) => mockUnregisterRunning(...args),
  listRunningAdapters: () => mockListRunning(),
  suspendRunningAdaptersByOwner: (...args: ["adapter-instance" | "plugin"]) =>
    mockSuspendRunningByOwner(...args),
  resumeSuspendedAdaptersByOwner: (...args: ["adapter-instance" | "plugin"]) =>
    mockResumeSuspendedByOwner(...args),
  subscribeCredentialsRotatedToLifecycle: () => () => {},
}))

// ── Mock the dynamic import of `@/lib/db/schema` used by the G6 capability
// refresh block. Returning a stub `getDb` with a no-op `update` keeps the
// installer's startup loop from hitting IndexedDB. ────────────────────────────
const mockAdapterInstancesUpdate = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    adapterInstances: { update: (...args: unknown[]) => mockAdapterInstancesUpdate(...args) },
  }),
}))

const makeTelegramRow = (id = "cai_tg_1") => ({
  id,
  type: "telegram" as const,
  displayName: "Test Bot",
  enabled: true,
  transportMode: "longpoll" as const,
  settings: {},
  credentialsRef: { keyringService: "cognia", accounts: [] },
  trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
  defaultMode: "auto" as const,
  createdAt: Date.now(),
  updatedAt: Date.now(),
})

const makeFakeAdapter = (id: string) => ({
  id,
  meta: {
    type: "telegram" as const,
    displayName: "Test Bot",
    version: "0.1.0",
    capabilities: [],
    transportModes: ["longpoll" as const],
    configSchema: {},
  },
  // Both lifecycle entry-points are awaited via `.catch()` in production
  // (see `lifecycle.ts`), so they must return Promises by default — bare
  // `jest.fn()` returns undefined which trips the catch chain.
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  health: jest.fn(),
  send: jest.fn(),
  a2uiCapability: jest.fn().mockReturnValue({}),
})

/** waitFor without RTL — poll until the assertion stops throwing. */
const waitFor = async (assertion: () => void, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      assertion()
      return
    } catch (err) {
      if (Date.now() > deadline) throw err
      await new Promise((r) => setTimeout(r, 10))
    }
  }
}

const disposers: Array<() => void> = []
const install = (...args: Parameters<typeof installConnectorRuntime>) => {
  const dispose = installConnectorRuntime(...args)
  disposers.push(dispose)
  return dispose
}

beforeEach(() => {
  jest.clearAllMocks()
  mockIsPiiSafeSendContent.mockReturnValue(true)
  mockSteerSession.mockResolvedValue({ accepted: true })
  mockListAdapters.mockReturnValue([])
  lifecycleRegistry.clear()
  suspendedLifecycleRegistry.clear()
  mockStartHeartbeatSweep.mockImplementation(() => ({ dispose: mockSweepDispose }))
  mockInstallHousekeepingSchedule.mockResolvedValue(undefined)
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  // Registration goes through the real (unmocked) scheduler executor Map —
  // clear it between tests so one test's registration doesn't leak into the
  // next via the shared module singleton.
  unregisterTaskExecutor("connection:outbound:send")
  unregisterTaskExecutor("connection:scheduled:digest")
})

describe("installConnectorRuntime", () => {
  it("does nothing in web mode", async () => {
    mockedIsTauri.mockReturnValue(false)
    install()
    // Give the (never-started) async boot time to run
    await new Promise((r) => setTimeout(r, 50))
    expect(mockListEnabled).not.toHaveBeenCalled()
    expect(mockRegisterAdapter).not.toHaveBeenCalled()
    expect(mockInstallRuntime).not.toHaveBeenCalled()
    expect(mockStartOutboundRunner).not.toHaveBeenCalled()
    expect(mockResetAllWs).not.toHaveBeenCalled()
  })

  it("registers the connector scheduler-task executors when booting in Tauri mode", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockListEnabled.mockResolvedValue([])

    install()

    await waitFor(() => {
      expect(hasTaskExecutor("connection:outbound:send")).toBe(true)
      expect(hasTaskExecutor("connection:scheduled:digest")).toBe(true)
    })
  })

  it("does not register the connector scheduler-task executors in web mode", async () => {
    mockedIsTauri.mockReturnValue(false)

    install()
    await new Promise((r) => setTimeout(r, 50))

    expect(hasTaskExecutor("connection:outbound:send")).toBe(false)
    expect(hasTaskExecutor("connection:scheduled:digest")).toBe(false)
  })

  it("registers one adapter per enabled row in Tauri mode", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow()
    const fakeAdapter = makeFakeAdapter(row.id)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(fakeAdapter)
    mockListAdapters.mockReturnValue([fakeAdapter])

    install()

    await waitFor(() => {
      expect(mockRegisterAdapter).toHaveBeenCalledTimes(1)
      expect(mockRegisterAdapter).toHaveBeenCalledWith(fakeAdapter)
    })
    expect(mockInstallRuntime).toHaveBeenCalledTimes(1)
    expect(mockResumeDurableInboundJobs).toHaveBeenCalledWith({ reclaimRunning: true })
    expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1)
  })

  it("wires durable PII-gated live steer into the installed runtime", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockListEnabled.mockResolvedValue([])
    install()
    await waitFor(() => expect(mockInstallRuntime).toHaveBeenCalledTimes(1))

    const options = mockInstallRuntime.mock.calls[0]?.[1] as {
      liveSteerCoordinator: {
        activate(run: {
          conversationKey: string
          sessionId: string
          executionRunId: string
          provider: string
        }): () => void
        handle(event: NormalizedInboundEvent): Promise<{ accepted: boolean }>
      }
    }
    options.liveSteerCoordinator.activate({
      conversationKey: "lark:lark-1:chat-1",
      sessionId: "session-1",
      executionRunId: "run-1",
      provider: "anthropic",
    })
    const event: NormalizedInboundEvent = {
      platform: "lark",
      adapterId: "lark-1",
      selfId: "bot-1",
      messageId: "om-steer",
      conversationRef: { platform: "lark", adapterId: "lark-1", channelId: "chat-1" },
      conversationKey: "lark:lark-1:chat-1",
      sender: {
        id: "identity-1",
        platform: "lark",
        adapterId: "lark-1",
        remoteUserId: "ou-1",
      },
      channel: { id: "chat-1", kind: "private" },
      segments: [{ type: "text", text: "redirect" }],
      plainText: "redirect",
      mentions: { selfMentioned: false, users: [] },
      timestamp: 1,
      raw: {},
    }

    await expect(options.liveSteerCoordinator.handle(event)).resolves.toMatchObject({
      accepted: true,
    })
    expect(mockInsertInboundMessage).toHaveBeenCalledWith(event, "session-1")
    expect(mockSteerSession).toHaveBeenCalledWith("session-1", "redirect", "om-steer")

    mockIsPiiSafeSendContent.mockReturnValue(false)
    await expect(
      options.liveSteerCoordinator.handle({ ...event, messageId: "om-blocked" })
    ).resolves.toMatchObject({ accepted: false })
    expect(mockSteerSession).toHaveBeenCalledTimes(1)
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "lark-1",
        reason: "pii_blocked",
        fields: { sourceMessageId: "om-blocked" },
      })
    )
  })

  it("does not start a second runtime when the singleton lock is already held", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow()
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(makeFakeAdapter(row.id))

    // Another window owns the runtime → this instance loses the lock.
    install({ acquireRuntimeLock: async () => false })
    await new Promise((r) => setTimeout(r, 50))

    // Nothing boots: no reap, no adapters, no outbound runner.
    expect(mockResetAllWs).not.toHaveBeenCalled()
    expect(mockListEnabled).not.toHaveBeenCalled()
    expect(mockRegisterAdapter).not.toHaveBeenCalled()
    expect(mockStartOutboundRunner).not.toHaveBeenCalled()
  })

  // ── Default Web Locks singleton guard ──────────────────────────────────────
  // A spec-faithful `navigator.locks` fake: requests queue; grants are
  // processed asynchronously (a macrotask, mirroring WKWebView's
  // cross-process lock manager — never within the requesting task);
  // `ifAvailable` resolves the callback with null unless the lock is
  // IMMEDIATELY grantable (not held AND nothing queued ahead); an aborted
  // `signal` withdraws a still-queued request with an AbortError but is a
  // no-op once the lock has been granted (per spec).
  describe("default Web Locks runtime lock", () => {
    interface FakeLockRequest {
      cb: (lock: { name: string; mode: string } | null) => unknown
      resolve: (v: unknown) => void
      reject: (e: unknown) => void
      granted: boolean
      withdrawn: boolean
    }

    class FakeLockManager {
      held: FakeLockRequest | null = null
      queue: FakeLockRequest[] = []

      request(
        name: string,
        opts: { ifAvailable?: boolean; signal?: AbortSignal },
        cb: FakeLockRequest["cb"]
      ): Promise<unknown> {
        return new Promise((resolve, reject) => {
          if (opts.signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"))
            return
          }
          if (opts.ifAvailable && (this.held !== null || this.queue.length > 0)) {
            Promise.resolve(cb(null)).then(resolve, reject)
            return
          }
          const req: FakeLockRequest = { cb, resolve, reject, granted: false, withdrawn: false }
          opts.signal?.addEventListener(
            "abort",
            () => {
              if (req.granted) return
              req.withdrawn = true
              this.queue = this.queue.filter((q) => q !== req)
              reject(new DOMException("aborted", "AbortError"))
            },
            { once: true }
          )
          this.queue.push(req)
          setTimeout(() => this.pump(), 0)
        })
      }

      private pump(): void {
        if (this.held !== null) return
        const req = this.queue.shift()
        if (!req) return
        req.granted = true
        this.held = req
        Promise.resolve(req.cb({ name: "cognia-connector-runtime", mode: "exclusive" })).then(
          (v) => {
            this.held = null
            req.resolve(v)
            setTimeout(() => this.pump(), 0)
          },
          (e) => {
            this.held = null
            req.reject(e)
            setTimeout(() => this.pump(), 0)
          }
        )
      }
    }

    beforeEach(() => {
      mockedIsTauri.mockReturnValue(true)
      const row = makeTelegramRow()
      mockListEnabled.mockResolvedValue([row])
      mockBuildAdapterFromRow.mockImplementation(async () => makeFakeAdapter(row.id))
      Object.defineProperty(globalThis.navigator, "locks", {
        value: new FakeLockManager(),
        configurable: true,
      })
    })

    afterEach(() => {
      delete (globalThis.navigator as { locks?: unknown }).locks
    })

    it("boots after a StrictMode-style remount (teardown while the first request is still queued)", async () => {
      // effect#1 → cleanup#1 → effect#2, all in the same task — exactly what
      // React StrictMode does to ConnectorBusProvider in dev. The first
      // install's lock request is still queued (grants are async) when it is
      // torn down; the remounted install must still end up booting.
      const teardown1 = install()
      teardown1()
      install()

      await waitFor(() => {
        expect(mockRegisterAdapter).toHaveBeenCalledTimes(1)
        expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1)
      })
    })

    it("does not boot a second runtime while the first still holds the lock", async () => {
      install()
      await waitFor(() => {
        expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1)
      })

      install()
      await new Promise((r) => setTimeout(r, 100))

      // Still exactly one runtime: no double adapter boot, no double runner.
      expect(mockRegisterAdapter).toHaveBeenCalledTimes(1)
      expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1)
    })

    it("lets a waiting install take over when the owner tears down", async () => {
      const teardown1 = install()
      await waitFor(() => {
        expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1)
      })

      install() // queues behind the owner
      await new Promise((r) => setTimeout(r, 50))
      expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1)

      teardown1() // owner releases → the waiter must boot

      await waitFor(() => {
        expect(mockStartOutboundRunner).toHaveBeenCalledTimes(2)
      })
    })
  })

  it("registers multiple adapters when multiple rows are enabled", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row1 = makeTelegramRow("cai_tg_1")
    const row2 = makeTelegramRow("cai_tg_2")
    const adapter1 = makeFakeAdapter(row1.id)
    const adapter2 = makeFakeAdapter(row2.id)
    mockListEnabled.mockResolvedValue([row1, row2])
    mockBuildAdapterFromRow.mockResolvedValueOnce(adapter1).mockResolvedValueOnce(adapter2)
    mockListAdapters.mockReturnValue([adapter1, adapter2])

    install()

    await waitFor(() => {
      expect(mockRegisterAdapter).toHaveBeenCalledTimes(2)
    })
    expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1)
  })

  it("skips null adapters (unsupported type) without crashing", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow()
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(null) // unsupported → null
    mockListAdapters.mockReturnValue([])

    install()

    await waitFor(() => {
      expect(mockBuildAdapterFromRow).toHaveBeenCalledTimes(1)
    })
    expect(mockRegisterAdapter).not.toHaveBeenCalled()
    // Runner still starts (with empty adapter map)
    expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1)
  })

  it("logs and bails when the adapterInstances store is missing (stale IDB)", async () => {
    mockedIsTauri.mockReturnValue(true)
    const notFound = Object.assign(new Error("store missing"), { name: "NotFoundError" })
    mockListEnabled.mockRejectedValue(notFound)
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})

    install()

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("adapterInstances"))
    })
    expect(mockInstallRuntime).not.toHaveBeenCalled()
    expect(mockRegisterAdapter).not.toHaveBeenCalled()
    expect(mockStartOutboundRunner).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  // im-refactored-crayon — `adapter.start(ctx)` lifecycle wiring.

  it("calls adapter.start(ctx) with a buildAdapterContext result", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_start_ok")
    const fakeAdapter = makeFakeAdapter(row.id)
    fakeAdapter.start.mockResolvedValue(undefined)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(fakeAdapter)
    mockListAdapters.mockReturnValue([fakeAdapter])

    install()

    await waitFor(() => {
      expect(fakeAdapter.start).toHaveBeenCalledTimes(1)
    })
    expect(mockBuildAdapterContext).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: row.id })
    )
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: row.id, kind: "adapter.started" })
    )
  })

  it("isolates per-adapter start failures so the others still boot", async () => {
    mockedIsTauri.mockReturnValue(true)
    const okRow = makeTelegramRow("cai_start_ok")
    const failRow = makeTelegramRow("cai_start_fail")
    const okAdapter = makeFakeAdapter(okRow.id)
    const failAdapter = makeFakeAdapter(failRow.id)
    okAdapter.start.mockResolvedValue(undefined)
    failAdapter.start.mockRejectedValue(new Error("transport broken"))
    mockListEnabled.mockResolvedValue([failRow, okRow])
    mockBuildAdapterFromRow.mockResolvedValueOnce(failAdapter).mockResolvedValueOnce(okAdapter)
    mockListAdapters.mockReturnValue([okAdapter])

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})

    install()

    await waitFor(() => {
      expect(failAdapter.start).toHaveBeenCalledTimes(1)
      expect(okAdapter.start).toHaveBeenCalledTimes(1)
    })

    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: failRow.id,
        kind: "adapter.error",
        reason: "start_failed",
      })
    )
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: okRow.id, kind: "adapter.started" })
    )
    expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1)
    errSpy.mockRestore()
  })

  it("calls adapter.stop() on dispose for every started adapter", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row1 = makeTelegramRow("cai_stop_1")
    const row2 = makeTelegramRow("cai_stop_2")
    const adapter1 = makeFakeAdapter(row1.id)
    const adapter2 = makeFakeAdapter(row2.id)
    adapter1.start.mockResolvedValue(undefined)
    adapter2.start.mockResolvedValue(undefined)
    adapter1.stop.mockResolvedValue(undefined)
    adapter2.stop.mockResolvedValue(undefined)
    mockListEnabled.mockResolvedValue([row1, row2])
    mockBuildAdapterFromRow.mockResolvedValueOnce(adapter1).mockResolvedValueOnce(adapter2)
    mockListAdapters.mockReturnValue([adapter1, adapter2])

    const dispose = install()
    await waitFor(() => {
      expect(adapter1.start).toHaveBeenCalledTimes(1)
      expect(adapter2.start).toHaveBeenCalledTimes(1)
    })

    dispose()
    await waitFor(() => {
      expect(adapter1.stop).toHaveBeenCalledTimes(1)
      expect(adapter2.stop).toHaveBeenCalledTimes(1)
    })
  })

  it("suspends plugin-owned adapters and resumes them on the next local acquisition", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockListEnabled.mockResolvedValue([])
    const pluginStop = jest.fn().mockResolvedValue(undefined)
    const pluginRestart = jest.fn().mockResolvedValue(undefined)
    lifecycleRegistry.set("plugin:chat", {
      adapter: { id: "plugin:chat", stop: pluginStop },
      abortController: new AbortController(),
      restart: pluginRestart,
      owner: "plugin",
    })

    const dispose = install({ acquireRuntimeLock: async () => true })
    await waitFor(() => expect(mockInstallRuntime).toHaveBeenCalled())
    dispose()

    expect(mockSuspendRunningByOwner).toHaveBeenCalledWith("plugin")
    expect(pluginStop).toHaveBeenCalledTimes(1)
    expect(lifecycleRegistry.has("plugin:chat")).toBe(false)
    expect(suspendedLifecycleRegistry.has("plugin:chat")).toBe(true)

    mockResumeSuspendedByOwner.mockClear()
    install({ acquireRuntimeLock: async () => true })
    await waitFor(() => expect(pluginRestart).toHaveBeenCalledTimes(1))
    expect(mockResumeSuspendedByOwner).toHaveBeenCalledWith("plugin")
  })

  it("does not call adapter.stop() for adapters whose start() failed", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_stop_skip")
    const adapter = makeFakeAdapter(row.id)
    adapter.start.mockRejectedValue(new Error("never started"))
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    const dispose = install()
    await waitFor(() => {
      expect(adapter.start).toHaveBeenCalledTimes(1)
    })

    dispose()
    // adapter.stop() must NOT fire — start failed, so the adapter never
    // entered the startedAdapters list.
    await new Promise((r) => setTimeout(r, 30))
    expect(adapter.stop).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it("swallows adapter.stop() rejections so teardown does not crash", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_stop_throws")
    const adapter = makeFakeAdapter(row.id)
    adapter.start.mockResolvedValue(undefined)
    adapter.stop.mockRejectedValue(new Error("stop bombed"))
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    const dispose = install()
    await waitFor(() => {
      expect(adapter.start).toHaveBeenCalledTimes(1)
    })

    expect(() => dispose()).not.toThrow()
    await waitFor(() => {
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining(`adapter ${row.id} failed to stop`)
      )
    })
    errSpy.mockRestore()
  })

  // v51 — consolidated heartbeat sweep + lifecycle registry wiring.

  it("starts a single consolidated heartbeat sweep after booting adapters", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_hb")
    const adapter = makeFakeAdapter(row.id)
    adapter.start.mockResolvedValue(undefined)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    install()
    await waitFor(() => {
      expect(mockStartHeartbeatSweep).toHaveBeenCalledTimes(1)
    })
    // Each booted adapter also gets one immediate heartbeat so the Health
    // view reflects the (re)boot without waiting a full sweep interval.
    expect(mockRecordHeartbeatNow).toHaveBeenCalledWith(adapter)
  })

  it("disposes the heartbeat sweep on dispose", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_hb_dispose")
    const adapter = makeFakeAdapter(row.id)
    adapter.start.mockResolvedValue(undefined)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    const dispose = install()
    await waitFor(() => {
      expect(mockStartHeartbeatSweep).toHaveBeenCalledTimes(1)
    })
    dispose()
    await waitFor(() => {
      expect(mockSweepDispose).toHaveBeenCalledTimes(1)
    })
  })

  it("installs the durable low-frequency housekeeping schedule", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_retention")
    const adapter = makeFakeAdapter(row.id)
    adapter.start.mockResolvedValue(undefined)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    const dispose = install()
    await waitFor(() => {
      expect(mockInstallHousekeepingSchedule).toHaveBeenCalledTimes(1)
    })
    dispose()
  })

  it("registers each successfully-started adapter in the lifecycle registry", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_reg")
    const adapter = makeFakeAdapter(row.id)
    adapter.start.mockResolvedValue(undefined)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    install()
    await waitFor(() => {
      expect(mockRegisterRunning).toHaveBeenCalledWith(row.id, expect.objectContaining({ adapter }))
    })
  })

  it("does not register adapters whose start() failed", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_reg_fail")
    const adapter = makeFakeAdapter(row.id)
    adapter.start.mockRejectedValue(new Error("nope"))
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    install()
    await waitFor(() => {
      expect(adapter.start).toHaveBeenCalledTimes(1)
    })
    expect(mockRegisterRunning).not.toHaveBeenCalled()
    // A failed start short-circuits before the register/audit/heartbeat tail.
    expect(mockRecordHeartbeatNow).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  // Reload recovery — reap Rust-side sockets leaked by a prior webview load
  // whose React cleanup never ran, BEFORE opening any fresh transport.

  it("reaps leaked WS handles before opening any adapter", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_reset")
    const adapter = makeFakeAdapter(row.id)
    adapter.start.mockResolvedValue(undefined)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    install()
    await waitFor(() => expect(adapter.start).toHaveBeenCalledTimes(1))
    expect(mockResetAllWs).toHaveBeenCalledTimes(1)
    // The reap must precede the transport start so it can't kill the fresh
    // socket this boot is about to open.
    const resetOrder = mockResetAllWs.mock.invocationCallOrder[0]
    const startOrder = adapter.start.mock.invocationCallOrder[0]
    expect(resetOrder).toBeLessThan(startOrder)
  })

  it("still boots when the WS reset fails (best-effort)", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockResetAllWs.mockRejectedValueOnce(new Error("reset bombed"))
    const row = makeTelegramRow("cai_reset_fail")
    const adapter = makeFakeAdapter(row.id)
    adapter.start.mockResolvedValue(undefined)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    install()
    await waitFor(() => expect(adapter.start).toHaveBeenCalledTimes(1))
    expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ws reset failed"))
    warnSpy.mockRestore()
  })

  // WS3 — inbound axum server lifecycle (webhook / reverse-WS transports).

  const makeWebhookAdapter = (id: string) => ({
    ...makeFakeAdapter(id),
    meta: {
      type: "lark" as const,
      displayName: "Lark",
      version: "0.1.0",
      capabilities: [],
      transportModes: ["webhook"] as const,
      configSchema: {},
    },
  })
  const makeWebhookRow = (id: string) => ({
    ...makeTelegramRow(id),
    type: "lark" as const,
    transportMode: "webhook" as const,
  })

  it("starts the inbound server once (loopback) when a webhook adapter is enabled", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeWebhookRow("cai_wh_start")
    const adapter = makeWebhookAdapter(row.id)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    install()
    await waitFor(() => expect(mockStartServer).toHaveBeenCalledTimes(1))
    expect(mockStartServer).toHaveBeenCalledWith(7842, true)
  })

  it("does not start the inbound server for outbound-only (longpoll) adapters", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_lp_nostart")
    const adapter = makeFakeAdapter(row.id) // transportModes ["longpoll"]
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    install()
    await waitFor(() => expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1))
    expect(mockStartServer).not.toHaveBeenCalled()
  })

  it("treats an 'already running' server as success (no failure audit)", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockStartServer.mockRejectedValueOnce(new Error("connectors server already running"))
    const row = makeWebhookRow("cai_wh_running")
    const adapter = makeWebhookAdapter(row.id)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    install()
    await waitFor(() => expect(mockStartServer).toHaveBeenCalledTimes(1))
    expect(mockAppendAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "server_start_failed" })
    )
  })

  it("audits server_start_failed on a real start error", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockStartServer.mockRejectedValueOnce(new Error("bind refused"))
    const row = makeWebhookRow("cai_wh_fail")
    const adapter = makeWebhookAdapter(row.id)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    install()
    await waitFor(() =>
      expect(mockAppendAudit).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "adapter.error", reason: "server_start_failed" })
      )
    )
    errSpy.mockRestore()
  })

  it("stops the inbound server on dispose", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeWebhookRow("cai_wh_stop")
    const adapter = makeWebhookAdapter(row.id)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    const dispose = install()
    await waitFor(() => expect(mockStartServer).toHaveBeenCalledTimes(1))
    dispose()
    await waitFor(() => expect(mockStopServer).toHaveBeenCalledTimes(1))
  })

  // WS4 — webhook adapters must register with the Rust axum server before
  // their transport starts, else the webhook handler 404s every inbound POST.

  it("registers a webhook adapter with the Rust server using its platform type", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeWebhookRow("cai_wh_register")
    const adapter = makeWebhookAdapter(row.id)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    install()
    await waitFor(() =>
      expect(mockRegisterAdapterCmd).toHaveBeenCalledWith({
        adapterId: row.id,
        adapterType: "lark",
      })
    )
    // Registration must precede the transport start (route resolves first).
    const registerOrder = mockRegisterAdapterCmd.mock.invocationCallOrder[0]
    const startOrder = adapter.start.mock.invocationCallOrder[0]
    expect(registerOrder).toBeLessThan(startOrder)
  })

  it("does not register outbound-only (longpoll) adapters with the Rust server", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeTelegramRow("cai_lp_noregister")
    const adapter = makeFakeAdapter(row.id) // transportModes ["longpoll"]
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    install()
    await waitFor(() => expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1))
    expect(mockRegisterAdapterCmd).not.toHaveBeenCalled()
  })

  it("unregisters webhook adapters from the Rust server on dispose", async () => {
    mockedIsTauri.mockReturnValue(true)
    const row = makeWebhookRow("cai_wh_unregister")
    const adapter = makeWebhookAdapter(row.id)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    const dispose = install()
    await waitFor(() => expect(mockRegisterAdapterCmd).toHaveBeenCalledTimes(1))
    dispose()
    await waitFor(() => expect(mockUnregisterAdapterCmd).toHaveBeenCalledWith(row.id))
  })

  it("keeps booting when webhook registration throws (best-effort)", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockRegisterAdapterCmd.mockRejectedValueOnce(new Error("register bombed"))
    const row = makeWebhookRow("cai_wh_register_fail")
    const adapter = makeWebhookAdapter(row.id)
    mockListEnabled.mockResolvedValue([row])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    install()
    // A register failure must not block the transport start or the server boot.
    await waitFor(() => expect(adapter.start).toHaveBeenCalledTimes(1))
    expect(mockStartServer).toHaveBeenCalledTimes(1)
    errSpy.mockRestore()
  })

  // Installer-only options: skipHostGate / rowFilter / log.

  it("skipHostGate boots the runtime even when isTauri() is false", async () => {
    mockedIsTauri.mockReturnValue(false)
    mockListEnabled.mockResolvedValue([])
    install({ skipHostGate: true })
    await waitFor(() => {
      expect(mockInstallRuntime).toHaveBeenCalledTimes(1)
      expect(mockStartOutboundRunner).toHaveBeenCalledTimes(1)
    })
  })

  it("rowFilter skips filtered rows and logs each skip (never silent)", async () => {
    mockedIsTauri.mockReturnValue(true)
    const webhookRow = makeWebhookRow("cai_filter_keep")
    const wsRow = { ...makeTelegramRow("cai_filter_skip"), transportMode: "gateway" as const }
    const adapter = makeWebhookAdapter(webhookRow.id)
    mockListEnabled.mockResolvedValue([webhookRow, wsRow])
    mockBuildAdapterFromRow.mockResolvedValue(adapter)
    mockListAdapters.mockReturnValue([adapter])
    const log = jest.fn()
    install({ rowFilter: (row) => row.transportMode === "webhook", log })
    await waitFor(() => expect(mockRegisterAdapter).toHaveBeenCalledTimes(1))
    // Only the webhook row was built — the gateway row never reached the loop.
    expect(mockBuildAdapterFromRow).toHaveBeenCalledTimes(1)
    expect(mockBuildAdapterFromRow).toHaveBeenCalledWith(webhookRow)
    expect(log).toHaveBeenCalledWith("info", expect.stringContaining("cai_filter_skip"))
    expect(log).toHaveBeenCalledWith("info", expect.stringContaining("skipped by host filter"))
  })

  it("routes boot logs through the injected log sink instead of the console", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockResetAllWs.mockRejectedValueOnce(new Error("reset bombed"))
    mockListEnabled.mockResolvedValue([])
    const log = jest.fn()
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    install({ log })
    await waitFor(() =>
      expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("ws reset failed"))
    )
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it("reports a detached bootstrap failure through the log sink", async () => {
    mockedIsTauri.mockReturnValue(true)
    const log = jest.fn()
    install({
      log,
      acquireRuntimeLock: async () => {
        throw new Error("lock failed")
      },
    })
    await waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("runtime bootstrap failed: lock failed")
      )
    )
  })

  describe("hot-reconciles the enabled-adapter set (no restart)", () => {
    // Drive the runtime with an injected adapter-change watcher so a test can
    // fire "the adapterInstances table changed" on demand, then assert the
    // installer reconciles the enabled set into the running set.
    const installWithWatch = async (
      initialRows: ReturnType<typeof makeTelegramRow>[],
      extraOpts: Parameters<typeof install>[0] = {}
    ) => {
      mockedIsTauri.mockReturnValue(true)
      mockListEnabled.mockResolvedValue(initialRows)
      mockBuildAdapterFromRow.mockImplementation(async (row: { id: string }) =>
        makeFakeAdapter(row.id)
      )
      let captured: (() => void) | null = null
      const unsub = jest.fn()
      install({
        ...extraOpts,
        subscribeAdapterChanges: (cb) => {
          captured = cb
          return unsub
        },
      })
      // The watcher is wired at the tail of the async boot, so waiting for it
      // also guarantees the initial rows finished booting.
      await waitFor(() => expect(captured).not.toBeNull())
      return { fire: () => captured!(), unsub }
    }

    it("registers + boots a newly enabled adapter without a restart", async () => {
      const rowA = makeTelegramRow("cai_A")
      const { fire } = await installWithWatch([rowA])
      await waitFor(() =>
        expect(mockRegisterAdapter).toHaveBeenCalledWith(expect.objectContaining({ id: "cai_A" }))
      )
      mockRegisterAdapter.mockClear()

      // A new bot appears in the enabled set after boot.
      const rowB = makeTelegramRow("cai_B")
      mockListEnabled.mockResolvedValue([rowA, rowB])
      fire()

      await waitFor(() => {
        expect(mockRegisterAdapter).toHaveBeenCalledWith(expect.objectContaining({ id: "cai_B" }))
        expect(mockRegisterRunning).toHaveBeenCalledWith("cai_B", expect.anything())
      })
      // The already-running adapter is NOT re-registered (no churn).
      expect(mockRegisterAdapter).not.toHaveBeenCalledWith(expect.objectContaining({ id: "cai_A" }))
    })

    it("stops + unregisters an adapter that was disabled/deleted", async () => {
      const rowA = makeTelegramRow("cai_A")
      const rowB = makeTelegramRow("cai_B")
      const { fire } = await installWithWatch([rowA, rowB])
      await waitFor(() =>
        expect(mockRegisterRunning).toHaveBeenCalledWith("cai_B", expect.anything())
      )

      // cai_B is disabled — it drops out of the enabled set.
      mockListEnabled.mockResolvedValue([rowA])
      fire()

      await waitFor(() => {
        expect(mockUnregisterRunning).toHaveBeenCalledWith("cai_B")
        expect(mockUnregisterAdapterBus).toHaveBeenCalledWith("cai_B")
      })
      // The still-enabled adapter is left untouched.
      expect(mockUnregisterRunning).not.toHaveBeenCalledWith("cai_A")
    })

    it("does not hot-remove lifecycle entries owned by connector plugins", async () => {
      const rowA = makeTelegramRow("cai_A")
      const { fire } = await installWithWatch([rowA])
      await waitFor(() =>
        expect(mockRegisterRunning).toHaveBeenCalledWith("cai_A", expect.anything())
      )
      lifecycleRegistry.set("plugin:chat", {
        adapter: {
          id: "plugin:chat",
          stop: jest.fn().mockResolvedValue(undefined),
        },
        abortController: new AbortController(),
        restart: jest.fn().mockResolvedValue(undefined),
        owner: "plugin",
      })
      mockUnregisterRunning.mockClear()
      mockUnregisterAdapterBus.mockClear()

      fire()
      await new Promise((resolve) => setTimeout(resolve, 30))

      expect(mockUnregisterRunning).not.toHaveBeenCalledWith("plugin:chat")
      expect(mockUnregisterAdapterBus).not.toHaveBeenCalledWith("plugin:chat")
    })

    it("is a no-op when the enabled set is unchanged (no churn)", async () => {
      const rowA = makeTelegramRow("cai_A")
      const { fire } = await installWithWatch([rowA])
      await waitFor(() =>
        expect(mockRegisterRunning).toHaveBeenCalledWith("cai_A", expect.anything())
      )
      mockRegisterAdapter.mockClear()
      mockBuildAdapterFromRow.mockClear()

      // Same enabled set (e.g. a presence/capability row write re-fired it).
      fire()
      await new Promise((r) => setTimeout(r, 30))

      expect(mockRegisterAdapter).not.toHaveBeenCalled()
      expect(mockBuildAdapterFromRow).not.toHaveBeenCalled()
      expect(mockUnregisterRunning).not.toHaveBeenCalled()
    })

    it("hot-adds a webhook adapter (Rust register + inbound server), reaps it on disable", async () => {
      const rowA = makeTelegramRow("cai_A")
      const { fire } = await installWithWatch([rowA])
      await waitFor(() =>
        expect(mockRegisterRunning).toHaveBeenCalledWith("cai_A", expect.anything())
      )

      const hook = makeWebhookRow("cai_hook")
      mockBuildAdapterFromRow.mockImplementation(
        async (row: { transportMode?: string; id: string }) =>
          row.transportMode === "webhook" ? makeWebhookAdapter(row.id) : makeFakeAdapter(row.id)
      )
      mockListEnabled.mockResolvedValue([rowA, hook])
      fire()
      await waitFor(() => {
        expect(mockRegisterAdapterCmd).toHaveBeenCalledWith({
          adapterId: "cai_hook",
          adapterType: "lark",
        })
        expect(mockStartServer).toHaveBeenCalled()
      })

      // Disable it → hot-remove reaps the Rust webhook registration too.
      mockListEnabled.mockResolvedValue([rowA])
      fire()
      await waitFor(() => {
        expect(mockUnregisterRunning).toHaveBeenCalledWith("cai_hook")
        expect(mockUnregisterAdapterCmd).toHaveBeenCalledWith("cai_hook")
      })
    })

    it("skips a hot-add when buildAdapterFromRow returns null", async () => {
      const rowA = makeTelegramRow("cai_A")
      const { fire } = await installWithWatch([rowA])
      await waitFor(() =>
        expect(mockRegisterRunning).toHaveBeenCalledWith("cai_A", expect.anything())
      )
      mockRegisterAdapter.mockClear()

      const rowB = makeTelegramRow("cai_B")
      mockBuildAdapterFromRow.mockImplementation(async (row: { id: string }) =>
        row.id === "cai_B" ? null : makeFakeAdapter(row.id)
      )
      mockListEnabled.mockResolvedValue([rowA, rowB])
      fire()
      await new Promise((r) => setTimeout(r, 30))
      expect(mockRegisterAdapter).not.toHaveBeenCalledWith(expect.objectContaining({ id: "cai_B" }))
    })

    it("logs and keeps going when buildAdapterFromRow throws during hot-add", async () => {
      const rowA = makeTelegramRow("cai_A")
      const log = jest.fn()
      const { fire } = await installWithWatch([rowA], { log })
      await waitFor(() =>
        expect(mockRegisterRunning).toHaveBeenCalledWith("cai_A", expect.anything())
      )

      const rowB = makeTelegramRow("cai_B")
      mockBuildAdapterFromRow.mockImplementation(async (row: { id: string }) => {
        if (row.id === "cai_B") throw new Error("build boom")
        return makeFakeAdapter(row.id)
      })
      mockListEnabled.mockResolvedValue([rowA, rowB])
      fire()
      await waitFor(() =>
        expect(log).toHaveBeenCalledWith(
          "error",
          expect.stringContaining("hot-enable of adapter cai_B failed")
        )
      )
    })

    it("swallows a read error during reconcile (no crash, no churn)", async () => {
      const rowA = makeTelegramRow("cai_A")
      const { fire } = await installWithWatch([rowA])
      await waitFor(() =>
        expect(mockRegisterRunning).toHaveBeenCalledWith("cai_A", expect.anything())
      )
      mockRegisterAdapter.mockClear()

      mockListEnabled.mockRejectedValueOnce(new Error("db read boom"))
      fire()
      await new Promise((r) => setTimeout(r, 30))
      expect(mockRegisterAdapter).not.toHaveBeenCalled()
      expect(mockUnregisterRunning).not.toHaveBeenCalled()
    })

    it("logs when the inbound server fails to start after a webhook hot-add", async () => {
      const rowA = makeTelegramRow("cai_A")
      const log = jest.fn()
      const { fire } = await installWithWatch([rowA], { log })
      await waitFor(() =>
        expect(mockRegisterRunning).toHaveBeenCalledWith("cai_A", expect.anything())
      )

      mockStartServer.mockRejectedValueOnce(new Error("port in use"))
      const hook = makeWebhookRow("cai_hook")
      mockBuildAdapterFromRow.mockImplementation(
        async (row: { transportMode?: string; id: string }) =>
          row.transportMode === "webhook" ? makeWebhookAdapter(row.id) : makeFakeAdapter(row.id)
      )
      mockListEnabled.mockResolvedValue([rowA, hook])
      fire()
      await waitFor(() =>
        expect(log).toHaveBeenCalledWith(
          "error",
          expect.stringContaining("inbound server failed to start after hot-enable")
        )
      )
    })

    it("serializes overlapping reconciles so an adapter is not double-booted", async () => {
      const rowA = makeTelegramRow("cai_A")
      const { fire } = await installWithWatch([rowA])
      await waitFor(() =>
        expect(mockRegisterRunning).toHaveBeenCalledWith("cai_A", expect.anything())
      )

      // Gate the cai_B build so a second fire() lands while reconcile #1 is
      // still in-flight — exercising the reconcileRunning → pending re-run path.
      const rowB = makeTelegramRow("cai_B")
      let releaseBuild: () => void = () => {}
      const buildGate = new Promise<void>((r) => {
        releaseBuild = r
      })
      mockBuildAdapterFromRow.mockImplementation(async (row: { id: string }) => {
        if (row.id === "cai_B") await buildGate
        return makeFakeAdapter(row.id)
      })
      mockListEnabled.mockResolvedValue([rowA, rowB])

      fire() // reconcile #1 starts, parks on the cai_B build
      await new Promise((r) => setTimeout(r, 10))
      fire() // reconcile #2 requested mid-flight → queued, not run concurrently
      releaseBuild() // let #1 finish → the queued #2 runs

      await waitFor(() =>
        expect(mockRegisterRunning).toHaveBeenCalledWith("cai_B", expect.anything())
      )
      // Booted exactly once despite two overlapping fires.
      const bBoots = mockRegisterRunning.mock.calls.filter((c) => c[0] === "cai_B")
      expect(bBoots).toHaveLength(1)
    })

    it("still boots a hot-added adapter when the capability refresh write fails", async () => {
      const rowA = makeTelegramRow("cai_A")
      const { fire } = await installWithWatch([rowA])
      await waitFor(() =>
        expect(mockRegisterRunning).toHaveBeenCalledWith("cai_A", expect.anything())
      )

      mockAdapterInstancesUpdate.mockRejectedValueOnce(new Error("update boom"))
      const rowB = makeTelegramRow("cai_B")
      mockListEnabled.mockResolvedValue([rowA, rowB])
      fire()
      // The best-effort capability write threw, but boot proceeds regardless.
      await waitFor(() =>
        expect(mockRegisterRunning).toHaveBeenCalledWith("cai_B", expect.anything())
      )
    })

    it("unsubscribes the watcher on teardown", async () => {
      const rowA = makeTelegramRow("cai_A")
      const { unsub } = await installWithWatch([rowA])
      expect(unsub).not.toHaveBeenCalled()
      for (const dispose of disposers.splice(0)) dispose()
      expect(unsub).toHaveBeenCalledTimes(1)
    })
  })
})
