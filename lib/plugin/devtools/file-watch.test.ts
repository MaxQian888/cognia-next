/**
 * @jest-environment jsdom
 */

import type { Plugin } from "@/types/plugin"
import {
  APP_WATCH_SOURCE,
  FILE_CHANGE_EVENT,
  resolveWatchedPluginId,
  startPluginFileWatch,
  watchEligibility,
  type PluginFileChangePayload,
  type PluginFileWatchDependencies,
} from "./file-watch"

function plugin(overrides: {
  id: string
  source?: Plugin["source"]
  type?: Plugin["manifest"]["type"]
  path?: string
}): Plugin {
  return {
    manifest: {
      id: overrides.id,
      name: overrides.id,
      version: "1.0.0",
      type: overrides.type ?? "frontend",
    },
    status: "enabled",
    source: overrides.source ?? "dev",
    path: overrides.path ?? `/plugins/${overrides.id}`,
    config: {},
  } as unknown as Plugin
}

interface Harness {
  deps: PluginFileWatchDependencies
  emit: (payload: PluginFileChangePayload) => void
  started: string[][]
  stopped: number
  reloads: Array<{ pluginId: string; attempt: number }>
  recorded: Parameters<PluginFileWatchDependencies["record"]>[0][]
  unlistened: number
}

function harness(reload?: PluginFileWatchDependencies["reload"]): Harness {
  const started: string[][] = []
  const reloads: Harness["reloads"] = []
  const recorded: Harness["recorded"] = []
  let handler: ((payload: PluginFileChangePayload) => void) | undefined
  const state = { stopped: 0, unlistened: 0 }
  const deps: PluginFileWatchDependencies = {
    isDesktop: () => true,
    startWatch: async (paths) => {
      started.push(paths)
    },
    stopWatch: async () => {
      state.stopped += 1
    },
    listen: async (event, h) => {
      expect(event).toBe(FILE_CHANGE_EVENT)
      handler = h
      return () => {
        state.unlistened += 1
      }
    },
    reload:
      reload ??
      (async (pluginId, attempt) => {
        reloads.push({ pluginId, attempt })
        return { ok: true, pluginId } as never
      }),
    record: (entry) => {
      recorded.push(entry)
    },
    now: () => 1000,
    debounceMs: 10,
    sessionId: "app-watch:test",
  }
  return {
    deps,
    emit: (payload) => handler?.(payload),
    started,
    get stopped() {
      return state.stopped
    },
    get unlistened() {
      return state.unlistened
    },
    reloads,
    recorded,
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 30))

describe("watchEligibility", () => {
  it("watches a locally-sourced frontend plugin", () => {
    expect(watchEligibility(plugin({ id: "a" }), true)).toEqual({ watchable: true })
  })

  it("watches python, whose on-disk source is what the host runs", () => {
    expect(watchEligibility(plugin({ id: "a", type: "python" }), true)).toEqual({ watchable: true })
  })

  it.each(["wasm", "vscode-extension"] as const)(
    "reports %s as needing a build the app cannot do",
    (type) => {
      expect(watchEligibility(plugin({ id: "a", type }), true)).toEqual({
        watchable: false,
        reason: "needs-build",
      })
    }
  )

  it("reports a marketplace plugin as having no source tree", () => {
    expect(watchEligibility(plugin({ id: "a", source: "marketplace" }), true)).toEqual({
      watchable: false,
      reason: "not-local-source",
    })
  })

  it("reports the whole feature as desktop-only off Tauri", () => {
    expect(watchEligibility(plugin({ id: "a" }), false)).toEqual({
      watchable: false,
      reason: "desktop-required",
    })
  })
})

describe("resolveWatchedPluginId", () => {
  const roots = [
    { pluginId: "demo", root: "/plugins/demo" },
    { pluginId: "demo-extra", root: "/plugins/demo-extra" },
    { pluginId: "nested", root: "/plugins/demo/nested" },
  ]

  it("matches a file under a root", () => {
    expect(resolveWatchedPluginId(roots, "/plugins/demo/src/index.js")).toBe("demo")
  })

  it("prefers the longest matching root so a nested plugin wins", () => {
    expect(resolveWatchedPluginId(roots, "/plugins/demo/nested/main.js")).toBe("nested")
  })

  it("does not credit a plugin whose id is a prefix of another", () => {
    // The old resolver fell back to `path.includes(pluginId)`, which
    // attributed every `demo-extra` edit to `demo`.
    expect(resolveWatchedPluginId(roots, "/plugins/demo-extra/src/index.js")).toBe("demo-extra")
  })

  it("returns null for a path outside every root", () => {
    expect(resolveWatchedPluginId(roots, "/somewhere/else/index.js")).toBeNull()
  })

  it("handles Windows separators", () => {
    expect(
      resolveWatchedPluginId(
        [{ pluginId: "demo", root: "C:\\plugins\\demo" }],
        "C:\\plugins\\demo\\a.js"
      )
    ).toBe("demo")
  })
})

