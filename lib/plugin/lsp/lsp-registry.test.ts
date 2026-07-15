/**
 * Tests for `lsp-registry`. The binary policy is mocked so the tests
 * are deterministic; the bridge + client adapters are fakes that record
 * every call for assertion.
 */

const evaluateLspBinaryMock = jest.fn(async (_input: unknown) => ({
  allowed: true,
  requiresPrompt: false,
  reason: "ok",
}))
jest.mock("@/lib/plugin/vscode-shim/lsp-binary-policy", () => ({
  evaluateLspBinary: (input: unknown) => evaluateLspBinaryMock(input),
}))

import {
  __resetLspRegistryForTesting,
  __testing,
  configureLspRegistry,
  getLspServerForLanguage,
  listLspServers,
  lspServerKey,
  registerLspServer,
  registerPluginLspServers,
  unregisterByOwner,
  unregisterLspServer,
  type LspBridgeAdapter,
  type LspClientAdapter,
} from "./lsp-registry"
import type { PluginLspServerDef } from "@/types/plugin"

function makeFakeAdapters(): {
  client: LspClientAdapter & {
    started: Array<{ ownerId: string; serverId: string; foldersCount: number }>
    stopped: Array<{ ownerId: string; serverId: string }>
    onDiagnosticsHandles: Map<string, (uri: string, markers: unknown[]) => void>
  }
  bridge: LspBridgeAdapter & {
    diagnosticsCalls: Array<{ extensionId: string; uri: string; markersCount: number }>
  }
} {
  const onDiagnosticsHandles = new Map<string, (uri: string, markers: unknown[]) => void>()
  const started: Array<{ ownerId: string; serverId: string; foldersCount: number }> = []
  const stopped: Array<{ ownerId: string; serverId: string }> = []
  const diagnosticsCalls: Array<{ extensionId: string; uri: string; markersCount: number }> = []

  const client: LspClientAdapter & typeof started extends never
    ? never
    : LspClientAdapter & {
        started: typeof started
        stopped: typeof stopped
        onDiagnosticsHandles: typeof onDiagnosticsHandles
      } = {
    started,
    stopped,
    onDiagnosticsHandles,
    async start(input) {
      started.push({
        ownerId: input.ownerId,
        serverId: input.serverId,
        foldersCount: input.workspaceFolders?.length ?? 0,
      })
      onDiagnosticsHandles.set(`${input.ownerId}:${input.serverId}`, (uri, markers) =>
        input.onDiagnostics(uri, markers as never)
      )
    },
    async stop(ownerId, serverId) {
      stopped.push({ ownerId, serverId })
      onDiagnosticsHandles.delete(`${ownerId}:${serverId}`)
    },
  }

  const bridge: LspBridgeAdapter & { diagnosticsCalls: typeof diagnosticsCalls } = {
    diagnosticsCalls,
    setDiagnostics(input) {
      diagnosticsCalls.push({
        extensionId: input.extensionId,
        uri: input.uri,
        markersCount: input.markers.length,
      })
    },
  }

  return { client, bridge }
}

function makeServer(overrides: Partial<PluginLspServerDef> = {}): PluginLspServerDef {
  return {
    id: "eslint",
    name: "ESLint LSP",
    languages: ["typescript", "javascript"],
    command: "node_modules/.bin/eslint-server",
    args: ["--stdio"],
    transport: "stdio",
    workspaceFolderRequired: false,
    ...overrides,
  }
}

beforeEach(() => {
  __resetLspRegistryForTesting()
  evaluateLspBinaryMock.mockReset()
  evaluateLspBinaryMock.mockResolvedValue({
    allowed: true,
    requiresPrompt: false,
    reason: "ok",
  })
})

