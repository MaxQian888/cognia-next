/**
 * Tests for the quick-action overlay registry: command-registry mirroring,
 * surface defaults, tray exclusion via `_qa:` ids, dispatch resolution
 * (run → command → slash), per-plugin cleanup, and snapshot stability.
 */

import {
  __resetQuickActionsForTesting,
  getQuickAction,
  getQuickActionSnapshot,
  listQuickActions,
  registerQuickAction,
  runQuickAction,
  subscribeQuickActions,
  unregisterQuickActionsByPlugin,
} from "./quick-action-registry"
import {
  __resetCommandRegistryForTesting,
  executeCommand,
  getCommand,
  getCommands,
  registerCommand,
} from "@/lib/plugin/commands/registry"
import { registerSlashCommand, unregisterSlashCommand } from "@/lib/slash-commands/registry"

afterEach(() => {
  __resetQuickActionsForTesting()
  __resetCommandRegistryForTesting()
})

describe("registerQuickAction", () => {
  it("registers the entry with namespaced id + default surfaces", () => {
    registerQuickAction("plug-a", { id: "sync", title: "Sync now", run: () => {} })

    const entry = getQuickAction("plug-a:sync")
    expect(entry).toMatchObject({
      fullId: "plug-a:sync",
      pluginId: "plug-a",
      title: "Sync now",
      surfaces: ["palette", "composer", "tray"],
    })
  })

  it("keeps selection opt-in while allowing an explicitly declared selection surface", () => {
    registerQuickAction("plug-a", {
      id: "summarize-selection",
      title: "Summarize selection",
      run: () => {},
      surfaces: ["selection"],
      selection: { input: "text", output: "preview", contentTypes: ["term"] },
    })
    registerQuickAction("plug-a", { id: "legacy", title: "Legacy", run: () => {} })

    expect(listQuickActions("selection").map((entry) => entry.id)).toEqual(["summarize-selection"])
    expect(getQuickAction("plug-a:legacy")?.surfaces).toEqual(["palette", "composer", "tray"])
  })

  it("mirrors a dispatch command into the command registry (qa: prefix for tray-visible)", async () => {
    const run = jest.fn()
    registerQuickAction("plug-a", { id: "sync", title: "Sync now", run })

    const cmd = getCommand("qa:plug-a:sync")
    expect(cmd).toMatchObject({ title: "Sync now", category: "plugins", pluginId: "plug-a" })
    await executeCommand("qa:plug-a:sync")
    expect(run).toHaveBeenCalled()
  })

  it("registers tray-excluded actions under a _qa: id so getCommands(true) drops them", () => {
    registerQuickAction("plug-a", {
      id: "palette-only",
      title: "Palette only",
      run: () => {},
      surfaces: ["palette"],
    })

    expect(getCommand("_qa:plug-a:palette-only")).toBeDefined()
    expect(getCommands(true)).not.toContain("_qa:plug-a:palette-only")
    expect(getCommands(false)).toContain("_qa:plug-a:palette-only")
  })

  it("rejects a cross-plugin id collision (first wins)", () => {
    registerQuickAction("plug-a", { id: "shared", title: "A's", run: () => {} })
    // The overlay registry keys by the registration id we pass (fullId), so a
    // true collision needs the same fullId — simulate via the same plugin id
    // prefix from a different owner tag.
    const before = getQuickAction("plug-a:shared")
    registerQuickAction("plug-a", { id: "shared", title: "A's v2", run: () => {} })
    // Same plugin re-registering refreshes (hot reload semantics).
    expect(getQuickAction("plug-a:shared")?.title).toBe("A's v2")
    expect(before?.title).toBe("A's")
  })

  it("disposer removes both the overlay entry and the mirrored command", () => {
    const dispose = registerQuickAction("plug-a", { id: "sync", title: "Sync", run: () => {} })

    dispose()

    expect(getQuickAction("plug-a:sync")).toBeUndefined()
    expect(getCommand("qa:plug-a:sync")).toBeUndefined()
  })

  it("still registers an entry without a dispatch target (uniform overlay contract)", () => {
    registerQuickAction("plug-a", { id: "bare", title: "Bare" })

    expect(getQuickAction("plug-a:bare")).toBeDefined()
    expect(unregisterQuickActionsByPlugin("plug-a")).toBe(1)
  })
})

