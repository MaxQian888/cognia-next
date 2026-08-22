/** @jest-environment node */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

import { EXTERNAL_AGENT_RUNTIMES } from "@/lib/ai/agent/external/runtime-catalog"

import type { AgentPathRuntime } from "./agent-path"
import {
  isPackageRunner,
  probeRuntimeVersion,
  resolveProbeExecutable,
  type ProbeRuntimeVersionDeps,
} from "./version-probe"

const runtime: AgentPathRuntime = {
  platform: "linux",
  home: "/home/u",
  env: { PATH: "/usr/bin" },
}

/** A child that behaves like a spawned probe, driven from the test. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    pid: number
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 4242
  return child
}

function withChild(child: ReturnType<typeof fakeChild>): ProbeRuntimeVersionDeps {
  return {
    runtime,
    spawnFn: (() => child) as unknown as ProbeRuntimeVersionDeps["spawnFn"],
  }
}

/** Let the stream `data` handlers run before the process closes. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

describe("isPackageRunner", () => {
  it("recognizes the runners across platform spellings", () => {
    for (const command of ["npx", "npx.cmd", "/usr/local/bin/npx", "uvx", "bunx", "pnpx"]) {
      expect(isPackageRunner(command)).toBe(true)
    }
    for (const command of ["codex", "cursor-agent", "droid.exe"]) {
      expect(isPackageRunner(command)).toBe(false)
    }
  })
})

describe("resolveProbeExecutable", () => {
  it("returns null for an empty command", () => {
    expect(resolveProbeExecutable("   ", runtime)).toBeNull()
  })

  it("returns null for an explicit path that does not exist", () => {
    expect(resolveProbeExecutable("/nowhere/at/all/codex", runtime)).toBeNull()
  })

  it("accepts an explicit path that does exist", () => {
    expect(resolveProbeExecutable(process.execPath, runtime)).toBe(process.execPath)
  })

  it("finds a bare command on the search path", () => {
    const dir = process.execPath.slice(0, process.execPath.lastIndexOf("/"))
    const name = process.execPath.slice(process.execPath.lastIndexOf("/") + 1)
    expect(resolveProbeExecutable(name, { ...runtime, env: { PATH: dir } })).toBe(process.execPath)
  })
})

describe("probeRuntimeVersion", () => {
  it("refuses an id the catalog does not govern", async () => {
    await expect(probeRuntimeVersion("not-a-runtime")).rejects.toThrow("unknown runtime")
  })

  it("reports a remote runtime as having no probe, not as missing", async () => {
    // `output: null` reads as "missing" to the certification policy, and a
    // remote runtime was never meant to exist locally.
    const probe = await probeRuntimeVersion("opencode-remote")
    expect(probe.output).toBeNull()
    expect(probe.detail).toContain("declares no version probe")
  })

  it("reports a managed runtime as having no system command", async () => {
    const probe = await probeRuntimeVersion("deepseek-harness")
    expect(probe.detail).toContain("no system command")
  })

  it("says where it looked when the command is not installed", async () => {
    const probe = await probeRuntimeVersion("kiro-cli", {
      runtime: { ...runtime, env: { PATH: "/definitely/not/here" } },
    })
    expect(probe.output).toBeNull()
    expect(probe.executablePath).toBeNull()
    expect(probe.detail).toContain("not on PATH")
  })

  it("collects stdout and stderr, since several CLIs print the version on stderr", async () => {
    const child = fakeChild()
    const probing = probeRuntimeVersion("codex-app-server", {
      ...withChild(child),
      runtime: { ...runtime, env: { PATH: nodeDir() } },
    })

    child.stdout.write("codex-cli ")
    child.stderr.write("1.2.3\n")
    await flush()
    child.emit("close", 0)

    const probe = await probing
    expect(probe.output).toBe("codex-cli 1.2.3\n")
    expect(probe.exitCode).toBe(0)
    expect(probe.detail).toBeNull()
  })

  it("still returns output on a non-zero exit, so it reads as unparseable", async () => {
    const child = fakeChild()
    const probing = probeRuntimeVersion("codex-app-server", {
      ...withChild(child),
      runtime: { ...runtime, env: { PATH: nodeDir() } },
    })

    child.stderr.write("unknown flag --version\n")
    await flush()
    child.emit("close", 2)

    const probe = await probing
    expect(probe.exitCode).toBe(2)
    expect(probe.output).toContain("unknown flag")
  })

  it("treats a spawn error as an unreadable version, not a missing runtime", async () => {
    const child = fakeChild()
    const probing = probeRuntimeVersion("codex-app-server", {
      ...withChild(child),
      runtime: { ...runtime, env: { PATH: nodeDir() } },
    })

    child.emit("error", new Error("EACCES"))

    const probe = await probing
    expect(probe.output).toBe("")
    expect(probe.detail).toContain("EACCES")
  })

  it("omits the executable digest for a package runner", async () => {
    // The resolved file is `npx`; its digest is not the runtime's identity.
    const child = fakeChild()
    const probing = probeRuntimeVersion("codex-acp", {
      ...withChild(child),
      runtime: { ...runtime, env: { PATH: nodeDir() } },
    })
    child.stdout.write("0.5.0\n")
    await flush()
    child.emit("close", 0)

    // Resolution uses the real filesystem, so this only asserts the rule when
    // `npx` is actually present next to node.
    const probe = await probing
    if (probe.executablePath) expect(probe.executableDigest).toBeNull()
  })

  it("runs the real probe end to end against a trivial process", async () => {
    // No injected spawn: exercises the default runner, the enriched PATH and
    // the close path together.
    const probe = await probeRuntimeVersion("codex-app-server", {
      runtime: { ...runtime, env: { PATH: nodeDir() } },
      spawnFn: undefined,
    })
    // `codex` is not installed in CI; either answer is valid, but a found
    // command must carry a path and a missing one must not.
    expect(probe.output === null).toBe(probe.executablePath === null)
  })

  it("answers for every catalogued runtime, without spawning anything", async () => {
    // A catalog entry this cannot answer for is a governed runtime with no way
    // to read its version on the headless host. An empty search path keeps the
    // sweep hermetic: every command resolves to nothing, so the probe returns
    // its verdict without touching a real CLI.
    const empty = { ...runtime, env: { PATH: "/definitely/not/here" } }
    const failures: string[] = []

    for (const entry of EXTERNAL_AGENT_RUNTIMES) {
      try {
        const probe = await probeRuntimeVersion(entry.runtimeId, { runtime: empty })
        if (probe.output !== null) failures.push(`${entry.runtimeId}: unexpectedly found`)
        if (!probe.detail) failures.push(`${entry.runtimeId}: gave no reason`)
      } catch (error) {
        failures.push(`${entry.runtimeId}: ${String(error)}`)
      }
    }

    expect(failures).toEqual([])
    expect(EXTERNAL_AGENT_RUNTIMES.length).toBeGreaterThanOrEqual(15)
  })
})

function nodeDir(): string {
  return process.execPath.slice(0, process.execPath.lastIndexOf("/"))
}
