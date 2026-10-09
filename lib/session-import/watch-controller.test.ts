import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"

import {
  __resetSessionImportWatchForTesting,
  isSessionImportWatchActive,
  retargetSessionImportWatch,
  startSessionImportWatch,
  stopSessionImportWatch,
  type SessionImportWatchDeps,
} from "./watch-controller"

type ChangedHandler = (event: {
  payload?: { path?: string; paths?: string[]; rescan?: boolean }
}) => void

function makeDeps(over: Partial<SessionImportWatchDeps> = {}) {
  let handler: ChangedHandler | null = null
  const unlisten = jest.fn()
  const deps: SessionImportWatchDeps = {
    isTauri: jest.fn(() => true),
    invoke: jest.fn(async () => true),
    listen: jest.fn(async (_event: string, cb: ChangedHandler) => {
      handler = cb
      return unlisten
    }),
    collectWatchRoots: jest.fn(async () => ["/home/u/.claude/projects"]),
    runWatchImport: jest.fn(async () => ({ sessions: 0, messages: 0 })),
    ...over,
  }
  return {
    deps,
    fire: (path?: string) => handler?.({ payload: { path } }),
    fireBatch: (paths: string[], rescan = false) => handler?.({ payload: { paths, rescan } }),
    unlisten,
  }
}

afterEach(() => {
  __resetSessionImportWatchForTesting()
  jest.restoreAllMocks()
})