describe("startPluginFileWatch", () => {
  it("watches only the eligible plugins and reports which", async () => {
    const h = harness()
    const handle = await startPluginFileWatch(
      [
        plugin({ id: "ok" }),
        plugin({ id: "built", type: "wasm" }),
        plugin({ id: "store", source: "marketplace" }),
      ],
      h.deps
    )
    expect(handle.watchedPluginIds).toEqual(["ok"])
    expect(h.started).toEqual([["/plugins/ok"]])
    await handle.stop()
  })

  it("starts no watcher and needs no teardown when nothing is eligible", async () => {
    const h = harness()
    const handle = await startPluginFileWatch([plugin({ id: "built", type: "wasm" })], h.deps)
    expect(handle.watchedPluginIds).toEqual([])
    expect(h.started).toEqual([])
    await handle.stop()
    expect(h.stopped).toBe(0)
  })

  it("debounces a burst of saves into one reload", async () => {
    const h = harness()
    const handle = await startPluginFileWatch([plugin({ id: "ok" })], h.deps)
    for (let i = 0; i < 5; i++) {
      h.emit({ type: "modify", path: "/plugins/ok/index.js", timestamp: i })
    }
    await flush()
    expect(h.reloads).toEqual([{ pluginId: "ok", attempt: 1 }])
    await handle.stop()
  })

  it("records the attempt and then the outcome", async () => {
    const h = harness()
    const handle = await startPluginFileWatch([plugin({ id: "ok" })], h.deps)
    h.emit({ type: "modify", path: "/plugins/ok/index.js", timestamp: 1 })
    await flush()
    expect(h.recorded.map((e) => e.status)).toEqual(["in-progress", "success"])
    expect(h.recorded.every((e) => e.source === APP_WATCH_SOURCE)).toBe(true)
    await handle.stop()
  })

  it("records the failure message when the reload is not verified", async () => {
    const h = harness(
      async () =>
        ({
          ok: false,
          pluginId: "ok",
          error: { message: "activation not proven" },
        }) as never
    )
    const handle = await startPluginFileWatch([plugin({ id: "ok" })], h.deps)
    h.emit({ type: "modify", path: "/plugins/ok/index.js", timestamp: 1 })
    await flush()
    expect(h.recorded[1]).toMatchObject({ status: "failed", note: "activation not proven" })
    await handle.stop()
  })

  it("records a thrown reload rather than going silent", async () => {
    // A throw is the watcher failing, not the plugin. Swallowing it would look
    // exactly like a plugin that never changed.
    const h = harness(async () => {
      throw new Error("bridge is gone")
    })
    const handle = await startPluginFileWatch([plugin({ id: "ok" })], h.deps)
    h.emit({ type: "modify", path: "/plugins/ok/index.js", timestamp: 1 })
    await flush()
    expect(h.recorded[1]).toMatchObject({ status: "failed", note: "bridge is gone" })
    await handle.stop()
  })

  it("ignores changes outside every watched root", async () => {
    const h = harness()
    const handle = await startPluginFileWatch([plugin({ id: "ok" })], h.deps)
    h.emit({ type: "modify", path: "/elsewhere/index.js", timestamp: 1 })
    await flush()
    expect(h.reloads).toEqual([])
    await handle.stop()
  })

  it("stops listening, drops pending reloads and releases the native watcher", async () => {
    const h = harness()
    const handle = await startPluginFileWatch([plugin({ id: "ok" })], h.deps)
    h.emit({ type: "modify", path: "/plugins/ok/index.js", timestamp: 1 })
    await handle.stop()
    await flush()
    expect(h.reloads).toEqual([])
    expect(h.unlistened).toBe(1)
    expect(h.stopped).toBe(1)
  })

  it("numbers attempts per plugin", async () => {
    const h = harness()
    const handle = await startPluginFileWatch([plugin({ id: "a" }), plugin({ id: "b" })], h.deps)
    h.emit({ type: "modify", path: "/plugins/a/x.js", timestamp: 1 })
    h.emit({ type: "modify", path: "/plugins/b/x.js", timestamp: 1 })
    await flush()
    h.emit({ type: "modify", path: "/plugins/a/x.js", timestamp: 2 })
    await flush()
    expect(h.reloads).toEqual([
      { pluginId: "a", attempt: 1 },
      { pluginId: "b", attempt: 1 },
      { pluginId: "a", attempt: 2 },
    ])
    await handle.stop()
  })
})