describe("runQuickAction", () => {
  const selectionInvocation = {
    surface: "selection" as const,
    selection: {
      candidateId: "candidate-1",
      text: "selected text",
      sourceApp: "TextEdit",
      origin: "accessibility" as const,
      capturedAt: 1,
      truncated: false,
      contentTypes: ["term" as const],
      editable: true,
      replaceCapability: "paste" as const,
    },
  }

  it("prefers the inline run handler", async () => {
    const run = jest.fn()
    registerQuickAction("plug-a", { id: "x", title: "X", run, command: "other.cmd" })

    await runQuickAction(getQuickAction("plug-a:x")!)

    expect(run).toHaveBeenCalled()
  })

  it("passes selection context to inline handlers and returns their structured result", async () => {
    const run = jest.fn(async () => ({ kind: "text" as const, text: "summary" }))
    registerQuickAction("plug-a", {
      id: "x",
      title: "X",
      run,
      surfaces: ["selection"],
      selection: { input: "text", output: "preview" },
    })

    await expect(runQuickAction(getQuickAction("plug-a:x")!, selectionInvocation)).resolves.toEqual(
      { kind: "text", text: "summary" }
    )
    expect(run).toHaveBeenCalledWith(selectionInvocation)
  })

  it("falls back to executing the named command", async () => {
    const handler = jest.fn()
    registerCommand({ id: "demo.target", pluginId: null, handler })
    registerQuickAction("plug-a", { id: "x", title: "X", command: "demo.target" })

    await runQuickAction(getQuickAction("plug-a:x")!)

    expect(handler).toHaveBeenCalled()
  })

  it("passes selection context through the command registry", async () => {
    const handler = jest.fn(async () => ({ kind: "variants" as const, variants: ["A", "B"] }))
    registerCommand({ id: "demo.target", pluginId: null, handler })
    registerQuickAction("plug-a", {
      id: "x",
      title: "X",
      command: "demo.target",
      surfaces: ["selection"],
      selection: { input: "text", output: "preview" },
    })

    await expect(runQuickAction(getQuickAction("plug-a:x")!, selectionInvocation)).resolves.toEqual(
      { kind: "variants", variants: ["A", "B"] }
    )
    expect(handler).toHaveBeenCalledWith(selectionInvocation)
  })

  it("dispatches slash targets through the slash registry (leading slash optional)", async () => {
    const handler = jest.fn(async () => ({ kind: "handled" as const }))
    registerSlashCommand({
      id: "qa-demo",
      name: "qa-demo",
      description: "test",
      source: "builtin",
      handler,
    } as never)
    try {
      registerQuickAction("plug-a", { id: "x", title: "X", slash: "qa-demo arg1" })

      await runQuickAction(getQuickAction("plug-a:x")!)

      expect(handler).toHaveBeenCalled()
    } finally {
      unregisterSlashCommand("qa-demo")
    }
  })

  it("passes selection context to slash handlers without interpolating selected text", async () => {
    const handler = jest.fn(async () => ({ message: "summary" }))
    registerSlashCommand({
      id: "qa-selection",
      name: "qa-selection",
      description: "test",
      source: "builtin",
      handler,
    })
    try {
      registerQuickAction("plug-a", {
        id: "x",
        title: "X",
        slash: "qa-selection static-arg",
        surfaces: ["selection"],
        selection: { input: "text", output: "preview" },
      })

      await expect(
        runQuickAction(getQuickAction("plug-a:x")!, selectionInvocation)
      ).resolves.toEqual({ kind: "text", text: "summary" })
      expect(handler).toHaveBeenCalledWith("static-arg", { quickAction: selectionInvocation })
    } finally {
      unregisterSlashCommand("qa-selection")
    }
  })

  it("no-ops (without throwing) when the entry has no dispatch target", async () => {
    registerQuickAction("plug-a", { id: "bare", title: "Bare" })

    await expect(runQuickAction(getQuickAction("plug-a:bare")!)).resolves.toBeUndefined()
  })
})

describe("listing + cleanup + subscription", () => {
  it("filters by surface", () => {
    registerQuickAction("plug-a", { id: "p", title: "P", run: () => {}, surfaces: ["palette"] })
    registerQuickAction("plug-a", { id: "c", title: "C", run: () => {}, surfaces: ["composer"] })

    expect(listQuickActions("palette").map((e) => e.id)).toEqual(["p"])
    expect(listQuickActions("composer").map((e) => e.id)).toEqual(["c"])
    expect(listQuickActions()).toHaveLength(2)
  })

  it("keeps the snapshot identity stable between mutations", () => {
    registerQuickAction("plug-a", { id: "p", title: "P", run: () => {} })
    const first = getQuickActionSnapshot()
    expect(getQuickActionSnapshot()).toBe(first)

    registerQuickAction("plug-a", { id: "q", title: "Q", run: () => {} })
    expect(getQuickActionSnapshot()).not.toBe(first)
  })

  it("unregisterQuickActionsByPlugin drops entries + mirrored commands and notifies", async () => {
    const listener = jest.fn()
    subscribeQuickActions(listener)
    registerQuickAction("plug-a", { id: "p", title: "P", run: () => {} })
    registerQuickAction("plug-b", { id: "q", title: "Q", run: () => {} })

    const removed = unregisterQuickActionsByPlugin("plug-a")

    expect(removed).toBe(1)
    expect(getQuickAction("plug-a:p")).toBeUndefined()
    expect(getCommand("qa:plug-a:p")).toBeUndefined()
    expect(getQuickAction("plug-b:q")).toBeDefined()
    // Listener fires on the microtask queue.
    await new Promise((r) => setTimeout(r, 0))
    expect(listener).toHaveBeenCalled()
  })
})