describe("session-import watch controller", () => {
  it.each(["inactive", "active", "starting"] as const)(
    "stops after HMR disposal without loading modules (watch: %s)",
    async (state) => {
      // Jest caches imports, so run the actual controller in a loader that
      // rejects late imports just as Turbopack does for a disposed module.
      const { outputText } = transpileModule(
        readFileSync(join(__dirname, "watch-controller.ts"), "utf8"),
        { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }
      )
      const { deps, unlisten } = makeDeps()
      let resolveRoots!: (roots: string[]) => void
      if (state === "starting") {
        deps.collectWatchRoots = jest.fn(
          () =>
            new Promise<string[]>((resolve) => {
              resolveRoots = resolve
            })
        )
      }
      const warn = jest.fn()
      let disposed = false
      const modules: Record<string, unknown> = {
        "@cognia/logging": { createLogger: () => ({ warn, error: jest.fn() }) },
        "@/lib/tauri": { isTauri: deps.isTauri },
        "@/lib/tauri/safe-unlisten": jest.requireActual("@/lib/tauri/safe-unlisten"),
        "./watch-import": deps,
        "@tauri-apps/api/core": { invoke: deps.invoke },
        "@tauri-apps/api/event": { listen: deps.listen },
      }
      const controller = {} as typeof import("./watch-controller")
      runInNewContext(outputText, {
        exports: controller,
        require: (id: string) => {
          if (disposed) {
            throw new Error(
              `Unexpected import of module ${id} from module watch-controller.ts, which was deleted by an HMR update`
            )
          }
          if (!(id in modules)) throw new Error(`Unexpected test dependency: ${id}`)
          return modules[id]
        },
      })
      const start = state === "inactive" ? undefined : controller.startSessionImportWatch()
      if (state === "active") await start
      if (state === "starting") {
        await Promise.resolve()
        expect(deps.collectWatchRoots).toHaveBeenCalledTimes(1)
      }
      disposed = true
      const stop = controller.stopSessionImportWatch()
      if (state === "starting") resolveRoots(["/home/u/.claude/projects"])
      await start
      await stop
      expect(warn).not.toHaveBeenCalled()
      expect(deps.invoke).toHaveBeenLastCalledWith("session_import_watch_stop", undefined)
      expect(controller.isSessionImportWatchActive()).toBe(false)
      expect(unlisten).toHaveBeenCalledTimes(state === "inactive" ? 0 : 1)
    }
  )

  it("imports every distinct path in a batch and rescans once after overflow", async () => {
    const { deps, fireBatch } = makeDeps()
    await startSessionImportWatch({ deps })
    ;(deps.runWatchImport as jest.Mock).mockClear()
    fireBatch(["a.jsonl", "b.jsonl", "a.jsonl"])
    expect(deps.runWatchImport).toHaveBeenCalledTimes(2)
    expect(deps.runWatchImport).toHaveBeenCalledWith({
      changedPath: "a.jsonl",
      projectId: undefined,
    })
    expect(deps.runWatchImport).toHaveBeenCalledWith({
      changedPath: "b.jsonl",
      projectId: undefined,
    })
    fireBatch(["partial.jsonl"], true)
    expect(deps.runWatchImport).toHaveBeenLastCalledWith({
      changedPath: undefined,
      projectId: undefined,
    })
    await stopSessionImportWatch(deps)
    fireBatch(["stale.jsonl"])
    expect(deps.runWatchImport).toHaveBeenCalledTimes(3)
  })

  it("catches up offline changes once after successful installation", async () => {
    const { deps } = makeDeps()
    await startSessionImportWatch({ projectId: "workspace", deps })
    expect(deps.runWatchImport).toHaveBeenCalledTimes(1)
    expect(deps.runWatchImport).toHaveBeenCalledWith({ projectId: "workspace" })
    await startSessionImportWatch({ projectId: "retarget", deps })
    expect(deps.runWatchImport).toHaveBeenCalledTimes(1)
  })

  it("does not catch up or keep a listener when native start finds no roots", async () => {
    const { deps, unlisten } = makeDeps({ invoke: jest.fn(async () => false) })
    await startSessionImportWatch({ deps })
    expect(isSessionImportWatchActive()).toBe(false)
    expect(deps.runWatchImport).not.toHaveBeenCalled()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it("keeps a successful watch installed when background catch-up fails", async () => {
    const { deps } = makeDeps({
      runWatchImport: jest.fn(async () => {
        throw new Error("database busy")
      }),
    })
    await expect(startSessionImportWatch({ deps })).resolves.toBeUndefined()
    await Promise.resolve()
    expect(isSessionImportWatchActive()).toBe(true)
  })

  it("subscribes before native start and cleans up a failed start", async () => {
    const order: string[] = []
    const unlisten = jest.fn()
    const { deps } = makeDeps({
      listen: jest.fn(async () => {
        order.push("listen")
        return unlisten
      }),
      invoke: jest.fn(async () => {
        order.push("start")
        throw new Error("native failed")
      }),
    })
    await expect(startSessionImportWatch({ deps })).rejects.toThrow("native failed")
    expect(order).toEqual(["listen", "start"])
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
  it("is a no-op off Tauri", async () => {
    const { deps } = makeDeps({ isTauri: jest.fn(() => false) })
    await startSessionImportWatch({ deps })
    expect(isSessionImportWatchActive()).toBe(false)
    expect(deps.invoke).not.toHaveBeenCalled()
  })

  it("starts once, imports on change, and stops the NATIVE watcher too", async () => {
    const { deps, fire, unlisten } = makeDeps()
    await startSessionImportWatch({ projectId: "proj", deps })

    expect(isSessionImportWatchActive()).toBe(true)
    expect(deps.invoke).toHaveBeenCalledWith("session_import_watch_start", {
      roots: ["/home/u/.claude/projects"],
    })

    fire("/home/u/.claude/projects/x.jsonl")
    await Promise.resolve()
    expect(deps.runWatchImport).toHaveBeenCalledWith({
      changedPath: "/home/u/.claude/projects/x.jsonl",
      projectId: "proj",
    })

    await stopSessionImportWatch(deps)
    expect(isSessionImportWatchActive()).toBe(false)
    expect(unlisten).toHaveBeenCalled()
    // The regression this module exists for: teardown used to drop only the
    // listener, leaving the Rust watcher installed for the rest of the process.
    expect(deps.invoke).toHaveBeenCalledWith("session_import_watch_stop")
  })

  it("does not install a second watcher when started twice", async () => {
    const { deps } = makeDeps()
    await startSessionImportWatch({ projectId: "a", deps })
    await startSessionImportWatch({ projectId: "b", deps })

    const starts = (deps.invoke as jest.Mock).mock.calls.filter(
      ([cmd]) => cmd === "session_import_watch_start"
    )
    expect(starts).toHaveLength(1)
    expect(deps.listen).toHaveBeenCalledTimes(1)
  })

  it("re-targets a running watch instead of restarting it", async () => {
    const { deps, fire } = makeDeps()
    await startSessionImportWatch({ projectId: "old", deps })
    await startSessionImportWatch({ projectId: "new", deps })

    fire("/home/u/.claude/projects/x.jsonl")
    await Promise.resolve()
    expect(deps.runWatchImport).toHaveBeenCalledWith({
      changedPath: "/home/u/.claude/projects/x.jsonl",
      projectId: "new",
    })
  })

  it("retargetSessionImportWatch redirects later events without a restart", async () => {
    const { deps, fire } = makeDeps()
    await startSessionImportWatch({ projectId: "old", deps })
    retargetSessionImportWatch("switched")

    fire("/x.jsonl")
    await Promise.resolve()
    expect(deps.runWatchImport).toHaveBeenCalledWith({
      changedPath: "/x.jsonl",
      projectId: "switched",
    })
    expect(deps.listen).toHaveBeenCalledTimes(1)
  })

  it("swallows a failing background import instead of rejecting unhandled", async () => {
    const { deps, fire } = makeDeps({
      runWatchImport: jest.fn(async () => {
        throw new Error("dexie closed")
      }),
    })
    await startSessionImportWatch({ deps })
    expect(() => fire("/x.jsonl")).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(isSessionImportWatchActive()).toBe(true)
  })

  it("releases the slot when the native start fails", async () => {
    const { deps } = makeDeps({
      invoke: jest.fn(async (cmd: string) => {
        if (cmd === "session_import_watch_start") throw new Error("no roots")
        return true
      }),
    })
    await expect(startSessionImportWatch({ deps })).rejects.toThrow("no roots")
    expect(isSessionImportWatchActive()).toBe(false)
  })

  it("still starts after an earlier start failed", async () => {
    // The failure is reported to ITS caller, but it must not settle the shared
    // serialization chain into a rejected state: `p.then(cb)` on a rejected `p`
    // skips `cb` outright, which would make every later start AND stop a silent
    // no-op for the rest of the process.
    let failNext = true
    const { deps } = makeDeps({
      invoke: jest.fn(async (cmd: string) => {
        if (cmd === "session_import_watch_start" && failNext) throw new Error("no roots")
        return true
      }),
    })

    await expect(startSessionImportWatch({ deps })).rejects.toThrow("no roots")
    failNext = false

    await startSessionImportWatch({ projectId: "after", deps })
    expect(isSessionImportWatchActive()).toBe(true)

    await stopSessionImportWatch(deps)
    expect(isSessionImportWatchActive()).toBe(false)
    expect(deps.invoke).toHaveBeenCalledWith("session_import_watch_stop")
  })

  it("stops the native watcher even when this process holds no record", async () => {
    // A previous window/hot-reload can leave the Rust watcher installed with no
    // in-process record; a stop must still reach it.
    const { deps } = makeDeps()
    await stopSessionImportWatch(deps)
    expect(deps.invoke).toHaveBeenCalledWith("session_import_watch_stop")
  })
})
