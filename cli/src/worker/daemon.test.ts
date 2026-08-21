import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  collectWorkerDaemonGarbage,
  readWorkerDaemonLog,
  rotateDaemonLog,
  startWorkerDaemon,
  stopWorkerDaemon,
  workerDaemonStatus,
} from "./daemon"
import { daemonPaths, readDaemonMeta } from "./daemon-state"

const connectOptions = {
  deviceConfigPath: "/tmp/device.json",
  runtimeConfig: {} as never,
  home: "/tmp",
  workspace: {} as never,
}

describe("worker daemon lifecycle", () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-worker-daemon-"))
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("spawns a detached child that outlives the launching shell", async () => {
    // Detached + its own stdio is the entire point: a worker started from a
    // terminal used to die with that terminal, silently removing the machine
    // from the fleet while it still showed as enrolled.
    const unref = jest.fn()
    const spawn = jest.fn(() => ({ pid: 9911, unref }))

    const result = await startWorkerDaemon(
      { home, connectOptions },
      {
        spawn: spawn as never,
        isAlive: () => false,
        execPath: "/usr/bin/node",
        scriptPath: "/cli.js",
      }
    )

    expect(result).toMatchObject({ started: true, pid: 9911, profile: "default" })
    expect(unref).toHaveBeenCalled()
    const [, argv, options] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { detached: boolean },
    ]
    expect(argv).toEqual([
      "/cli.js",
      "worker",
      "daemon",
      "start",
      "--foreground",
      "--profile",
      "default",
    ])
    expect(options.detached).toBe(true)
    expect(readDaemonMeta(daemonPaths(home, "default"))?.pid).toBe(9911)
  })

  it("refuses to start a second daemon for a profile that already has one", async () => {
    const spawn = jest.fn(() => ({ pid: 1, unref: jest.fn() }))
    await startWorkerDaemon(
      { home, connectOptions },
      { spawn: spawn as never, isAlive: () => false }
    )

    const second = await startWorkerDaemon(
      { home, connectOptions },
      { spawn: spawn as never, isAlive: () => true }
    )

    expect(second).toMatchObject({ started: false, alreadyRunning: true })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it("starts over a stale pidfile left by a crash", async () => {
    const spawn = jest.fn(() => ({ pid: 22, unref: jest.fn() }))
    await startWorkerDaemon(
      { home, connectOptions },
      { spawn: spawn as never, isAlive: () => false }
    )

    const restarted = await startWorkerDaemon(
      { home, connectOptions },
      { spawn: spawn as never, isAlive: () => false }
    )

    expect(restarted.started).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it("runs the connection in-process and releases the profile when it ends", async () => {
    const connect = jest.fn(async () => {
      // While connected, the profile is claimed by this process.
      expect(readDaemonMeta(daemonPaths(home, "ci"))?.pid).toBe(4242)
    })

    const result = await startWorkerDaemon(
      { home, profile: "ci", foreground: true, connectOptions, connect },
      { pid: 4242, isAlive: () => false }
    )

    expect(result).toMatchObject({ started: true, pid: 4242, profile: "ci" })
    expect(connect).toHaveBeenCalled()
    expect(readDaemonMeta(daemonPaths(home, "ci"))).toBeNull()
  })

  it("releases the profile even when the connection loop throws", async () => {
    const connect = jest.fn(async () => {
      throw new Error("enrollment revoked")
    })

    await expect(
      startWorkerDaemon(
        { home, foreground: true, connectOptions, connect },
        { pid: 7, isAlive: () => false }
      )
    ).rejects.toThrow("enrollment revoked")
    expect(readDaemonMeta(daemonPaths(home, "default"))).toBeNull()
  })

  it("restarts onto a newer CLI only once the worker goes idle", async () => {
    // npm swaps the files under a running daemon; nothing in Node reloads them,
    // so the fleet would keep executing last month's code forever. The restart
    // is a clean exit that the login service turns into a fresh process.
    const manifest = path.join(home, "package.json")
    fs.writeFileSync(manifest, JSON.stringify({ version: "9.9.9" }))
    let activeTurns = 1
    let aborted = false
    const onVersionRestart = jest.fn()

    const connect = jest.fn(
      async (options: {
        signal?: AbortSignal
        onRuntimeReady?: (probe: { activeTurns(): number }) => void
      }) => {
        options.onRuntimeReady?.({ activeTurns: () => activeTurns })
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => {
            aborted = true
            resolve()
          })
          // Busy first, then quiescent: the watcher must skip the busy window.
          setTimeout(() => {
            activeTurns = 0
          }, 30)
        })
      }
    )

    await startWorkerDaemon(
      {
        home,
        foreground: true,
        connectOptions,
        connect: connect as never,
        driftPollMs: 10,
        onVersionRestart,
      },
      { pid: 500, isAlive: () => false, version: "0.1.0", scriptPath: path.join(home, "cli.js") }
    )

    expect(aborted).toBe(true)
    expect(onVersionRestart).toHaveBeenCalledWith(
      expect.objectContaining({ drifted: true, installed: "9.9.9", running: "0.1.0" })
    )
    expect(readDaemonMeta(daemonPaths(home, "default"))).toBeNull()
  })

  it("does not restart a daemon whose CLI has not moved", async () => {
    fs.writeFileSync(path.join(home, "package.json"), JSON.stringify({ version: "0.1.0" }))
    const onVersionRestart = jest.fn()
    const connect = jest.fn(
      async (options: { onRuntimeReady?: (probe: { activeTurns(): number }) => void }) => {
        options.onRuntimeReady?.({ activeTurns: () => 0 })
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    )

    await startWorkerDaemon(
      {
        home,
        foreground: true,
        connectOptions,
        connect: connect as never,
        driftPollMs: 5,
        onVersionRestart,
      },
      { pid: 501, isAlive: () => false, version: "0.1.0", scriptPath: path.join(home, "cli.js") }
    )

    expect(onVersionRestart).not.toHaveBeenCalled()
  })

  it("stops with SIGTERM and clears the pidfile", async () => {
    const spawn = jest.fn(() => ({ pid: 555, unref: jest.fn() }))
    await startWorkerDaemon(
      { home, connectOptions },
      { spawn: spawn as never, isAlive: () => false }
    )
    const signals: string[] = []
    let alive = true

    const result = await stopWorkerDaemon(home, "default", {
      isAlive: () => alive,
      kill: (_pid, signal) => {
        signals.push(signal)
        alive = false
      },
      now: () => 0,
      sleep: async () => undefined,
    })

    expect(signals).toEqual(["SIGTERM"])
    expect(result).toMatchObject({ stopped: true, pid: 555 })
    expect(result.forced).toBeUndefined()
    expect(readDaemonMeta(daemonPaths(home, "default"))).toBeNull()
  })

  it("kills a daemon that ignores SIGTERM rather than holding the profile forever", async () => {
    const spawn = jest.fn(() => ({ pid: 556, unref: jest.fn() }))
    await startWorkerDaemon(
      { home, connectOptions },
      { spawn: spawn as never, isAlive: () => false }
    )
    const signals: string[] = []
    let clock = 0

    const result = await stopWorkerDaemon(home, "default", {
      isAlive: () => true,
      kill: (_pid, signal) => void signals.push(signal),
      now: () => clock,
      sleep: async () => {
        clock += 1_000
      },
    })

    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(result).toMatchObject({ stopped: true, forced: true })
  })

  it("reports nothing to stop when no daemon was ever started", async () => {
    await expect(stopWorkerDaemon(home, "default")).resolves.toMatchObject({ stopped: false })
  })

  it("reads the tail of the daemon log", () => {
    const paths = daemonPaths(home, "default")
    fs.mkdirSync(paths.root, { recursive: true })
    fs.writeFileSync(paths.logFile, "one\ntwo\nthree\n")

    expect(readWorkerDaemonLog(home, "default", 2).lines).toEqual(["two", "three"])
    expect(readWorkerDaemonLog(home, "missing-profile", 10).lines).toEqual([])
  })

  it("reports a pending version restart in status", async () => {
    // A Windows logon task cannot restart the daemon within a session, so the
    // drift has to be legible to whoever runs `daemon status`.
    fs.writeFileSync(path.join(home, "package.json"), JSON.stringify({ version: "2.0.0" }))
    const spawn = jest.fn(() => ({ pid: 4040, unref: jest.fn() }))
    await startWorkerDaemon(
      { home, connectOptions },
      { spawn: spawn as never, isAlive: () => false, version: "1.0.0" }
    )

    const status = workerDaemonStatus(home, "default", {
      isAlive: () => true,
      scriptPath: path.join(home, "cli.js"),
    })

    expect(status).toMatchObject({ versionDrifted: true, installedVersion: "2.0.0" })
  })

  it("reports status without a daemon and after one starts", async () => {
    expect(workerDaemonStatus(home, "default").running).toBe(false)

    const spawn = jest.fn(() => ({ pid: 31337, unref: jest.fn() }))
    await startWorkerDaemon(
      { home, connectOptions },
      { spawn: spawn as never, isAlive: () => false }
    )

    expect(workerDaemonStatus(home, "default", { isAlive: () => true })).toMatchObject({
      running: true,
      pid: 31337,
    })
  })
})

