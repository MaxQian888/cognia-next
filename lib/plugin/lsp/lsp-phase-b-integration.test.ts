/**
 * Phase B end-to-end integration test (~/.claude/plans/vscode-lsp-mighty-robin.md).
 *
 * Composes every renderer-side piece of the standalone-LSP pathway in
 * one test so we catch regressions across the seam between
 * `lsp-user-servers` → `lsp-registry` → injected client adapter →
 * `monaco-bridge.setDiagnostics`. The LSP binary policy is mocked at
 * the module boundary so the test never touches Dexie or the real
 * settings store.
 *
 * Skipped scenarios (covered elsewhere — see the plan):
 *   - Real subprocess spawn (verified in
 *     `sidecar/vscode-ext-host/tests/lsp-client.test.mjs`).
 *   - Tauri-side capability gates (verified manually per the plan's
 *     verification section + the Playwright spec in
 *     `tests/e2e/lsp/vscode-eslint.spec.ts`).
 */

const evaluateLspBinaryMock = jest.fn(async (_input: unknown) => ({
  allowed: true,
  requiresPrompt: false,
  reason: "test-policy-allow",
}))
jest.mock("@/lib/plugin/vscode-shim/lsp-binary-policy", () => ({
  evaluateLspBinary: (input: unknown) => evaluateLspBinaryMock(input),
}))

import {
  __resetLspRegistryForTesting,
  configureLspRegistry,
  listLspServers,
  type LspBridgeAdapter,
  type LspClientAdapter,
} from "./lsp-registry"
import { syncUserLspServers } from "./lsp-user-servers"
import type { UserLspServerEntry } from "@cognia/agent-config-types"

interface BridgeCall {
  extensionId: string
  uri: string
  markersCount: number
  firstSeverity?: string
}

function buildAdapters(): {
  client: LspClientAdapter
  bridge: LspBridgeAdapter
  bridgeCalls: BridgeCall[]
  diagnosticFans: Map<string, (uri: string, markers: unknown[]) => void>
  startCalls: string[]
  stopCalls: string[]
} {
  const bridgeCalls: BridgeCall[] = []
  const diagnosticFans = new Map<string, (uri: string, markers: unknown[]) => void>()
  const startCalls: string[] = []
  const stopCalls: string[] = []
  const client: LspClientAdapter = {
    async start(input) {
      startCalls.push(`${input.ownerId}:${input.serverId}`)
      diagnosticFans.set(`${input.ownerId}:${input.serverId}`, (uri, markers) =>
        input.onDiagnostics(uri, markers as never)
      )
    },
    async stop(ownerId, serverId) {
      stopCalls.push(`${ownerId}:${serverId}`)
      diagnosticFans.delete(`${ownerId}:${serverId}`)
    },
  }
  const bridge: LspBridgeAdapter = {
    setDiagnostics(input) {
      bridgeCalls.push({
        extensionId: input.extensionId,
        uri: input.uri,
        markersCount: input.markers.length,
        firstSeverity: input.markers[0]?.severity,
      })
    },
  }
  return { client, bridge, bridgeCalls, diagnosticFans, startCalls, stopCalls }
}

beforeEach(() => {
  __resetLspRegistryForTesting()
  evaluateLspBinaryMock.mockClear()
  evaluateLspBinaryMock.mockResolvedValue({
    allowed: true,
    requiresPrompt: false,
    reason: "test-policy-allow",
  })
})

