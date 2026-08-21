import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync, type SpawnSyncReturns } from "node:child_process"

import { normalizeProfile } from "./daemon-state"

/**
 * Register the worker daemon to start at login.
 *
 * The semantics are ported from `src-tauri/src/terminal_host_service.rs`, which
 * already solved this for the durable terminal host: a per-user LaunchAgent on
 * macOS, a systemd *user* unit on Linux with an XDG autostart fallback for
 * sessions without systemd, and a logon scheduled task on Windows. None of the
 * three needs root.
 *
 * It is reimplemented here rather than reused because that code ships only
 * inside the desktop app. A machine enrolled purely as a worker has the npm
 * package and nothing else — which is exactly the machine that most needs the
 * daemon to survive a reboot.
 */

export interface ServiceIo {
  platform?: NodeJS.Platform
  homedir?: string
  env?: Record<string, string | undefined>
  mkdirSync?: (dir: string, options: { recursive: true; mode: number }) => void
  writeFileSync?: (file: string, data: string, options: { mode: number }) => void
  rmSync?: (file: string, options: { force: true }) => void
  existsSync?: (file: string) => boolean
  run?: (command: string, args: readonly string[]) => { ok: boolean }
}

export interface ServiceRequest {
  /** Absolute path to the node binary that will host the daemon. */
  execPath: string
  /** Absolute path to the CLI entry script. */
  scriptPath: string
  profile: string
}

export interface ServiceResult {
  installed: boolean
  mechanism: "launchd" | "systemd-user" | "xdg-autostart" | "schtasks"
  path?: string
  label: string
}

function serviceLabel(profile: string): string {
  return profile === "default" ? "com.cognia.worker" : `com.cognia.worker.${profile}`
}

function defaultRun(command: string, args: readonly string[]): { ok: boolean } {
  const result: SpawnSyncReturns<Buffer> = spawnSync(command, [...args], { stdio: "ignore" })
  return { ok: !result.error && result.status === 0 }
}

function io(overrides: ServiceIo) {
  return {
    platform: overrides.platform ?? process.platform,
    homedir: overrides.homedir ?? os.homedir(),
    env: overrides.env ?? process.env,
    mkdirSync: overrides.mkdirSync ?? ((dir, options) => void fs.mkdirSync(dir, options)),
    writeFileSync:
      overrides.writeFileSync ??
      ((file, data, options) => fs.writeFileSync(file, data, { encoding: "utf8", ...options })),
    rmSync: overrides.rmSync ?? ((file, options) => fs.rmSync(file, options)),
    existsSync: overrides.existsSync ?? fs.existsSync,
    run: overrides.run ?? defaultRun,
  }
}

