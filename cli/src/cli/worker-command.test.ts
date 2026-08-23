import type { WorkerWorkspaceClient } from "../worker/workspace-client"
import type { collectWorkerDaemonGarbage, startWorkerDaemon } from "../worker/daemon"
import type { OutputSink } from "./output"
import { parseArgv } from "./args"
import { workerCommand } from "./worker-command"

function sink() {
  const stdout: string[] = []
  const stderr: string[] = []
  const out: OutputSink = {
    write: (value) => stdout.push(value),
    error: (value) => stderr.push(value),
    json: (value) => stdout.push(`${JSON.stringify(value)}\n`),
  }
  return { out, stdout, stderr }
}

function client(): jest.Mocked<WorkerWorkspaceClient> {
  return {
    bind: jest.fn(),
    list: jest.fn(),
    remove: jest.fn(),
    resolve: jest.fn(),
    begin: jest.fn(),
  }
}

describe("workerCommand", () => {
  it("binds a repository through the Task Workspace authority", async () => {
    const output = sink()
    const workspace = client()
    workspace.bind.mockResolvedValue({
      bindingRef: "repository:project-1:repo-1",
      sourceRoot: "/work/repo",
      gitCommonDir: "/work/repo/.git",
      repositoryFingerprint: "sha256:test",
      createdAt: 1,
      updatedAt: 1,
    })

    const code = await workerCommand(
      parseArgv([
        "worker",
        "bind",
        "--repository-ref",
        "repository:project-1:repo-1",
        "--path",
        "/work/repo",
        "--json",
      ]),
      { out: output.out, workspace }
    )

    expect(code).toBe(0)
    expect(workspace.bind).toHaveBeenCalledWith("repository:project-1:repo-1", "/work/repo")
    expect(output.stdout.join("")).toContain("repository:project-1:repo-1")
  })

  it("lists and removes bindings without accepting remote paths", async () => {
    const output = sink()
    const workspace = client()
    workspace.list.mockResolvedValue([])
    workspace.remove.mockResolvedValue({ removed: true })

    await workerCommand(parseArgv(["worker", "list", "--json"]), {
      out: output.out,
      workspace,
    })
    await workerCommand(
      parseArgv(["worker", "remove", "--repository-ref", "repository:project-1:repo-1", "--json"]),
      { out: output.out, workspace }
    )

    expect(workspace.list).toHaveBeenCalled()
    expect(workspace.remove).toHaveBeenCalledWith("repository:project-1:repo-1")
  })

  it("connects with the paired worker identity and existing Task Workspace client", async () => {
    const workspace = client()
    const connect = jest.fn().mockResolvedValue(undefined)
    const runtimeConfig = { providers: {} } as never

    await expect(
      workerCommand(parseArgv(["worker", "connect", "--config", "/secure/worker.json"]), {
        workspace,
        connect,
        loadConfig: () => runtimeConfig,
        env: { COGNIA_HOME: "/worker-home" },
      })
    ).resolves.toBe(0)

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceConfigPath: "/secure/worker.json",
        runtimeConfig,
        home: "/worker-home",
        workspace,
        maxActiveTurns: 1,
      })
    )
  })

  it("enrolls a least-privilege worker identity into an owner-only config file", async () => {
    const output = sink()
    const enroll = jest.fn().mockResolvedValue({ deviceId: "worker-a" })

    await expect(
      workerCommand(
        parseArgv([
          "worker",
          "enroll",
          "--server-url",
          "https://brain.example",
          "--tenant-id",
          "tenant-a",
          "--enrollment",
          "one-time",
          "--config",
          "/secure/worker.json",
          "--json",
        ]),
        { workspace: client(), enroll, out: output.out }
      )
    ).resolves.toBe(0)

    expect(enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://brain.example",
        tenantId: "tenant-a",
        enrollment: "one-time",
        deviceConfigPath: "/secure/worker.json",
      })
    )
    expect(output.stdout.join("")).toContain('"deviceId":"worker-a"')
  })
})

