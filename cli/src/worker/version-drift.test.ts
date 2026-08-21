import {
  detectVersionDrift,
  findPackageJson,
  installedVersion,
  watchVersionDrift,
} from "./version-drift"

function io(files: Record<string, string>) {
  return {
    existsSync: (file: string) => file in files,
    readFileSync: (file: string) => files[file] ?? "",
  }
}

describe("findPackageJson", () => {
  it("walks up from the entry script to the package that owns it", () => {
    const files = { "/opt/cognia/package.json": "{}" }
    expect(findPackageJson("/opt/cognia/dist/cli.js", io(files))).toBe("/opt/cognia/package.json")
  })

  it("returns null rather than climbing to the filesystem root forever", () => {
    expect(findPackageJson("/nowhere/at/all/cli.js", io({}))).toBeNull()
  })
})

describe("detectVersionDrift", () => {
  it("reports drift once the installed CLI moves ahead of the running one", () => {
    // The running process keeps executing the old code indefinitely; nothing in
    // Node reloads it, so this is the only signal that a restart is owed.
    const files = { "/opt/cognia/package.json": JSON.stringify({ version: "0.2.0" }) }
    expect(detectVersionDrift("0.1.0", "/opt/cognia/dist/cli.js", io(files))).toEqual({
      drifted: true,
      running: "0.1.0",
      installed: "0.2.0",
    })
  })

  it("reports no drift when the versions match", () => {
    const files = { "/opt/cognia/package.json": JSON.stringify({ version: "0.1.0" }) }
    expect(detectVersionDrift("0.1.0", "/opt/cognia/dist/cli.js", io(files)).drifted).toBe(false)
  })

  it("treats an unreadable manifest as no drift instead of restarting blindly", () => {
    // npm rewrites package.json in place; catching it half-written must not
    // bounce a healthy worker.
    const files = { "/opt/cognia/package.json": "{ truncated" }
    expect(detectVersionDrift("0.1.0", "/opt/cognia/dist/cli.js", io(files))).toMatchObject({
      drifted: false,
      installed: null,
    })
    expect(installedVersion("/nowhere/cli.js", io({}))).toBeNull()
  })
})

describe("watchVersionDrift", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("waits for the worker to go idle before signalling a restart", () => {
    // Restarting mid-turn abandons a run the host already leased here.
    const files = { "/opt/cognia/package.json": JSON.stringify({ version: "0.2.0" }) }
    const onRestartReady = jest.fn()
    let activeTurns = 1
    const dispose = watchVersionDrift({
      runningVersion: "0.1.0",
      scriptPath: "/opt/cognia/dist/cli.js",
      intervalMs: 1_000,
      activeTurns: () => activeTurns,
      onRestartReady,
      io: io(files),
    })

    jest.advanceTimersByTime(3_000)
    expect(onRestartReady).not.toHaveBeenCalled()

    activeTurns = 0
    jest.advanceTimersByTime(1_000)
    expect(onRestartReady).toHaveBeenCalledWith(
      expect.objectContaining({ drifted: true, installed: "0.2.0" })
    )

    // At most once: the caller is already unwinding by now.
    jest.advanceTimersByTime(10_000)
    expect(onRestartReady).toHaveBeenCalledTimes(1)
    dispose()
  })

  it("never fires while the installed version matches", () => {
    const files = { "/opt/cognia/package.json": JSON.stringify({ version: "0.1.0" }) }
    const onRestartReady = jest.fn()
    const dispose = watchVersionDrift({
      runningVersion: "0.1.0",
      scriptPath: "/opt/cognia/dist/cli.js",
      intervalMs: 1_000,
      activeTurns: () => 0,
      onRestartReady,
      io: io(files),
    })

    jest.advanceTimersByTime(60_000)
    expect(onRestartReady).not.toHaveBeenCalled()
    dispose()
  })

  it("stops polling once disposed", () => {
    const files = { "/opt/cognia/package.json": JSON.stringify({ version: "0.2.0" }) }
    const onRestartReady = jest.fn()
    const dispose = watchVersionDrift({
      runningVersion: "0.1.0",
      scriptPath: "/opt/cognia/dist/cli.js",
      intervalMs: 1_000,
      activeTurns: () => 0,
      onRestartReady,
      io: io(files),
    })

    dispose()
    jest.advanceTimersByTime(10_000)
    expect(onRestartReady).not.toHaveBeenCalled()
  })
})
