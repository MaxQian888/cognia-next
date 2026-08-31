import {
  adaptPluginCompletionProvider,
  registerPluginCompletionProvider,
  registerTerminalCompletionProvidersForPlugin,
  unregisterTerminalCompletionProvidersForPlugin,
} from "./terminal-completion-bridge"
import {
  __resetCompletionRegistryForTesting,
  getCompletions,
  listProviders,
} from "@/lib/terminal/completion/registry"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { TerminalCompletionContext } from "@/lib/terminal/completion/types"
import {
  __resetExperimentalPythonFlagForTesting,
  setExperimentalPythonBackedEnabled,
} from "@/lib/plugin/python/experimental-flag"
import {
  bindPythonRuntimeGeneration,
  __resetPythonRuntimeGenerationsForTesting,
} from "@/lib/plugin/python/runtime-generation"

function ctx(): TerminalCompletionContext {
  return {
    sessionId: "s1",
    shell: "bash",
    shellPath: "/bin/bash",
    cwd: "/x",
    input: "g",
    cursor: 1,
    recentCommands: [],
    platform: "linux",
    projectId: "project-1",
  }
}

const signal = new AbortController().signal

beforeEach(() => {
  __resetCompletionRegistryForTesting()
  __resetExperimentalPythonFlagForTesting()
  __resetPythonRuntimeGenerationsForTesting()
  bindPythonRuntimeGeneration("demo", "generation-1")
})

describe("adaptPluginCompletionProvider", () => {
  it("namespaces the id and tags suggestions as plugin-sourced", async () => {
    const getCompletions = jest.fn(() => [
      {
        text: "git status",
        detail: "git",
        description: "Show repository status",
        score: 0.8,
        replace: { from: 0, insert: "git status" },
      },
    ])
    const host = adaptPluginCompletionProvider(
      "my-plugin",
      { id: "fig", label: "Fig", priority: 30 },
      { getCompletions }
    )
    expect(host.id).toBe("my-plugin:fig")
    expect(host.priority).toBe(30)
    const out = await host.getCompletions(ctx(), signal)
    expect(getCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        cursor: 1,
        projectId: "project-1",
      }),
      signal
    )
    expect(out).toEqual([
      {
        text: "git status",
        source: "plugin",
        providerId: "my-plugin:fig",
        detail: "git",
        description: "Show repository status",
        score: 0.8,
        replace: { from: 0, insert: "git status" },
      },
    ])
  })

  it("drops malformed items and isolates a throwing provider", async () => {
    const host = adaptPluginCompletionProvider(
      "p",
      { id: "x", label: "X" },
      {
        getCompletions: () => {
          throw new Error("boom")
        },
      }
    )
    expect(await host.getCompletions(ctx(), signal)).toEqual([])
  })
})

describe("registerPluginCompletionProvider", () => {
  it("registers into the host registry and disposes cleanly", () => {
    const off = registerPluginCompletionProvider("p", {
      id: "p:x",
      label: "X",
      getCompletions: async () => [],
    })
    expect(listProviders().map((p) => p.id)).toContain("p:x")
    off()
    expect(listProviders().map((p) => p.id)).not.toContain("p:x")
  })
})

