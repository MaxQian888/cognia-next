/** @jest-environment jsdom */
// The factory must build its own fns: `lib/plugin/core/logger.ts` calls
// `loggers.plugin.child(...)` at module-init time, which is before any
// top-level `const` in this file has been initialized.
jest.mock("@cognia/logging", () => {
  const logger: Record<string, jest.Mock> = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  }
  // Assigned after the object exists: `child` returns the logger itself, and a
  // self-reference inside the literal leaves TS with no type to infer.
  logger.child.mockImplementation(() => logger)
  return {
    loggers: new Proxy({} as Record<string, unknown>, { get: () => logger }),
    __logger: logger,
  }
})

const { __logger: logger } = jest.requireMock("@cognia/logging") as {
  __logger: {
    debug: jest.Mock
    info: jest.Mock
    warn: jest.Mock
    error: jest.Mock
    child: jest.Mock
  }
}
const { debug, info, warn, error, child } = logger

import { appendPythonEvent } from "@/lib/plugin/python/log-buffer"
import { __resetPythonEventBusForTesting } from "@/lib/plugin/python/event-bus"
import { getPluginDebugger } from "./debugger"
import {
  __resetPluginLogBridgeForTests,
  forwardPluginRuntimeLog,
  installPluginRuntimeLogBridge,
} from "./plugin-log-bridge"

beforeEach(() => {
  jest.clearAllMocks()
  __resetPluginLogBridgeForTests()
  __resetPythonEventBusForTesting()
})

afterEach(() => {
  __resetPluginLogBridgeForTests()
})

describe("forwardPluginRuntimeLog", () => {
  it("tags the entry so the log panel classifies it as the plugin source", () => {
    // `getLogSource()` returns "plugin" only for these two fields, and the
    // detail pane's deep link filters on exactly that facet.
    forwardPluginRuntimeLog({
      id: "e1",
      pluginId: "web-tools",
      runtime: "frontend",
      generation: "3",
      level: "info",
      message: "activated",
      timestamp: 1,
    })

    expect(child).toHaveBeenCalledWith("web-tools")
    expect(info).toHaveBeenCalledWith(
      "activated",
      expect.objectContaining({ runtime: "plugin", origin: "plugin", pluginId: "web-tools" })
    )
  })

  it("keeps the plugin's own runtime on a separate key from the log runtime", () => {
    forwardPluginRuntimeLog({
      id: "e2",
      pluginId: "ocr",
      runtime: "python",
      generation: null,
      level: "info",
      message: "ready",
      timestamp: 1,
    })

    const [, data] = info.mock.calls[0]
    expect(data).toMatchObject({ runtime: "plugin", pluginRuntime: "python" })
  })

  it("routes each level to its own logger method, with error's arity", () => {
    const base = { id: "x", pluginId: "p", runtime: "frontend", generation: null, timestamp: 1 }
    forwardPluginRuntimeLog({ ...base, level: "debug", message: "d" } as never)
    forwardPluginRuntimeLog({ ...base, level: "warn", message: "w" } as never)
    forwardPluginRuntimeLog({ ...base, level: "error", message: "e" } as never)

    expect(debug).toHaveBeenCalledWith("d", expect.any(Object))
    expect(warn).toHaveBeenCalledWith("w", expect.any(Object))
    expect(error).toHaveBeenCalledWith("e", undefined, expect.any(Object))
  })

  it("substitutes the frame kind for an entry that normalizes to no message", () => {
    forwardPluginRuntimeLog({
      id: "e3",
      pluginId: "p",
      runtime: "python",
      generation: null,
      level: "debug",
      message: "",
      timestamp: 1,
      kind: "chunk_end",
    })

    expect(debug).toHaveBeenCalledWith("chunk_end", expect.any(Object))
  })
})

describe("installPluginRuntimeLogBridge", () => {
  it("leaves the frontend ring alone, which is what keeps one line one entry", () => {
    // The ring is only written by `createDebugContext`, which the manager
    // installs for developer mode on a non-builtin plugin. Bridging it would
    // have covered nothing in a default install, and in a debug session it
    // would have double-logged: that same wrapper also calls the plugin's real
    // logger, which is tagged at its source in `lib/plugin/core/context.ts`.
    installPluginRuntimeLogBridge()
    getPluginDebugger().log("web-tools", "warn", "fetch failed")

    expect(warn).not.toHaveBeenCalled()
  })

  it("forwards python host frames off the ingestion bus", () => {
    installPluginRuntimeLogBridge()
    appendPythonEvent({
      pluginId: "ocr",
      kind: "log",
      data: { level: "error", line: "model missing" },
    })

    expect(error).toHaveBeenCalledWith(
      "model missing",
      undefined,
      expect.objectContaining({ origin: "plugin", pluginId: "ocr", pluginRuntime: "python" })
    )
  })

  it("stops forwarding once torn down", () => {
    const stop = installPluginRuntimeLogBridge()
    stop()
    appendPythonEvent({ pluginId: "ocr", kind: "log", data: { level: "info", line: "after" } })

    expect(info).not.toHaveBeenCalled()
  })

  it("does not double-subscribe when installed twice", () => {
    // A StrictMode remount installs before the first teardown runs. Two live
    // subscriptions would write every line to the panel twice.
    installPluginRuntimeLogBridge()
    installPluginRuntimeLogBridge()
    appendPythonEvent({ pluginId: "ocr", kind: "log", data: { level: "info", line: "once" } })

    expect(info).toHaveBeenCalledTimes(1)
  })
})
