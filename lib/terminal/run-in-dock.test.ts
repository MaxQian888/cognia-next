/**
 * @jest-environment jsdom
 */

// jest.mock factories are hoisted, so the broker singleton must be
// instantiated lazily inside the factory rather than captured from the
// outer scope (which would still be `undefined` at hoist time).
jest.mock("@/lib/plugin/security/consent-broker", () => {
  const actual = jest.requireActual("@/lib/plugin/security/consent-broker")
  let cached: import("@/lib/plugin/security/consent-broker").PluginConsentBroker | null = null
  return {
    ...actual,
    getPluginConsentBroker: () => {
      if (!cached) cached = new actual.PluginConsentBroker()
      return cached
    },
    __getTestBroker: () => cached,
    __setTestBroker: (b: unknown) => {
      cached = b as never
    },
  }
})

// Mock spawn-orchestrator so we can test newTab path without invoking
// Tauri spawn.
jest.mock("./spawn-orchestrator", () => ({
  spawnFromDock: jest.fn(async () => ({
    kind: "spawned" as const,
    sessionId: "spawned-1",
    shell: "/bin/bash",
  })),
}))

import {
  getPluginConsentBroker,
  resetPluginConsentBroker,
} from "@/lib/plugin/security/consent-broker"
import { runInDockTab } from "./run-in-dock"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { __clearLiveSessionsForTesting, registerLiveSession } from "./session-registry"
import { agentTrustPluginId } from "./agent-trust"

function broker() {
  return getPluginConsentBroker()
}
function grantTrust(chatId: string, tabId: string) {
  ;(broker() as unknown as { sessionGrants: Set<string> }).sessionGrants.add(
    `${agentTrustPluginId(chatId, tabId)}:terminal:write`
  )
}

function makeFakeSession(sid: string) {
  const integrationListeners: Array<(event: unknown) => void> = []
  return {
    id: sid,
    info: {
      id: sid,
      projectId: null,
      extensionId: null,
      origin: "local" as const,
      shell: "/bin/bash",
    },
    write: jest.fn(async () => undefined),
    resize: jest.fn(async () => undefined),
    kill: jest.fn(async () => undefined),
    onData: jest.fn(() => () => undefined),
    onIntegration: jest.fn((cb: (event: unknown) => void) => {
      integrationListeners.push(cb)
      return () => {
        const idx = integrationListeners.indexOf(cb)
        if (idx >= 0) integrationListeners.splice(idx, 1)
      }
    }),
    onExit: jest.fn(() => () => undefined),
    _fireIntegration: (event: unknown) => {
      for (const l of integrationListeners.slice()) l(event)
    },
    isExited: false,
    lastExitCode: null,
  }
}

beforeEach(() => {
  resetPluginConsentBroker()
  broker().clearAllSessionGrants()
  broker().rejectAllPending()
  __clearLiveSessionsForTesting()
  useTerminalStore.getState().reset()
})

describe("runInDockTab", () => {
  it("returns denied when the user rejects consent", async () => {
    const fake = makeFakeSession("s-1")
    registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
    useTerminalStore.getState().registerSession(fake.info)
    const pending = runInDockTab({ chatSessionId: "c", tabId: "s-1", command: "ls" })
    // The broker emits a request — find the latest by counting pending.
    // Drive a reject via the broker singleton's pending map.
    // Since we don't have a handle to the requestId, we use the broker's
    // emit override pattern by listening on window. Simpler: simulate
    // the auto-reject by overriding the broker's emit + capturing the
    // requestId. Cleanest path: respond with allow=false to all pending.
    await Promise.resolve()
    const internal = broker() as unknown as {
      pending: Map<string, { resolve: (v: boolean) => void }>
    }
    for (const [id] of internal.pending) broker().respond(id, { allow: false, persist: false })
    await expect(pending).resolves.toEqual({ kind: "denied" })
  })

  it("returns ok with exit code on command_end after grant", async () => {
    const fake = makeFakeSession("s-1")
    registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
    useTerminalStore.getState().registerSession(fake.info)
    // Pre-grant trust so the consent emit short-circuits.
    grantTrust("c", "s-1")
    const pending = runInDockTab({
      chatSessionId: "c",
      tabId: "s-1",
      command: "ls",
      timeoutMs: 1000,
    })
    // Allow microtasks to run so the session.write call is queued + onIntegration is attached.
    await new Promise((r) => setTimeout(r, 0))
    // Simulate spawn-orchestrator pushing the captured command.
    useTerminalStore.getState().pushCommand("s-1", { cmd: "ls", exitCode: 0, endedAt: Date.now() })
    fake._fireIntegration({ kind: "command_end", exit_code: 0 })
    const result = await pending
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(result.exitCode).toBe(0)
      expect(result.sessionId).toBe("s-1")
    }
    expect(fake.write).toHaveBeenCalledWith("ls\r")
  })

  it("returns timeout when command_end never fires", async () => {
    const fake = makeFakeSession("s-1")
    registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
    useTerminalStore.getState().registerSession(fake.info)
    // Pre-grant trust to skip prompt.
    grantTrust("c", "s-1")
    const pending = runInDockTab({
      chatSessionId: "c",
      tabId: "s-1",
      command: "sleep 9999",
      timeoutMs: 25,
    })
    const result = await pending
    expect(result.kind).toBe("timeout")
    if (result.kind === "timeout") expect(result.sessionId).toBe("s-1")
  })

  it("returns error when the tab id is unknown", async () => {
    const result = await runInDockTab({ chatSessionId: "c", tabId: "ghost", command: "ls" })
    expect(result.kind).toBe("error")
  })

  it("flips agentTrusted on the store row when grant is honored", async () => {
    const fake = makeFakeSession("s-1")
    registerLiveSession(fake as unknown as Parameters<typeof registerLiveSession>[0])
    useTerminalStore.getState().registerSession(fake.info)
    grantTrust("c", "s-1")
    const pending = runInDockTab({
      chatSessionId: "c",
      tabId: "s-1",
      command: "ls",
      timeoutMs: 100,
    })
    await new Promise((r) => setTimeout(r, 0))
    fake._fireIntegration({ kind: "command_end", exit_code: 0 })
    await pending
    expect(useTerminalStore.getState().sessions["s-1"]?.agentTrusted).toBe(true)
  })
})
