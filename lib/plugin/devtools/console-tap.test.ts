import { installConsoleTap, uninstallConsoleTap, isConsoleTapInstalled } from "./console-tap"
import { clearDebugLogs, getDebugLogs, isDebugEnabled, setDebugMode } from "./dev-tools"

beforeEach(() => {
  uninstallConsoleTap()
  clearDebugLogs()
  setDebugMode(false)
})

afterEach(() => {
  uninstallConsoleTap()
  clearDebugLogs()
})

function makeFakeConsole() {
  const calls: Array<{ level: string; args: unknown[] }> = []
  return {
    calls,
    fake: {
      log: (...args: unknown[]) => calls.push({ level: "log", args }),
      info: (...args: unknown[]) => calls.push({ level: "info", args }),
      warn: (...args: unknown[]) => calls.push({ level: "warn", args }),
      error: (...args: unknown[]) => calls.push({ level: "error", args }),
      debug: (...args: unknown[]) => calls.push({ level: "debug", args }),
    },
  }
}

describe("installConsoleTap", () => {
  it("isConsoleTapInstalled returns false before install", () => {
    expect(isConsoleTapInstalled()).toBe(false)
  })

  it("captures console.log and routes it through debugLog", () => {
    const { fake, calls } = makeFakeConsole()
    installConsoleTap({ consoleOverride: fake })
    fake.log("hello world", { foo: 1 })
    const entries = getDebugLogs()
    expect(entries[entries.length - 1]).toMatchObject({
      level: "info",
      category: "console",
      message: "hello world",
      pluginId: "browser",
    })
    // Forwards to the underlying console too.
    expect(calls).toHaveLength(1)
  })

  it("maps each console level to the matching debug level", () => {
    const { fake } = makeFakeConsole()
    installConsoleTap({ consoleOverride: fake })
    fake.info("an info")
    fake.warn("a warn")
    fake.error("an error")
    fake.debug("a debug")
    const levels = getDebugLogs().map((e) => e.level)
    expect(levels).toEqual(expect.arrayContaining(["info", "warn", "error", "debug"]))
  })

  it("uses the provided pluginId tag", () => {
    const { fake } = makeFakeConsole()
    installConsoleTap({ consoleOverride: fake, pluginId: "custom-id" })
    fake.log("tagged")
    expect(getDebugLogs()[getDebugLogs().length - 1].pluginId).toBe("custom-id")
  })

  it("enables debug mode by default + restores previous state on uninstall", () => {
    expect(isDebugEnabled()).toBe(false)
    const { fake } = makeFakeConsole()
    installConsoleTap({ consoleOverride: fake })
    expect(isDebugEnabled()).toBe(true)
    expect(isConsoleTapInstalled()).toBe(true)
    uninstallConsoleTap()
    expect(isConsoleTapInstalled()).toBe(false)
    expect(isDebugEnabled()).toBe(false)
  })

  it("leaves an externally-enabled debug mode untouched after uninstall", () => {
    setDebugMode(true)
    const { fake } = makeFakeConsole()
    installConsoleTap({ consoleOverride: fake })
    uninstallConsoleTap()
    expect(isDebugEnabled()).toBe(true)
  })

  it("uninstall restores the original console methods on the supplied object", () => {
    const { fake } = makeFakeConsole()
    const originalLog = fake.log
    installConsoleTap({ consoleOverride: fake })
    expect(fake.log).not.toBe(originalLog)
    uninstallConsoleTap()
    expect(fake.log).toBe(originalLog)
  })

  it("second install is a no-op while one tap is already installed", () => {
    const { fake } = makeFakeConsole()
    installConsoleTap({ consoleOverride: fake })
    const wrappedLog = fake.log
    installConsoleTap({ consoleOverride: fake, pluginId: "second" })
    expect(fake.log).toBe(wrappedLog) // unchanged
  })

  it("a throwing argument doesn't kill the tap — original console still fires", () => {
    const { fake, calls } = makeFakeConsole()
    installConsoleTap({ consoleOverride: fake })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    fake.log(cyclic)
    expect(calls).toHaveLength(1)
  })
})
