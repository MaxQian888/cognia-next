/**
 * Pure, injectable crash-report and native-log discovery for the CLI TUI `/doctor`.
 *
 * Resolves the same `<data_local_dir>/Cognia/crash-reports/` and
 * `<data_local_dir>/Cognia/logs/` directories that the Tauri backend uses,
 * but without requiring the desktop app to be running. All fs effects are
 * injectable so tests can use a fake filesystem.
 */
import path from "node:path"

const APP_DIR_NAME = "Cognia"

export interface CrashLogDirs {
  crashReportsDir: string | null
  logsDir: string | null
}

/** Mirrors `dirs::data_local_dir()` from the Rust `dirs` crate. */
export function resolveDataLocalDir(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  homedir: string
): string | null {
  if (platform === "win32") {
    return env.LOCALAPPDATA ? env.LOCALAPPDATA : path.join(homedir, "AppData", "Local")
  }
  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support")
  }
  // Linux and other Unix: $XDG_DATA_HOME or ~/.local/share
  return env.XDG_DATA_HOME ? env.XDG_DATA_HOME : path.join(homedir, ".local", "share")
}

/** Resolve the directories the Tauri crash/log subsystems write to. */
export function resolveCrashLogDirs(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  homedir: string
): CrashLogDirs {
  const dataLocal = resolveDataLocalDir(platform, env, homedir)
  if (!dataLocal) {
    return { crashReportsDir: null, logsDir: null }
  }
  const base = path.join(dataLocal, APP_DIR_NAME)
  return {
    crashReportsDir: path.join(base, "crash-reports"),
    logsDir: path.join(base, "logs"),
  }
}

export interface CrashReportItem {
  stem: string
  capturedAt?: string
  kind?: "panic" | "native"
  sizeBytes: number
  hasTxt: boolean
  hasJson: boolean
  hasDmp: boolean
}

export interface CrashLogFs {
  readdirSync(dir: string): Array<{ name: string; isDirectory(): boolean }>
  readFileSync(p: string, encoding: "utf8"): string
  statSync(p: string): { size: number }
}

function isCrashReportJson(raw: unknown): raw is { capturedAt?: string; kind?: string } {
  return typeof raw === "object" && raw !== null
}

function parseKind(value: unknown): "panic" | "native" | undefined {
  if (value === "panic" || value === "native") return value
  return undefined
}

/**
 * Scan `crashReportsDir` and group `.txt` / `.json` / `.dmp` files by stem.
 * Returns newest-first (lexicographic descending on the timestamped stem).
 */
export function listCrashReports(crashReportsDir: string, fs: CrashLogFs): CrashReportItem[] {
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = fs.readdirSync(crashReportsDir)
  } catch {
    return []
  }

  const byStem = new Map<string, CrashReportItem>()
  const jsonPaths: Array<{ stem: string; path: string }> = []

  for (const entry of entries) {
    if (entry.isDirectory()) continue
    const name = entry.name
    const ext = path.extname(name).toLowerCase()
    if (![".txt", ".json", ".dmp"].includes(ext)) continue
    const stem = path.basename(name, ext)
    const fullPath = path.join(crashReportsDir, name)

    let size = 0
    try {
      size = fs.statSync(fullPath).size
    } catch {
      // ignore unreadable files
    }

    let item = byStem.get(stem)
    if (!item) {
      item = { stem, sizeBytes: 0, hasTxt: false, hasJson: false, hasDmp: false }
      byStem.set(stem, item)
    }
    item.sizeBytes += size

    if (ext === ".txt") item.hasTxt = true
    if (ext === ".json") {
      item.hasJson = true
      jsonPaths.push({ stem, path: fullPath })
    }
    if (ext === ".dmp") item.hasDmp = true
  }

  // Enrich from JSON sidecars.
  for (const { stem, path: jsonPath } of jsonPaths) {
    try {
      const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as unknown
      if (isCrashReportJson(raw)) {
        const item = byStem.get(stem)
        if (item) {
          item.capturedAt = raw.capturedAt
          item.kind = parseKind(raw.kind)
        }
      }
    } catch {
      // ignore unreadable / invalid sidecars
    }
  }

  const reports = Array.from(byStem.values())
  reports.sort((a, b) => b.stem.localeCompare(a.stem))
  return reports
}

/**
 * Read the human-readable text of a crash report. Prefers the `.txt` file;
 * falls back to pretty-printing the `.json` sidecar.
 */
export function readCrashReportText(
  crashReportsDir: string,
  stem: string,
  fs: CrashLogFs
): string | null {
  if (
    !stem ||
    stem.includes("..") ||
    stem.includes("/") ||
    stem.includes("\\") ||
    stem.includes(":")
  ) {
    return null
  }
  const txtPath = path.join(crashReportsDir, `${stem}.txt`)
  try {
    return fs.readFileSync(txtPath, "utf8")
  } catch {
    // fall through
  }
  const jsonPath = path.join(crashReportsDir, `${stem}.json`)
  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as unknown
    return JSON.stringify(raw, null, 2)
  } catch {
    return null
  }
}

/** Sum the bytes of every `*.log` file in `logsDir`. */
export function sumLogDirBytes(logsDir: string, fs: CrashLogFs): number {
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = fs.readdirSync(logsDir)
  } catch {
    return 0
  }

  let total = 0
  for (const entry of entries) {
    if (entry.isDirectory()) continue
    if (path.extname(entry.name).toLowerCase() !== ".log") continue
    try {
      total += fs.statSync(path.join(logsDir, entry.name)).size
    } catch {
      // ignore unreadable files
    }
  }
  return total
}

/** Format a byte count for human reading (e.g. 1.2 MB). */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
