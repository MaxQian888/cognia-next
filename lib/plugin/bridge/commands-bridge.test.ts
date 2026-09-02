import type { PluginManifest } from "@/types/plugin/plugin"
import { loggers } from "@/lib/plugin/core/logger"
import {
  __resetCommandsBridgeForTesting,
  buildPythonCommandInvocation,
  dispatchPythonCommand,
  isPythonCommandPlugin,
  listPythonCommandIds,
  normalizePythonCommandOutcome,
  pythonBackedCommandDefs,
  registerCommandsForPlugin,
  unregisterCommandsForPlugin,
} from "./commands-bridge"

function pythonManifest(commands: PluginManifest["commands"]): PluginManifest {
  return { id: "py", type: "python", pythonMain: "main.py", commands } as PluginManifest
}

function jsManifest(type: PluginManifest["type"], commands: PluginManifest["commands"]) {
  return { id: "js", type, commands } as PluginManifest
}

beforeEach(() => {
  __resetCommandsBridgeForTesting()
})

describe("registerCommandsForPlugin", () => {
  it("records a python plugin's manifest commands", () => {
    registerCommandsForPlugin(
      pythonManifest([
        { id: "hello", name: "Hello" },
        { id: "stats", name: "Stats" },
      ])
    )
    expect(isPythonCommandPlugin("py")).toBe(true)
    expect(listPythonCommandIds("py")).toEqual(["hello", "stats"])
  })

  it("is a no-op for an empty or absent field", () => {
    registerCommandsForPlugin(pythonManifest([]))
    registerCommandsForPlugin(pythonManifest(undefined))
    expect(isPythonCommandPlugin("py")).toBe(false)
    expect(listPythonCommandIds("py")).toEqual([])
  })

  it("leaves frontend and hybrid plugins on the JS contract", () => {
    registerCommandsForPlugin(jsManifest("frontend", [{ id: "a", name: "A" }]))
    registerCommandsForPlugin(jsManifest("hybrid", [{ id: "a", name: "A" }]))
    expect(isPythonCommandPlugin("js")).toBe(false)
  })

  it("honours an explicit per-entry backend the way every module bridge does", () => {
    const manifest = jsManifest("hybrid", [
      { id: "js-owned", name: "JS" },
      { id: "py-owned", name: "Py", backend: "python" } as never,
    ])
    expect(pythonBackedCommandDefs(manifest).map((def) => def.id)).toEqual(["py-owned"])
    registerCommandsForPlugin(manifest)
    expect(listPythonCommandIds("js")).toEqual(["py-owned"])
  })

  it("skips malformed entries without an id", () => {
    registerCommandsForPlugin(pythonManifest([{ id: "", name: "x" }, { name: "y" } as never]))
    expect(isPythonCommandPlugin("py")).toBe(false)
  })

  it("re-registration replaces the previous binding", () => {
    registerCommandsForPlugin(pythonManifest([{ id: "old", name: "Old" }]))
    registerCommandsForPlugin(pythonManifest([{ id: "new", name: "New" }]))
    expect(listPythonCommandIds("py")).toEqual(["new"])
    registerCommandsForPlugin(pythonManifest([]))
    expect(isPythonCommandPlugin("py")).toBe(false)
  })

  it("warns when the plugin promises commands but registers no onCommand hook", () => {
    const warn = jest.spyOn(loggers.manager, "warn").mockImplementation(() => {})
    try {
      registerCommandsForPlugin(pythonManifest([{ id: "hello", name: "Hello" }]), {
        hasCommandHook: () => false,
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('@hook("onCommand")'))
      warn.mockClear()
      registerCommandsForPlugin(pythonManifest([{ id: "hello", name: "Hello" }]), {
        hasCommandHook: () => true,
      })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("unregister forgets the plugin", () => {
    registerCommandsForPlugin(pythonManifest([{ id: "hello", name: "Hello" }]))
    unregisterCommandsForPlugin("py")
    expect(isPythonCommandPlugin("py")).toBe(false)
    expect(() => unregisterCommandsForPlugin("py")).not.toThrow()
  })
})

describe("buildPythonCommandInvocation", () => {
  it("copies argv and omits absent context ids", () => {
    const args = ["a", "b"]
    const invocation = buildPythonCommandInvocation("hello", args)
    expect(invocation).toEqual({ command: "hello", args: ["a", "b"] })
    expect(invocation.args).not.toBe(args)
  })

  it("carries the session and character the command was typed in", () => {
    expect(
      buildPythonCommandInvocation("hello", [], { sessionId: "s1", characterId: "c1" })
    ).toEqual({ command: "hello", args: [], sessionId: "s1", characterId: "c1" })
  })
})

describe("normalizePythonCommandOutcome", () => {
  let warn: jest.SpyInstance

  beforeEach(() => {
    warn = jest.spyOn(loggers.manager, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it("maps True to a bare acceptance and False, None to a decline", () => {
    expect(normalizePythonCommandOutcome("py", "x", true)).toEqual({ handled: true })
    expect(normalizePythonCommandOutcome("py", "x", false)).toBeNull()
    expect(normalizePythonCommandOutcome("py", "x", null)).toBeNull()
    expect(normalizePythonCommandOutcome("py", "x", undefined)).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it("keeps a structured acceptance with a string message and object payload", () => {
    expect(
      normalizePythonCommandOutcome("py", "x", {
        handled: true,
        message: "# Report",
        payload: { citations: 3 },
      })
    ).toEqual({ handled: true, message: "# Report", payload: { citations: 3 } })
  })

  it("drops a message or payload of the wrong type instead of forwarding it", () => {
    expect(
      normalizePythonCommandOutcome("py", "x", { handled: true, message: 42, payload: [1] })
    ).toEqual({ handled: true })
  })

  it("treats {handled: false} as a decline", () => {
    expect(normalizePythonCommandOutcome("py", "x", { handled: false, message: "no" })).toBeNull()
  })

  it("declines and warns on an unrecognized shape", () => {
    expect(normalizePythonCommandOutcome("py", "x", "some text")).toBeNull()
    expect(normalizePythonCommandOutcome("py", "x", ["a"])).toBeNull()
    expect(normalizePythonCommandOutcome("py", "x", { message: "no handled flag" })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("/x"))
  })
})

describe("dispatchPythonCommand", () => {
  it("calls the bridged hook with exactly one structured argument", async () => {
    // The manager's python hook bridge packs `args.length <= 1 ? args[0] : args`
    // as the payload, so one argument is what makes the object arrive intact.
    const hook = jest.fn(async () => ({ handled: true, message: "hi" }))
    const result = await dispatchPythonCommand("py", hook, "hello", ["a"], { sessionId: "s1" })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook.mock.calls[0]).toHaveLength(1)
    expect(hook.mock.calls[0][0]).toEqual({ command: "hello", args: ["a"], sessionId: "s1" })
    expect(result).toEqual({ handled: true, message: "hi" })
  })

  it("normalizes the legacy True answer", async () => {
    await expect(dispatchPythonCommand("py", async () => true, "hello", [])).resolves.toEqual({
      handled: true,
    })
  })

  it("propagates a hook failure so the dispatcher can log and keep looking", async () => {
    await expect(
      dispatchPythonCommand(
        "py",
        async () => {
          throw new Error("python-backed hook failed")
        },
        "hello",
        []
      )
    ).rejects.toThrow("python-backed hook failed")
  })
})
