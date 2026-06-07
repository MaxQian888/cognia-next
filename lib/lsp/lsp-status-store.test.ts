import {
  useLspStatusStore,
  configureLspStatusStore,
  __resetLspStatusStoreForTesting,
  type LspStatusDeps,
} from "./lsp-status-store"
import type { ResolvedLspServer } from "@/types/lsp/config"
import type {
  LspDetectResultEntry,
  LspInstallProgressEvent,
  LspRuntimeStatusEntry,
  LspStatePushEvent,
} from "@/lib/plugin/lsp/lsp-client-adapter-tauri"

function server(id: string, extra: Partial<ResolvedLspServer> = {}): ResolvedLspServer {
  return {
    id,
    name: id,
    languages: ["x"],
    command: `${id}-bin`,
    source: "builtin",
    ...extra,
  }
}

interface FakeAdapter {
  detect: jest.Mock
  installServer: jest.Mock
  status: jest.Mock
  logs: jest.Mock
  onInstallProgress: jest.Mock
  onStatePush: jest.Mock
  fireInstallProgress: (p: LspInstallProgressEvent) => void
  fireStatePush: (p: LspStatePushEvent) => void
}

function makeDeps({
  servers = [server("typescript", { install: { npmPackage: "typescript-language-server" } })],
  detected = [] as LspDetectResultEntry[],
  runtime = [] as LspRuntimeStatusEntry[],
  hostAvailable = true,
  // null = "no managed dir" (explicit undefined would re-trigger the default)
  installDir = "D:/data/lsp" as string | null,
} = {}): { deps: LspStatusDeps; adapter: FakeAdapter } {
  const progressListeners: Array<(p: LspInstallProgressEvent) => void> = []
  const stateListeners: Array<(p: LspStatePushEvent) => void> = []
  const adapter: FakeAdapter = {
    detect: jest.fn(async () => detected),
    installServer: jest.fn(async () => ({
      serverId: "typescript",
      status: "managed",
      source: "managed",
      resolvedPath: "D:/data/lsp/node/x/.bin/tsls",
    })),
    status: jest.fn(async () => runtime),
    logs: jest.fn(async () => []),
    onInstallProgress: jest.fn((cb: (p: LspInstallProgressEvent) => void) => {
      progressListeners.push(cb)
      return () => {}
    }),
    onStatePush: jest.fn((cb: (p: LspStatePushEvent) => void) => {
      stateListeners.push(cb)
      return () => {}
    }),
    fireInstallProgress: (p) => progressListeners.forEach((cb) => cb(p)),
    fireStatePush: (p) => stateListeners.forEach((cb) => cb(p)),
  }
  const deps: LspStatusDeps = {
    adapter: adapter as unknown as LspStatusDeps["adapter"],
    resolveServers: async () => servers,
    resolveInstallDir: async () => installDir ?? undefined,
    hostAvailable: () => hostAvailable,
  }
  return { deps, adapter }
}

beforeEach(() => {
  __resetLspStatusStoreForTesting()
})

describe("useLspStatusStore.refresh", () => {
  it("stays inert when the host is unavailable (web/mobile)", async () => {
    const { deps, adapter } = makeDeps({ hostAvailable: false })
    configureLspStatusStore(deps)
    await useLspStatusStore.getState().refresh()
    expect(useLspStatusStore.getState().statuses).toEqual({})
    expect(adapter.detect).not.toHaveBeenCalled()
  })

  it("merges detection + runtime health into per-server statuses", async () => {
    const { deps } = makeDeps({
      detected: [
        {
          serverId: "typescript",
          status: "managed",
          source: "managed",
          resolvedPath: "D:/data/lsp/bin/tsls",
        },
      ],
      runtime: [
        // Agent composite id rolls up to the base id.
        {
          key: "agent:typescript#abc",
          ownerId: "agent",
          serverId: "typescript#abc",
          state: "running",
          restarts: 1,
        },
      ],
    })
    configureLspStatusStore(deps)
    await useLspStatusStore.getState().refresh()
    const status = useLspStatusStore.getState().statuses["typescript"]
    expect(status.install).toBe("managed")
    expect(status.resolvedPath).toBe("D:/data/lsp/bin/tsls")
    expect(status.health).toBe("running")
    expect(status.restarts).toBe(1)
    expect(status.npmPackage).toBe("typescript-language-server")
  })

  it("defaults to missing + stopped when nothing is detected or running", async () => {
    const { deps } = makeDeps()
    configureLspStatusStore(deps)
    await useLspStatusStore.getState().refresh()
    const status = useLspStatusStore.getState().statuses["typescript"]
    expect(status.install).toBe("missing")
    expect(status.health).toBe("stopped")
  })

  it("applies lsp:state pushes to the matching base server id", async () => {
    const { deps, adapter } = makeDeps({
      detected: [
        { serverId: "typescript", status: "installed", source: "path", resolvedPath: "/x" },
      ],
    })
    configureLspStatusStore(deps)
    await useLspStatusStore.getState().refresh()
    adapter.fireStatePush({
      key: "agent:typescript#abc",
      ownerId: "agent",
      serverId: "typescript#abc",
      state: "broken",
      restarts: 4,
      lastError: "spawn ENOENT",
    })
    const status = useLspStatusStore.getState().statuses["typescript"]
    expect(status.health).toBe("broken")
    expect(status.restarts).toBe(4)
    expect(status.lastError).toBe("spawn ENOENT")
  })

  it("tracks install progress pushes", async () => {
    const { deps, adapter } = makeDeps()
    configureLspStatusStore(deps)
    await useLspStatusStore.getState().refresh()
    adapter.fireInstallProgress({ serverId: "typescript", phase: "installing" })
    expect(useLspStatusStore.getState().installProgress["typescript"]?.phase).toBe("installing")
  })
})

describe("useLspStatusStore.install", () => {
  it("runs the adapter install and refreshes", async () => {
    const { deps, adapter } = makeDeps()
    configureLspStatusStore(deps)
    const ok = await useLspStatusStore.getState().install("typescript")
    expect(ok).toBe(true)
    expect(adapter.installServer).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "typescript",
        npmPackage: "typescript-language-server",
        installDir: "D:/data/lsp",
      })
    )
  })

  it("declines servers without install metadata or without an install dir", async () => {
    const noMeta = makeDeps({ servers: [server("rust-analyzer")] })
    configureLspStatusStore(noMeta.deps)
    expect(await useLspStatusStore.getState().install("rust-analyzer")).toBe(false)

    __resetLspStatusStoreForTesting()
    const noDir = makeDeps({ installDir: null })
    configureLspStatusStore(noDir.deps)
    expect(await useLspStatusStore.getState().install("typescript")).toBe(false)
    expect(noDir.adapter.installServer).not.toHaveBeenCalled()
  })

  it("marks error progress when the adapter throws", async () => {
    const { deps, adapter } = makeDeps()
    adapter.installServer.mockRejectedValue(new Error("npm died"))
    configureLspStatusStore(deps)
    expect(await useLspStatusStore.getState().install("typescript")).toBe(false)
    expect(useLspStatusStore.getState().installProgress["typescript"]?.phase).toBe("error")
  })
})