describe("registerTerminalCompletionProvidersForPlugin", () => {
  function manifest(defs: unknown): PluginManifest {
    return {
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      terminalCompletionProviders: defs,
    } as unknown as PluginManifest
  }

  it("rejects a python-backed provider while the experimental flag is off", async () => {
    const res = await registerTerminalCompletionProvidersForPlugin(
      {
        id: "demo",
        name: "Demo",
        version: "1.0.0",
        type: "python",
        pythonMain: "main.py",
        terminalCompletionProviders: [{ id: "py", label: "Py" }],
      } as unknown as PluginManifest,
      "/root",
      { importer: jest.fn() }
    )

    expect(res.registered).toBe(0)
    expect(res.errors[0]!.message).toMatch(/experimental and the flag is off/)
  })

  it("registers a python-backed provider without importing any JS", async () => {
    setExperimentalPythonBackedEnabled(true)
    const importer = jest.fn()
    const res = await registerTerminalCompletionProvidersForPlugin(
      {
        id: "demo",
        name: "Demo",
        version: "1.0.0",
        type: "python",
        pythonMain: "main.py",
        terminalCompletionProviders: [{ id: "py", label: "Py" }],
      } as unknown as PluginManifest,
      "/root",
      { importer }
    )

    expect(res).toEqual({ registered: 1, errors: [] })
    expect(importer).not.toHaveBeenCalled()
    expect(listProviders().some((p) => p.id === "demo:py")).toBe(true)
    unregisterTerminalCompletionProvidersForPlugin("demo")
  })

  it("reports a JS-backed provider that omits entry/export", async () => {
    const res = await registerTerminalCompletionProvidersForPlugin(
      manifest([{ id: "broken", label: "Broken" }]),
      "/root",
      { importer: jest.fn() }
    )

    expect(res.registered).toBe(0)
    expect(res.errors[0]!.message).toMatch(/must declare both "entry" and "export"/)
  })

  it("lazy-loads declared providers and registers them", async () => {
    const importer = async () => ({
      makeProvider: () => ({
        getCompletions: () => [{ text: "git push origin" }],
      }),
    })
    const res = await registerTerminalCompletionProvidersForPlugin(
      manifest([{ id: "gh", label: "GitHub", entry: "src/c.js", export: "makeProvider" }]),
      "/root",
      { importer }
    )
    expect(res.registered).toBe(1)
    expect(res.errors).toEqual([])
    const out = await getCompletions({ ...ctx(), input: "git " }, signal)
    expect(out[0]).toMatchObject({
      text: "git push origin",
      source: "plugin",
      providerId: "demo:gh",
    })
  })

  it("records an error when the export is missing, without throwing", async () => {
    const importer = async () => ({})
    const res = await registerTerminalCompletionProvidersForPlugin(
      manifest([{ id: "bad", label: "Bad", entry: "src/c.js", export: "nope" }]),
      "/root",
      { importer }
    )
    expect(res.registered).toBe(0)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].providerId).toBe("bad")
  })

  it("records an error when the factory returns a non-provider", async () => {
    const importer = async () => ({ makeProvider: () => ({ notACompletion: true }) })
    const res = await registerTerminalCompletionProvidersForPlugin(
      manifest([{ id: "weird", label: "Weird", entry: "c.js", export: "makeProvider" }]),
      "/root",
      { importer }
    )
    expect(res.registered).toBe(0)
    expect(res.errors[0].providerId).toBe("weird")
  })

  it("no-ops for a manifest with no providers", async () => {
    const res = await registerTerminalCompletionProvidersForPlugin(manifest(undefined), "/root", {})
    expect(res).toEqual({ registered: 0, errors: [] })
  })

  it("unregisterForPlugin removes all of a plugin's providers", async () => {
    const importer = async () => ({
      makeProvider: () => ({ getCompletions: () => [] }),
    })
    await registerTerminalCompletionProvidersForPlugin(
      manifest([{ id: "a", label: "A", entry: "c.js", export: "makeProvider" }]),
      "/root",
      { importer }
    )
    expect(listProviders().length).toBe(1)
    unregisterTerminalCompletionProvidersForPlugin("demo")
    expect(listProviders().length).toBe(0)
  })

  it("clears prior registrations on re-enable", async () => {
    const importer = async () => ({
      makeProvider: () => ({ getCompletions: () => [] }),
    })
    const m = manifest([{ id: "a", label: "A", entry: "c.js", export: "makeProvider" }])
    await registerTerminalCompletionProvidersForPlugin(m, "/root", { importer })
    await registerTerminalCompletionProvidersForPlugin(m, "/root", { importer })
    expect(listProviders().length).toBe(1)
  })
})