describe("rotateDaemonLog", () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-worker-log-"))
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("rotates only once the log passes its cap", () => {
    // A worker on a flaky network writes a reconnect line per attempt, forever,
    // on a machine nobody logs into.
    const file = path.join(home, "daemon.log")
    fs.writeFileSync(file, "small")

    expect(rotateDaemonLog(file)).toBe(false)
    expect(rotateDaemonLog(file, { statSync: () => ({ size: 9 * 1024 * 1024 }) })).toBe(true)
    expect(fs.existsSync(`${file}.1`)).toBe(true)
  })

  it("is a no-op for a log that does not exist yet", () => {
    expect(rotateDaemonLog(path.join(home, "absent.log"))).toBe(false)
  })
})

describe("collectWorkerDaemonGarbage", () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-worker-gc-"))
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("removes rotated logs and abandoned workspaces past the TTL, keeping fresh ones", () => {
    // Workspaces are keyed on mtime, not on a manifest: the run that created
    // one may have died with the process that would have cleaned it up.
    const paths = daemonPaths(home, "default")
    fs.mkdirSync(paths.root, { recursive: true })
    fs.writeFileSync(`${paths.logFile}.1`, "old")
    const workspaceRoot = path.join(home, "workspaces")
    fs.mkdirSync(path.join(workspaceRoot, "stale"), { recursive: true })
    fs.mkdirSync(path.join(workspaceRoot, "fresh"), { recursive: true })
    fs.writeFileSync(path.join(workspaceRoot, "loose-file"), "not a workspace")

    const now = 10_000_000
    const result = collectWorkerDaemonGarbage(
      home,
      "default",
      { workspaceRoot, ttlMs: 1_000 },
      {
        now: () => now,
        statSync: (file: string) => ({
          mtimeMs: file.endsWith("fresh") ? now : 0,
          isDirectory: () => !file.endsWith("loose-file"),
        }),
      }
    )

    expect(result.removedLogs).toEqual([`${paths.logFile}.1`])
    expect(result.removedWorkspaces).toEqual([path.join(workspaceRoot, "stale")])
    expect(fs.existsSync(path.join(workspaceRoot, "fresh"))).toBe(true)
  })

  it("keeps a workspace whose TREE is fresh even when its own mtime is stale", () => {
    // A directory's mtime only moves when entries are added or removed
    // DIRECTLY in it, so a checkout a run has been editing for a week — files
    // rewritten in place, objects landing under `.git/` — still looks a week
    // old at the top. Deleting on that alone destroys the workspace the run is
    // executing in, and `rm -rf` succeeds against open files.
    const workspaceRoot = path.join(home, "workspaces")
    const live = path.join(workspaceRoot, "live")
    fs.mkdirSync(path.join(live, ".git", "objects"), { recursive: true })
    fs.writeFileSync(path.join(live, ".git", "objects", "abcd"), "recent")

    const now = 10_000_000
    const result = collectWorkerDaemonGarbage(
      home,
      "default",
      { workspaceRoot, ttlMs: 1_000 },
      {
        now: () => now,
        statSync: (file: string) => ({
          // Only the deepest file is recent; every directory reports stale.
          mtimeMs: file.endsWith("abcd") ? now : 0,
          isDirectory: () => !file.endsWith("abcd"),
        }),
      }
    )

    expect(result.removedWorkspaces).toEqual([])
    expect(fs.existsSync(live)).toBe(true)
  })

  it("returns empty when there is nothing to reclaim", () => {
    expect(collectWorkerDaemonGarbage(home, "default", { ttlMs: 1_000 })).toEqual({
      removedLogs: [],
      removedWorkspaces: [],
    })
  })
})