describe("lsp-registry", () => {
  describe("configureLspRegistry", () => {
    it("throws when any op runs before configureLspRegistry", async () => {
      await expect(
        registerLspServer({
          ownerId: "p",
          config: makeServer(),
          pluginPath: "/plugins/p",
        })
      ).rejects.toThrow(/configureLspRegistry must be called/i)
    })
  })

  describe("registerLspServer", () => {
    it("evaluates the binary policy, starts the client, and reports running", async () => {
      const { client, bridge } = makeFakeAdapters()
      configureLspRegistry({
        client,
        bridge,
        resolveWorkspaceFolders: () => [{ uri: "file:///tmp/w", name: "w" }],
        now: () => 12345,
      })

      const record = await registerLspServer({
        ownerId: "publisher.eslint",
        config: makeServer(),
        pluginPath: "/plugins/publisher.eslint",
      })

      expect(record.state).toBe("running")
      expect(record.startedAt).toBe(12345)
      expect(client.started).toHaveLength(1)
      expect(client.started[0]).toEqual({
        ownerId: "publisher.eslint",
        serverId: "eslint",
        foldersCount: 1,
      })
      expect(evaluateLspBinaryMock).toHaveBeenCalled()
      const policyArg = evaluateLspBinaryMock.mock.calls[0][0] as {
        binaryPath: string
        pluginPath: string
      }
      // The relative `command` resolved against the plugin install path.
      expect(policyArg.binaryPath).toBe("/plugins/publisher.eslint/node_modules/.bin/eslint-server")
      // v109: the registry hands the policy only facts it can verify itself —
      // never a publisher identity the plugin asserted about itself.
      expect(policyArg).toEqual({
        pluginId: "publisher.eslint",
        binaryPath: "/plugins/publisher.eslint/node_modules/.bin/eslint-server",
        pluginPath: "/plugins/publisher.eslint",
      })
    })

    it("absolute command paths are passed through to the policy unchanged", async () => {
      const { client, bridge } = makeFakeAdapters()
      configureLspRegistry({
        client,
        bridge,
        resolveWorkspaceFolders: () => [],
        now: () => 0,
      })
      await registerLspServer({
        ownerId: "p",
        config: makeServer({ command: "/usr/local/bin/rust-analyzer" }),
        pluginPath: "/plugins/p",
      })
      const policyArg = evaluateLspBinaryMock.mock.calls[0][0] as { binaryPath: string }
      expect(policyArg.binaryPath).toBe("/usr/local/bin/rust-analyzer")
    })

    it("Windows-style absolute paths are passed through unchanged", () => {
      expect(__testing.resolveBinaryPath("C:\\bin\\server.exe", "/plugins/p")).toBe(
        "C:\\bin\\server.exe"
      )
    })

    it("stores consentReason and skips client.start() when policy denies", async () => {
      const { client, bridge } = makeFakeAdapters()
      evaluateLspBinaryMock.mockResolvedValue({
        allowed: false,
        requiresPrompt: true,
        reason: "untrusted publisher",
      })
      configureLspRegistry({
        client,
        bridge,
        resolveWorkspaceFolders: () => [],
        now: () => 0,
      })
      const record = await registerLspServer({
        ownerId: "p",
        config: makeServer(),
        pluginPath: "/plugins/p",
      })
      expect(record.state).toBe("stopped")
      expect(record.consentReason).toBe("untrusted publisher")
      expect(client.started).toHaveLength(0)
    })

    it("confirmedConsent bypasses the policy gate", async () => {
      const { client, bridge } = makeFakeAdapters()
      // Even if the policy would deny, the registry should still spawn.
      evaluateLspBinaryMock.mockResolvedValue({
        allowed: false,
        requiresPrompt: true,
        reason: "untrusted publisher",
      })
      configureLspRegistry({
        client,
        bridge,
        resolveWorkspaceFolders: () => [],
        now: () => 1,
      })
      const record = await registerLspServer({
        ownerId: "p",
        config: makeServer(),
        pluginPath: "/plugins/p",
        confirmedConsent: true,
      })
      expect(record.state).toBe("running")
      expect(client.started).toHaveLength(1)
      expect(evaluateLspBinaryMock).not.toHaveBeenCalled()
    })

    it("crashes the record + records lastError when client.start throws", async () => {
      const { client, bridge } = makeFakeAdapters()
      client.start = async () => {
        throw new Error("spawn failed: ENOENT")
      }
      configureLspRegistry({
        client,
        bridge,
        resolveWorkspaceFolders: () => [],
        now: () => 0,
      })
      const record = await registerLspServer({
        ownerId: "p",
        config: makeServer(),
        pluginPath: "/plugins/p",
      })
      expect(record.state).toBe("crashed")
      expect(record.lastError).toMatch(/spawn failed: ENOENT/)
    })

    it("crashes the record when the policy throws", async () => {
      const { client, bridge } = makeFakeAdapters()
      evaluateLspBinaryMock.mockRejectedValue(new Error("ledger db unavailable"))
      configureLspRegistry({
        client,
        bridge,
        resolveWorkspaceFolders: () => [],
        now: () => 0,
      })
      const record = await registerLspServer({
        ownerId: "p",
        config: makeServer(),
        pluginPath: "/plugins/p",
      })
      expect(record.state).toBe("crashed")
      expect(record.lastError).toMatch(/ledger db unavailable/i)
      expect(client.started).toHaveLength(0)
    })

    it("re-registering the same owner+serverId throws", async () => {
      const { client, bridge } = makeFakeAdapters()
      configureLspRegistry({
        client,
        bridge,
        resolveWorkspaceFolders: () => [],
        now: () => 0,
      })
      await registerLspServer({ ownerId: "p", config: makeServer(), pluginPath: "/p" })
      await expect(
        registerLspServer({ ownerId: "p", config: makeServer(), pluginPath: "/p" })
      ).rejects.toThrow(/already registered/)
    })
  })

  describe("diagnostics forwarding", () => {
    it("forwards LSP-shape diagnostics through the bridge with the registry key as extensionId", async () => {
      const { client, bridge } = makeFakeAdapters()
      configureLspRegistry({
        client,
        bridge,
        resolveWorkspaceFolders: () => [],
        now: () => 0,
      })
      await registerLspServer({
        ownerId: "publisher.eslint",
        config: makeServer(),
        pluginPath: "/p",
      })

      const fire = client.onDiagnosticsHandles.get("publisher.eslint:eslint")!
      fire("file:///foo.ts", [
        {
          severity: "error",
          message: "unused var",
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 },
        },
      ])

      expect(bridge.diagnosticsCalls).toHaveLength(1)
      expect(bridge.diagnosticsCalls[0]).toEqual({
        extensionId: "publisher.eslint:eslint",
        uri: "file:///foo.ts",
        markersCount: 1,
      })
    })
  })

  describe("unregisterLspServer / unregisterByOwner", () => {
    it("stops the client and drops the record", async () => {
      const { client, bridge } = makeFakeAdapters()
      configureLspRegistry({
        client,
        bridge,
        resolveWorkspaceFolders: () => [],
        now: () => 0,
      })
      await registerLspServer({ ownerId: "p", config: makeServer(), pluginPath: "/p" })
      await unregisterLspServer("p", "eslint")
      expect(client.stopped).toHaveLength(1)
      expect(listLspServers()).toHaveLength(0)
    })

    it("is idempotent on a missing record", async () => {
      const { client, bridge } = makeFakeAdapters()
      configureLspRegistry({
        client,
        bridge,
        resolveWorkspaceFolders: () => [],
        now: () => 0,
      })
      await expect(unregisterLspServer("nope", "nope")).resolves.toBeUndefined()
      expect(client.stopped).toHaveLength(0)
    })

    it("unregisterByOwner drops every record under that ownerId", async () => {
      const { client, bridge } = makeFakeAdapters()
      configureLspRegistry({
        client,
        bridge,
        resolveWorkspaceFolders: () => [],
        now: () => 0,
      })
      await registerLspServer({ ownerId: "p", config: makeServer({ id: "a" }), pluginPath: "/p" })
      await registerLspServer({ ownerId: "p", config: makeServer({ id: "b" }), pluginPath: "/p" })
      await registerLspServer({
        ownerId: "user",
        config: makeServer({ id: "c" }),
        pluginPath: "/u",
      })
      const removed = await unregisterByOwner("p")
      expect(removed).toBe(2)
      expect(listLspServers().map((r) => r.serverId)).toEqual(["c"])
    })

    it("survives a stop() that throws (warn + continue)", async () => {
      const { client, bridge } = makeFakeAdapters()
      client.stop = async () => {
        throw new Error("kill failed")
      }
      configureLspRegistry({
        client,
        bridge,
        resolveWorkspaceFolders: () => [],
        now: () => 0,
      })
      await registerLspServer({ ownerId: "p", config: makeServer(), pluginPath: "/p" })
      await expect(unregisterLspServer("p", "eslint")).resolves.toBeUndefined()
      expect(listLspServers()).toHaveLength(0)
    })
  })

  describe("queries", () => {
    it("getLspServerForLanguage returns the first running record whose languages include the id", async () => {
      const { client, bridge } = makeFakeAdapters()
      configureLspRegistry({
        client,
        bridge,
        resolveWorkspaceFolders: () => [],
        now: () => 0,
      })
      await registerLspServer({
        ownerId: "p",
        config: makeServer({ id: "ts", languages: ["typescript"] }),
        pluginPath: "/p",
      })
      const ts = getLspServerForLanguage("typescript")
      expect(ts?.serverId).toBe("ts")
      expect(getLspServerForLanguage("rust")).toBeUndefined()
    })

    it("getLspServerForLanguage skips records that are not running", async () => {
      const { client, bridge } = makeFakeAdapters()
      evaluateLspBinaryMock.mockResolvedValue({
        allowed: false,
        requiresPrompt: true,
        reason: "no consent",
      })
      configureLspRegistry({
        client,
        bridge,
        resolveWorkspaceFolders: () => [],
        now: () => 0,
      })
      await registerLspServer({ ownerId: "p", config: makeServer(), pluginPath: "/p" })
      // The record exists but in stopped/consent-required state.
      expect(getLspServerForLanguage("typescript")).toBeUndefined()
    })
  })

  describe("registerPluginLspServers", () => {
    it("registers each entry under the plugin's ownerId", async () => {
      const { client, bridge } = makeFakeAdapters()
      configureLspRegistry({
        client,
        bridge,
        resolveWorkspaceFolders: () => [],
        now: () => 0,
      })
      const records = await registerPluginLspServers({
        pluginId: "pub.lsp",
        pluginPath: "/p",
        servers: [
          makeServer({ id: "ts" }),
          makeServer({ id: "py", languages: ["python"], command: "pylsp" }),
        ],
      })
      expect(records).toHaveLength(2)
      expect(records.every((r) => r.ownerId === "pub.lsp")).toBe(true)
      expect(client.started.map((s) => s.serverId).sort()).toEqual(["py", "ts"])
    })

    it("does not abort the batch when one entry fails", async () => {
      const { client, bridge } = makeFakeAdapters()
      let calls = 0
      client.start = async (input) => {
        calls += 1
        if (input.serverId === "ts") throw new Error("boom")
        // The fake otherwise just records.
        ;(client as { started: typeof client.started }).started.push({
          ownerId: input.ownerId,
          serverId: input.serverId,
          foldersCount: 0,
        })
      }
      configureLspRegistry({
        client,
        bridge,
        resolveWorkspaceFolders: () => [],
        now: () => 0,
      })
      const records = await registerPluginLspServers({
        pluginId: "pub.lsp",
        pluginPath: "/p",
        servers: [makeServer({ id: "ts" }), makeServer({ id: "py" })],
      })
      expect(records).toHaveLength(2)
      expect(records.find((r) => r.serverId === "ts")?.state).toBe("crashed")
      expect(records.find((r) => r.serverId === "py")?.state).toBe("running")
      expect(calls).toBe(2)
    })
  })

  describe("lspServerKey", () => {
    it("returns ${owner}:${serverId}", () => {
      expect(lspServerKey("p", "ts")).toBe("p:ts")
    })
  })
})
