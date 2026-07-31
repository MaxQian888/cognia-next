import os from "node:os"
import nodeFs from "node:fs"
import nodeFsP from "node:fs/promises"
import path from "node:path"
import type { PluginManifest } from "@/types/plugin"
import {
  listHostPlugins,
  reloadPlugin,
  registerDiskPlugins,
  uninstallHostPlugin,
  defaultDiscoverDiskPlugins,
  type HostManager,
  type DiskPluginEntry,
} from "./host"

function manifest(id: string): PluginManifest {
  return {
    id,
    name: id,
    version: "1.0.0",
    description: "",
    type: "frontend",
    main: "main.js",
    capabilities: [],
  } as unknown as PluginManifest
}

function fakeManager() {
  const events: string[] = []
  const mgr: HostManager & { events: string[] } = {
    events,
    registerDiskPlugin: jest.fn(async (m: PluginManifest, dir: string) => {
      events.push(`register:${m.id}@${dir}`)
    }),
    loadPlugin: jest.fn(async (id: string) => void events.push(`load:${id}`)),
    enablePlugin: jest.fn(async (id: string) => void events.push(`enable:${id}`)),
    disablePlugin: jest.fn(async (id: string) => void events.push(`disable:${id}`)),
    unloadPlugin: jest.fn(async (id: string) => void events.push(`unload:${id}`)),
    list: jest.fn(() => [
      {
        id: "demo",
        name: "Demo",
        version: "1.0.0",
        type: "frontend",
        path: "/home/u/.cognia/plugins/demo",
        status: "enabled",
        tools: [{ name: "t" }],
      },
      {
        id: "wt",
        name: "Web",
        version: "1.0.0",
        type: "frontend",
        path: "builtin://web-tools",
        status: "enabled",
        tools: [],
      },
    ]),
  }
  return mgr
}

const entry = (id: string, dir: string, supported = true): DiskPluginEntry => ({
  id,
  dir,
  manifest: manifest(id),
  supported,
})

describe("registerDiskPlugins", () => {
  it("registers, loads, and enables disk frontend plugins not in the disabled set", async () => {
    const mgr = fakeManager()
    await registerDiskPlugins({
      manager: mgr,
      discover: async () => [entry("demo", "/home/u/.cognia/plugins/demo")],
      disabled: new Set<string>(),
      notify: () => {},
    })
    expect(mgr.events).toEqual([
      "register:demo@/home/u/.cognia/plugins/demo",
      "load:demo",
      "enable:demo",
    ])
  })

  it("registers but does not enable a plugin in the disabled set", async () => {
    const mgr = fakeManager()
    await registerDiskPlugins({
      manager: mgr,
      discover: async () => [entry("demo", "/d")],
      disabled: new Set(["demo"]),
      notify: () => {},
    })
    expect(mgr.events).toEqual(["register:demo@/d"])
  })

  it("skips unsupported (non-frontend) plugins entirely", async () => {
    const mgr = fakeManager()
    await registerDiskPlugins({
      manager: mgr,
      discover: async () => [entry("py", "/p", false)],
      disabled: new Set<string>(),
      notify: () => {},
    })
    expect(mgr.events).toEqual([])
  })

  it("notifies and continues when a plugin fails to load", async () => {
    const mgr = fakeManager()
    mgr.loadPlugin = jest.fn(async () => {
      throw new Error("boom")
    })
    const notes: string[] = []
    await registerDiskPlugins({
      manager: mgr,
      discover: async () => [entry("demo", "/d")],
      disabled: new Set<string>(),
      notify: (m) => notes.push(m),
    })
    expect(notes[0]).toMatch(/demo.*boom/)
  })
})

