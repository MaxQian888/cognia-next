import {
  clearDaemonState,
  daemonPaths,
  normalizeProfile,
  readDaemonMeta,
  readDaemonStatus,
  writeDaemonMeta,
  type DaemonStateIo,
} from "./daemon-state"

function memoryIo(files = new Map<string, string>()): DaemonStateIo & {
  files: Map<string, string>
} {
  return {
    files,
    existsSync: (file: string) => files.has(file),
    readFileSync: (file: string) => files.get(file) ?? "",
    writeFileSync: (file: string, data: string) => void files.set(file, data),
    mkdirSync: () => undefined,
    rmSync: (file: string) => void files.delete(file),
  }
}

describe("normalizeProfile", () => {
  it("defaults to one profile and rejects anything path-like", () => {
    // The profile becomes a directory under the CLI home, so a traversal here
    // would let `--profile` write outside it.
    expect(normalizeProfile(undefined)).toBe("default")
    expect(normalizeProfile("  ")).toBe("default")
    expect(normalizeProfile("build-box")).toBe("build-box")
    for (const bad of ["../escape", "a/b", ".", "..", "with space", "semi;colon"]) {
      expect(() => normalizeProfile(bad)).toThrow("--profile")
    }
  })
})

describe("daemonPaths", () => {
  it("keeps every profile's lifecycle files apart", () => {
    const first = daemonPaths("/home/.cognia", "default")
    const second = daemonPaths("/home/.cognia", "build-box")
    expect(first.pidFile).not.toBe(second.pidFile)
    expect(first.root.endsWith("/worker/default")).toBe(true)
    expect(second.root.endsWith("/worker/build-box")).toBe(true)
  })
})

describe("readDaemonStatus", () => {
  it("reports a live daemon with its recorded identity", () => {
    const io = memoryIo()
    const paths = daemonPaths("/home/.cognia", "default")
    writeDaemonMeta(
      paths,
      { pid: 4321, profile: "default", startedAt: 100, argv: ["node"], version: "1.2.3" },
      io
    )

    const status = readDaemonStatus("/home/.cognia", "default", { ...io, isAlive: () => true })

    expect(status).toMatchObject({ running: true, pid: 4321, version: "1.2.3" })
  })

  it("surfaces a stale pidfile instead of reporting a dead daemon as running", () => {
    // A crashed daemon leaves its pidfile behind. Trusting it is how a fleet
    // keeps placing runs on a machine that left hours ago.
    const io = memoryIo()
    const paths = daemonPaths("/home/.cognia", "default")
    writeDaemonMeta(
      paths,
      { pid: 4321, profile: "default", startedAt: 100, argv: [], version: "1.2.3" },
      io
    )

    const status = readDaemonStatus("/home/.cognia", "default", { ...io, isAlive: () => false })

    expect(status.running).toBe(false)
    expect(status.stalePid).toBe(4321)
  })

  it("treats a truncated record as absent rather than throwing", () => {
    const io = memoryIo()
    const paths = daemonPaths("/home/.cognia", "default")
    io.files.set(paths.metaFile, '{"pid":')

    expect(readDaemonMeta(paths, io)).toBeNull()
    expect(readDaemonStatus("/home/.cognia", "default", io).running).toBe(false)
  })

  it("reports not-running once the state is cleared", () => {
    const io = memoryIo()
    const paths = daemonPaths("/home/.cognia", "default")
    writeDaemonMeta(paths, { pid: 1, profile: "default", startedAt: 1, argv: [], version: "1" }, io)
    clearDaemonState(paths, io)

    expect(readDaemonStatus("/home/.cognia", "default", io)).toMatchObject({ running: false })
    expect(io.files.has(paths.pidFile)).toBe(false)
  })
})