/** Command line the service runs: the daemon in the foreground, supervised by the OS. */
export function serviceArgv(request: ServiceRequest): readonly string[] {
  return [
    request.execPath,
    request.scriptPath,
    "worker",
    "daemon",
    "start",
    "--foreground",
    "--profile",
    request.profile,
  ]
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function shellQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

export function installWorkerService(
  request: ServiceRequest,
  overrides: ServiceIo = {}
): ServiceResult {
  return applyWorkerService(true, request, overrides)
}

export function uninstallWorkerService(
  request: ServiceRequest,
  overrides: ServiceIo = {}
): ServiceResult {
  return applyWorkerService(false, request, overrides)
}

function applyWorkerService(
  enabled: boolean,
  request: ServiceRequest,
  overrides: ServiceIo = {}
): ServiceResult {
  const profile = normalizeProfile(request.profile)
  const label = serviceLabel(profile)
  const fs_ = io(overrides)
  const argv = serviceArgv({ ...request, profile })

  if (fs_.platform === "darwin") {
    const directory = path.join(fs_.homedir, "Library", "LaunchAgents")
    const file = path.join(directory, `${label}.plist`)
    const domain = `gui/${process.getuid?.() ?? 0}`
    // Always boot out first: an install over an existing agent must replace it,
    // and an uninstall must stop the running copy before the plist disappears.
    fs_.run("launchctl", ["bootout", `${domain}/${label}`])
    if (!enabled) {
      if (fs_.existsSync(file)) fs_.rmSync(file, { force: true })
      return { installed: false, mechanism: "launchd", path: file, label }
    }
    fs_.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const programArguments = argv.map((value) => `<string>${xmlEscape(value)}</string>`).join("")
    fs_.writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xmlEscape(label)}</string><key>ProgramArguments</key><array>${programArguments}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n`,
      { mode: 0o600 }
    )
    const bootstrapped = fs_.run("launchctl", ["bootstrap", domain, file])
    if (!bootstrapped.ok) throw new Error(`launchctl could not bootstrap ${label}`)
    return { installed: true, mechanism: "launchd", path: file, label }
  }

  if (fs_.platform === "win32") {
    const taskName = profile === "default" ? "Cognia Worker" : `Cognia Worker (${profile})`
    if (!enabled) {
      fs_.run("schtasks.exe", ["/Delete", "/TN", taskName, "/F"])
      return { installed: false, mechanism: "schtasks", label: taskName }
    }
    const command = argv.map(shellQuote).join(" ")
    const created = fs_.run("schtasks.exe", [
      "/Create",
      "/SC",
      "ONLOGON",
      "/TN",
      taskName,
      "/TR",
      command,
      "/F",
      "/RL",
      "LIMITED",
    ])
    if (!created.ok) throw new Error(`schtasks could not create ${taskName}`)
    return { installed: true, mechanism: "schtasks", label: taskName }
  }

  const configHome = fs_.env.XDG_CONFIG_HOME?.trim() || path.join(fs_.homedir, ".config")
  const unitDirectory = path.join(configHome, "systemd", "user")
  const unitName =
    profile === "default" ? "cognia-worker.service" : `cognia-worker@${profile}.service`
  const unitFile = path.join(unitDirectory, unitName)
  const autostartDirectory = path.join(configHome, "autostart")
  const desktopFile = path.join(
    autostartDirectory,
    profile === "default" ? "cognia-worker.desktop" : `cognia-worker-${profile}.desktop`
  )
  const exec = argv.map(shellQuote).join(" ")

  if (!enabled) {
    fs_.run("systemctl", ["--user", "disable", "--now", unitName])
    for (const file of [unitFile, desktopFile]) {
      if (fs_.existsSync(file)) fs_.rmSync(file, { force: true })
    }
    return { installed: false, mechanism: "systemd-user", path: unitFile, label: unitName }
  }

  fs_.mkdirSync(unitDirectory, { recursive: true, mode: 0o700 })
  fs_.writeFileSync(
    unitFile,
    // `Restart=always`, not `on-failure`: the daemon exits 0 on purpose when a
    // newer CLI is installed and it is idle, and that clean exit is exactly the
    // one that has to bring the new code up. `systemctl stop` still stops it.
    `[Unit]\nDescription=Cognia execution worker (${profile})\n\n[Service]\nType=simple\nExecStart=${exec}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`,
    { mode: 0o600 }
  )
  const systemdOk =
    fs_.run("systemctl", ["--user", "daemon-reload"]).ok &&
    fs_.run("systemctl", ["--user", "enable", "--now", unitName]).ok
  if (systemdOk) {
    // Two autostart mechanisms would start two daemons for one profile.
    if (fs_.existsSync(desktopFile)) fs_.rmSync(desktopFile, { force: true })
    return { installed: true, mechanism: "systemd-user", path: unitFile, label: unitName }
  }

  // Sessions without a systemd user manager (some containers, some desktops)
  // still honour XDG autostart. It has no restart policy, which is why it is
  // the fallback and not the default.
  fs_.mkdirSync(autostartDirectory, { recursive: true, mode: 0o700 })
  fs_.writeFileSync(
    desktopFile,
    `[Desktop Entry]\nType=Application\nName=Cognia Worker (${profile})\nExec=${exec}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`,
    { mode: 0o600 }
  )
  return { installed: true, mechanism: "xdg-autostart", path: desktopFile, label: unitName }
}
