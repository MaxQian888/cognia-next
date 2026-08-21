import {
  installWorkerService,
  serviceArgv,
  uninstallWorkerService,
  type ServiceIo,
} from "./daemon-service"

const request = {
  execPath: "/usr/local/bin/node",
  scriptPath: "/opt/cognia/cli.js",
  profile: "default",
}

function harness(platform: NodeJS.Platform, runOk = true) {
  const written = new Map<string, string>()
  const removed: string[] = []
  const commands: Array<{ command: string; args: readonly string[] }> = []
  const io: ServiceIo = {
    platform,
    homedir: "/home/worker",
    env: {},
    mkdirSync: () => undefined,
    writeFileSync: (file, data) => void written.set(file, data),
    rmSync: (file) => void removed.push(file),
    existsSync: (file) => written.has(file),
    run: (command, args) => {
      commands.push({ command, args })
      return { ok: runOk }
    },
  }
  return { io, written, removed, commands }
}

describe("serviceArgv", () => {
  it("runs the daemon in the foreground so the OS owns supervision", () => {
    // A service that spawned its own detached child would leave the supervisor
    // watching a process that exits immediately, and it would restart forever.
    expect(serviceArgv(request)).toEqual([
      "/usr/local/bin/node",
      "/opt/cognia/cli.js",
      "worker",
      "daemon",
      "start",
      "--foreground",
      "--profile",
      "default",
    ])
  })
})

describe("installWorkerService", () => {
  it("writes a per-user LaunchAgent and bootstraps it on macOS", () => {
    const { io, written, commands } = harness("darwin")

    const result = installWorkerService(request, io)

    expect(result).toMatchObject({ installed: true, mechanism: "launchd" })
    const plist = written.get(result.path!)!
    expect(plist).toContain("<key>Label</key><string>com.cognia.worker</string>")
    expect(plist).toContain("<key>RunAtLoad</key><true/>")
    expect(plist).toContain("<key>KeepAlive</key><true/>")
    expect(plist).toContain("<string>--foreground</string>")
    // Boot out first so an install over an existing agent replaces it.
    expect(commands[0]?.args[0]).toBe("bootout")
    expect(commands.at(-1)?.args[0]).toBe("bootstrap")
  })

  it("escapes a path that would otherwise break the plist XML", () => {
    const { io, written } = harness("darwin")

    const result = installWorkerService({ ...request, scriptPath: '/opt/a&b/"cli".js' }, io)

    const plist = written.get(result.path!)!
    expect(plist).toContain("/opt/a&amp;b/&quot;cli&quot;.js")
    expect(plist).not.toContain('/opt/a&b/"cli".js')
  })

  it("prefers a systemd user unit on Linux and drops the autostart fallback", () => {
    const { io, written, removed, commands } = harness("linux")
    // Pretend a fallback from an earlier install is present.
    written.set("/home/worker/.config/autostart/cognia-worker.desktop", "stale")

    const result = installWorkerService(request, io)

    expect(result).toMatchObject({ installed: true, mechanism: "systemd-user" })
    const unit = written.get("/home/worker/.config/systemd/user/cognia-worker.service")!
    expect(unit).toContain("Restart=always")
    expect(unit).toContain("WantedBy=default.target")
    expect(commands.map((entry) => entry.args[1])).toContain("daemon-reload")
    // Two autostart mechanisms would start two daemons for one profile.
    expect(removed).toContain("/home/worker/.config/autostart/cognia-worker.desktop")
  })

  it("falls back to XDG autostart when there is no systemd user manager", () => {
    const { io, written } = harness("linux", false)

    const result = installWorkerService(request, io)

    expect(result).toMatchObject({ installed: true, mechanism: "xdg-autostart" })
    expect(written.get(result.path!)).toContain("X-GNOME-Autostart-enabled=true")
  })

  it("registers a logon task on Windows", () => {
    const { io, commands } = harness("win32")

    const result = installWorkerService(request, io)

    expect(result).toMatchObject({ installed: true, mechanism: "schtasks", label: "Cognia Worker" })
    expect(commands[0]?.args).toEqual(
      expect.arrayContaining(["/Create", "/SC", "ONLOGON", "/RL", "LIMITED"])
    )
  })

  it("fails loudly rather than reporting an install the OS refused", () => {
    const { io } = harness("darwin", false)

    expect(() => installWorkerService(request, io)).toThrow("launchctl")
  })

  it("names a non-default profile distinctly on every platform", () => {
    const profiled = { ...request, profile: "build-box" }
    expect(installWorkerService(profiled, harness("darwin").io).label).toBe(
      "com.cognia.worker.build-box"
    )
    expect(installWorkerService(profiled, harness("linux").io).label).toBe(
      "cognia-worker@build-box.service"
    )
    expect(installWorkerService(profiled, harness("win32").io).label).toBe(
      "Cognia Worker (build-box)"
    )
  })
})

describe("uninstallWorkerService", () => {
  it("stops and removes the LaunchAgent", () => {
    const { io, written, removed, commands } = harness("darwin")
    const installed = installWorkerService(request, io)
    commands.length = 0
    removed.length = 0

    const result = uninstallWorkerService(request, io)

    expect(result.installed).toBe(false)
    expect(commands[0]?.args[0]).toBe("bootout")
    expect(removed).toContain(installed.path)
    expect(written.has(installed.path!)).toBe(true) // the map is the write log, not the fs
  })

  it("disables the systemd unit and removes both Linux mechanisms", () => {
    const { io, removed, commands } = harness("linux")
    installWorkerService(request, io)
    commands.length = 0

    uninstallWorkerService(request, io)

    expect(commands[0]?.args).toEqual(["--user", "disable", "--now", "cognia-worker.service"])
    expect(removed).toContain("/home/worker/.config/systemd/user/cognia-worker.service")
  })

  it("deletes the Windows logon task", () => {
    const { io, commands } = harness("win32")

    uninstallWorkerService(request, io)

    expect(commands[0]?.args).toEqual(["/Delete", "/TN", "Cognia Worker", "/F"])
  })
})