describe("Phase B integration", () => {
  it("settings → syncUserLspServers → registry → start path lights up diagnostics on a Monaco surface", async () => {
    const a = buildAdapters()
    configureLspRegistry({
      client: a.client,
      bridge: a.bridge,
      resolveWorkspaceFolders: () => [{ uri: "file:///tmp/w", name: "w" }],
      now: () => 1,
    })

    const userSettings: UserLspServerEntry[] = [
      {
        id: "eslint",
        name: "ESLint",
        languages: ["typescript"],
        command: "/usr/local/bin/eslint-server",
        enabled: true,
      },
    ]

    const syncResult = await syncUserLspServers(userSettings)
    expect(syncResult).toEqual({ added: 1, removed: 0, skipped: 0 })
    expect(a.startCalls).toEqual(["user:eslint"])

    // The mock LSP client doesn't actually spawn a process, but the
    // registry exposes the diagnostic fan-out — simulate the server
    // pushing a publishDiagnostics frame.
    const fan = a.diagnosticFans.get("user:eslint")!
    fan("file:///skill-A/main.ts", [
      {
        severity: "error",
        message: "Unexpected redeclaration",
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 },
        source: "eslint",
      },
    ])

    expect(a.bridgeCalls).toHaveLength(1)
    expect(a.bridgeCalls[0]).toEqual({
      extensionId: "user:eslint",
      uri: "file:///skill-A/main.ts",
      markersCount: 1,
      firstSeverity: "error",
    })
  })

  it("toggling `enabled: false` tears down the running server on next sync", async () => {
    const a = buildAdapters()
    configureLspRegistry({
      client: a.client,
      bridge: a.bridge,
      resolveWorkspaceFolders: () => [],
      now: () => 1,
    })

    const entry: UserLspServerEntry = {
      id: "eslint",
      name: "ESLint",
      languages: ["typescript"],
      command: "/x",
      enabled: true,
    }
    await syncUserLspServers([entry])
    expect(a.startCalls).toEqual(["user:eslint"])

    // Flip to disabled and re-sync.
    await syncUserLspServers([{ ...entry, enabled: false }])
    expect(a.stopCalls).toEqual(["user:eslint"])
    expect(listLspServers()).toHaveLength(0)
  })

  it("policy denial surfaces consentReason; the bridge sees no diagnostics until consent is confirmed", async () => {
    const a = buildAdapters()
    // syncUserLspServers always passes confirmedConsent=true, so we
    // assert the plugin-path behaviour separately by calling the
    // registry directly with the default consent flow.
    evaluateLspBinaryMock.mockResolvedValue({
      allowed: false,
      requiresPrompt: true,
      reason: "no recorded user approval for this binary",
    })
    configureLspRegistry({
      client: a.client,
      bridge: a.bridge,
      resolveWorkspaceFolders: () => [],
      now: () => 1,
    })
    const { registerLspServer } = await import("./lsp-registry")
    const rec = await registerLspServer({
      ownerId: "publisher.ext",
      config: {
        id: "rust-analyzer",
        name: "rust-analyzer",
        languages: ["rust"],
        command: "rust-analyzer",
      },
      pluginPath: "/plugins/publisher.ext",
    })
    expect(rec.state).toBe("stopped")
    expect(rec.consentReason).toMatch(/no recorded user approval/i)
    expect(a.startCalls).toHaveLength(0)
  })

  it("policy denial -> user consent -> registerLspServer with confirmedConsent: true succeeds", async () => {
    const a = buildAdapters()
    evaluateLspBinaryMock.mockResolvedValue({
      allowed: false,
      requiresPrompt: true,
      reason: "no recorded user approval for this binary",
    })
    configureLspRegistry({
      client: a.client,
      bridge: a.bridge,
      resolveWorkspaceFolders: () => [],
      now: () => 1,
    })
    const { registerLspServer, unregisterLspServer } = await import("./lsp-registry")
    // First call — pending consent.
    const denied = await registerLspServer({
      ownerId: "publisher.ext",
      config: {
        id: "rust-analyzer",
        name: "rust-analyzer",
        languages: ["rust"],
        command: "rust-analyzer",
      },
      pluginPath: "/plugins/publisher.ext",
    })
    expect(denied.state).toBe("stopped")
    // The UI now offers consent; remove the pending record and retry
    // with `confirmedConsent: true`.
    await unregisterLspServer("publisher.ext", "rust-analyzer")
    const confirmed = await registerLspServer({
      ownerId: "publisher.ext",
      config: {
        id: "rust-analyzer",
        name: "rust-analyzer",
        languages: ["rust"],
        command: "rust-analyzer",
      },
      pluginPath: "/plugins/publisher.ext",
      confirmedConsent: true,
    })
    expect(confirmed.state).toBe("running")
    expect(a.startCalls).toEqual(["publisher.ext:rust-analyzer"])
  })

  it("a plugin contributing two LSPs adds both records; disable removes both via unregisterByOwner", async () => {
    const a = buildAdapters()
    configureLspRegistry({
      client: a.client,
      bridge: a.bridge,
      resolveWorkspaceFolders: () => [],
      now: () => 1,
    })
    const { registerPluginLspServers, unregisterByOwner } = await import("./lsp-registry")
    await registerPluginLspServers({
      pluginId: "pub.lsp-pack",
      pluginPath: "/plugins/pub.lsp-pack",
      servers: [
        {
          id: "ts",
          name: "TypeScript LSP",
          languages: ["typescript"],
          command: "node_modules/.bin/ts-lsp",
        },
        {
          id: "py",
          name: "Pyright",
          languages: ["python"],
          command: "node_modules/.bin/pyright",
        },
      ],
    })
    expect(a.startCalls.sort()).toEqual(["pub.lsp-pack:py", "pub.lsp-pack:ts"])
    const removed = await unregisterByOwner("pub.lsp-pack")
    expect(removed).toBe(2)
    expect(a.stopCalls.sort()).toEqual(["pub.lsp-pack:py", "pub.lsp-pack:ts"])
    expect(listLspServers()).toHaveLength(0)
  })

  it("plugin-contributed + user-managed servers coexist under separate ownerIds", async () => {
    const a = buildAdapters()
    configureLspRegistry({
      client: a.client,
      bridge: a.bridge,
      resolveWorkspaceFolders: () => [],
      now: () => 1,
    })
    const { registerPluginLspServers } = await import("./lsp-registry")
    await registerPluginLspServers({
      pluginId: "pub.lsp",
      pluginPath: "/plugins/pub.lsp",
      servers: [{ id: "ts", name: "TS", languages: ["typescript"], command: "ts-server" }],
    })
    await syncUserLspServers([
      {
        id: "pyright",
        name: "Pyright",
        languages: ["python"],
        command: "/x/pyright",
        enabled: true,
      },
    ])
    const records = listLspServers()
    expect(records).toHaveLength(2)
    expect(records.map((r) => r.ownerId).sort()).toEqual(["pub.lsp", "user"])
  })
})