describe("listHostPlugins", () => {
  it("maps the manager store to rows with origin labels and tool counts", () => {
    const rows = listHostPlugins({ manager: fakeManager() })
    expect(rows.find((r) => r.id === "demo")?.origin).toBe("disk")
    expect(rows.find((r) => r.id === "wt")?.origin).toBe("builtin")
    expect(rows.find((r) => r.id === "demo")?.toolCount).toBe(1)
    expect(rows.find((r) => r.id === "wt")?.toolCount).toBe(0)
  })

  it("treats a row with no tools array as zero tools", () => {
    const mgr = fakeManager()
    mgr.list = jest.fn(() => [
      { id: "x", name: "X", version: "1.0.0", type: "frontend", path: "/d/x", status: "enabled" },
    ])
    expect(listHostPlugins({ manager: mgr })[0].toolCount).toBe(0)
  })
})

describe("reloadPlugin", () => {
  it("runs disable → unload → load → enable in order", async () => {
    const mgr = fakeManager()
    await reloadPlugin("demo", { manager: mgr })
    expect(mgr.events).toEqual(["disable:demo", "unload:demo", "load:demo", "enable:demo"])
  })
})

describe("uninstallHostPlugin", () => {
  it("unloads then removes the plugin directory", async () => {
    const mgr = fakeManager()
    const removed: string[] = []
    await uninstallHostPlugin("demo", "/home/u/.cognia/plugins/demo", {
      manager: mgr,
      rm: async (p) => void removed.push(p),
    })
    expect(mgr.events).toEqual(["unload:demo"])
    expect(removed).toEqual(["/home/u/.cognia/plugins/demo"])
  })

  it("removes the real directory via the default rm when none is injected", async () => {
    const mgr = fakeManager()
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-uninstall-"))
    nodeFs.writeFileSync(path.join(dir, "plugin.json"), "{}")
    await uninstallHostPlugin("demo", dir, { manager: mgr })
    expect(nodeFs.existsSync(dir)).toBe(false)
  })
})

describe("defaultDiscoverDiskPlugins", () => {
  it("enumerates dirs and reads each full manifest via the injected fs", async () => {
    const full = JSON.stringify({
      id: "demo",
      name: "Demo",
      version: "2.0.0",
      type: "frontend",
      main: "entry.js",
      capabilities: ["tools"],
    })
    const fs = {
      async exists(p: string) {
        return p.includes("plugins") || p.endsWith("plugin.json")
      },
      async readDir() {
        return ["demo"]
      },
      async readText() {
        return full
      },
    }
    const entries = await defaultDiscoverDiskPlugins(["/proj"], fs)
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe("demo")
    expect(entries[0].supported).toBe(true)
    expect(entries[0].manifest.main).toBe("entry.js")
    expect(entries[0].manifest.capabilities).toEqual(["tools"])
  })

  it("skips a discovered plugin whose manifest fails to parse", async () => {
    const fs = {
      async exists() {
        return true
      },
      async readDir() {
        return ["demo"]
      },
      // discoverPlugins parses this first (valid), then defaultDiscover re-reads
      // the SAME path — return valid for the scan, invalid is simulated by a
      // second reader. Simplest: return a manifest discoverPlugins accepts but
      // that JSON.parse later rejects is impossible, so force the re-read to throw.
      readText: jest
        .fn()
        .mockResolvedValueOnce(
          JSON.stringify({ id: "demo", name: "Demo", version: "1.0.0", type: "frontend" })
        )
        .mockRejectedValueOnce(new Error("vanished")),
    }
    const entries = await defaultDiscoverDiskPlugins(["/proj"], fs)
    expect(entries).toEqual([])
  })

  it("reads through the real default fs when none is injected", async () => {
    const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-discover-"))
    try {
      const dir = path.join(root, ".cognia", "plugins", "demo")
      nodeFs.mkdirSync(dir, { recursive: true })
      nodeFs.writeFileSync(
        path.join(dir, "plugin.json"),
        JSON.stringify({
          id: "demo",
          name: "Demo",
          version: "1.0.0",
          type: "frontend",
          main: "main.js",
        })
      )
      const entries = await defaultDiscoverDiskPlugins([root])
      expect(entries.map((e) => e.id)).toEqual(["demo"])
      expect(entries[0].manifest.main).toBe("main.js")
    } finally {
      await nodeFsP.rm(root, { recursive: true, force: true })
    }
  })
})