describe("workerCommand daemon", () => {
  const base = { home: "/home/.cognia" }

  function deps(overrides: Record<string, unknown> = {}) {
    const output = sink()
    return {
      output,
      deps: {
        out: output.out,
        workspace: client(),
        env: { COGNIA_HOME: base.home },
        homedir: "/home",
        loadConfig: (() => ({}) as never) as never,
        ...overrides,
      },
    }
  }

  it("starts a background daemon and prints the pid it claimed", async () => {
    const start = jest
      .fn<ReturnType<typeof startWorkerDaemon>, Parameters<typeof startWorkerDaemon>>()
      .mockResolvedValue({
        started: true,
        alreadyRunning: false,
        pid: 4242,
        profile: "default",
        logFile: "/home/.cognia/worker/default/daemon.log",
      })
    const harness = deps({ daemon: { start } })

    const code = await workerCommand(
      parseArgv(["worker", "daemon", "start", "--json"]),
      harness.deps as never
    )

    expect(code).toBe(0)
    expect(start.mock.calls[0]?.[0]).toMatchObject({ home: base.home, foreground: false })
    expect(JSON.parse(harness.output.stdout[0]!)).toMatchObject({ pid: 4242 })
  })

  it("exits non-zero when a daemon already owns the profile", async () => {
    const start = jest
      .fn<ReturnType<typeof startWorkerDaemon>, Parameters<typeof startWorkerDaemon>>()
      .mockResolvedValue({
        started: false,
        alreadyRunning: true,
        pid: 99,
        profile: "build-box",
        logFile: "/log",
      })
    const harness = deps({ daemon: { start } })

    const code = await workerCommand(
      parseArgv(["worker", "daemon", "start", "--profile", "build-box"]),
      harness.deps as never
    )

    expect(code).toBe(1)
    expect(harness.output.stderr.join("")).toContain("already running")
  })

  it("passes an abort signal only to a foreground daemon", async () => {
    // The foreground process is the one the OS supervisor signals; the launcher
    // returns immediately and must not install handlers it will never use.
    const start = jest
      .fn<ReturnType<typeof startWorkerDaemon>, Parameters<typeof startWorkerDaemon>>()
      .mockResolvedValue({
        started: true,
        alreadyRunning: false,
        pid: 1,
        profile: "default",
        logFile: "/log",
      })
    const harness = deps({ daemon: { start } })

    await workerCommand(
      parseArgv(["worker", "daemon", "start", "--foreground"]),
      harness.deps as never
    )
    expect(start.mock.calls[0]?.[0]).toMatchObject({ foreground: true })
    expect((start.mock.calls[0]?.[0] as { signal?: AbortSignal }).signal).toBeInstanceOf(
      AbortSignal
    )

    await workerCommand(parseArgv(["worker", "daemon", "start"]), harness.deps as never)
    expect((start.mock.calls[1]?.[0] as { signal?: AbortSignal }).signal).toBeUndefined()
  })

  it("reports status and exits non-zero when nothing is running", async () => {
    const status = jest.fn(() => ({
      running: false,
      profile: "default",
      logFile: "/log",
    }))
    const harness = deps({ daemon: { status } })

    const code = await workerCommand(
      parseArgv(["worker", "daemon", "status", "--json"]),
      harness.deps as never
    )

    expect(code).toBe(1)
    expect(JSON.parse(harness.output.stdout[0]!)).toMatchObject({ running: false })
  })

  it("stops a daemon and reports whether one was there", async () => {
    const stop = jest.fn(async () => ({ stopped: true, pid: 7, profile: "default" }))
    const harness = deps({ daemon: { stop } })

    const code = await workerCommand(
      parseArgv(["worker", "daemon", "stop", "--json"]),
      harness.deps as never
    )

    expect(code).toBe(0)
    expect(stop).toHaveBeenCalledWith(base.home, undefined)
  })

  it("prints raw log lines by default and structured output with --json", async () => {
    const logs = jest.fn(() => ({ file: "/log", lines: ["first", "second"] }))
    const plain = deps({ daemon: { logs } })

    await workerCommand(parseArgv(["worker", "daemon", "logs", "-n", "2"]), plain.deps as never)
    expect(plain.output.stdout.join("")).toBe("first\nsecond\n")
    expect(logs).toHaveBeenCalledWith(base.home, undefined, 2)

    const structured = deps({ daemon: { logs } })
    await workerCommand(parseArgv(["worker", "daemon", "logs", "--json"]), structured.deps as never)
    expect(JSON.parse(structured.output.stdout[0]!)).toMatchObject({ lines: ["first", "second"] })
    expect(logs).toHaveBeenLastCalledWith(base.home, undefined, 200)
  })

  it("reclaims disk under the CLI home", async () => {
    const gc = jest
      .fn<
        ReturnType<typeof collectWorkerDaemonGarbage>,
        Parameters<typeof collectWorkerDaemonGarbage>
      >()
      .mockReturnValue({ removedLogs: ["/log.1"], removedWorkspaces: [] })
    const harness = deps({ daemon: { gc } })

    const code = await workerCommand(
      parseArgv(["worker", "daemon", "gc", "--json"]),
      harness.deps as never
    )

    expect(code).toBe(0)
    expect(gc.mock.calls[0]?.[2]).toMatchObject({ ttlMs: expect.any(Number) })
  })

  it("rejects an unknown daemon action with the usage exit code", async () => {
    const harness = deps()

    const code = await workerCommand(
      parseArgv(["worker", "daemon", "restart"]),
      harness.deps as never
    )

    expect(code).toBe(2)
    expect(harness.output.stderr.join("")).toContain("start|stop|status|logs|gc")
  })
})

describe("workerCommand service", () => {
  it("installs and uninstalls the login service for a profile", async () => {
    const output = sink()
    const install = jest.fn(() => ({ installed: true, mechanism: "launchd", label: "x" }))
    const uninstall = jest.fn(() => ({ installed: false, mechanism: "launchd", label: "x" }))
    const deps = {
      out: output.out,
      workspace: client(),
      env: { COGNIA_HOME: "/home/.cognia" },
      homedir: "/home",
      service: { install, uninstall },
      execPath: "/usr/bin/node",
      scriptPath: "/cli.js",
    }

    expect(
      await workerCommand(
        parseArgv(["worker", "service", "install", "--profile", "ci", "--json"]),
        deps as never
      )
    ).toBe(0)
    expect(install).toHaveBeenCalledWith({
      execPath: "/usr/bin/node",
      scriptPath: "/cli.js",
      profile: "ci",
    })

    expect(await workerCommand(parseArgv(["worker", "service", "uninstall"]), deps as never)).toBe(
      0
    )
    expect(uninstall).toHaveBeenCalled()
  })

  it("rejects an unknown service action", async () => {
    const output = sink()
    const code = await workerCommand(parseArgv(["worker", "service", "status"]), {
      out: output.out,
      workspace: client(),
    } as never)

    expect(code).toBe(2)
    expect(output.stderr.join("")).toContain("install|uninstall")
  })
})
