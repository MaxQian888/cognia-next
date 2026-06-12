import path from "node:path"

import {
  formatBytes,
  listCrashReports,
  readCrashReportText,
  resolveCrashLogDirs,
  resolveDataLocalDir,
  sumLogDirBytes,
  type CrashLogFs,
} from "./crash-log-discovery"

function fakeFs(entries: Record<string, string | null>): CrashLogFs {
  const tree = new Map<string, string | null>(Object.entries(entries))
  const sameDir = (a: string, b: string) =>
    path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  return {
    readdirSync: (dir: string) =>
      Array.from(tree.entries())
        .filter(([p]) => sameDir(path.dirname(p), dir))
        .map(([p, content]) => ({
          name: path.basename(p),
          isDirectory: () => content === null,
        })),
    readFileSync: (p: string, _encoding: "utf8") => {
      const content = tree.get(p)
      if (content === null || content === undefined) {
        throw new Error(`ENOENT: ${p}`)
      }
      return content
    },
    statSync: (p: string) => {
      const content = tree.get(p)
      if (content === null || content === undefined) {
        throw new Error(`ENOENT: ${p}`)
      }
      return { size: Buffer.byteLength(content, "utf8") }
    },
  }
}

describe("resolveDataLocalDir", () => {
  it("uses LOCALAPPDATA on Windows", () => {
    expect(
      resolveDataLocalDir("win32", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "/home/x")
    ).toBe("C:\\Users\\x\\AppData\\Local")
  })

  it("falls back to AppData/Local on Windows", () => {
    expect(resolveDataLocalDir("win32", {}, "/home/x")).toBe(
      path.join("/home/x", "AppData", "Local")
    )
  })

  it("uses Library/Application Support on macOS", () => {
    expect(resolveDataLocalDir("darwin", {}, "/home/x")).toBe(
      path.join("/home/x", "Library", "Application Support")
    )
  })

  it("uses XDG_DATA_HOME on Linux", () => {
    expect(resolveDataLocalDir("linux", { XDG_DATA_HOME: "/data" }, "/home/x")).toBe("/data")
  })

  it("falls back to ~/.local/share on Linux", () => {
    expect(resolveDataLocalDir("linux", {}, "/home/x")).toBe(
      path.join("/home/x", ".local", "share")
    )
  })
})

describe("resolveCrashLogDirs", () => {
  it("resolves Cognia crash-reports and logs under data local", () => {
    const dirs = resolveCrashLogDirs("linux", { XDG_DATA_HOME: "/data" }, "/home/x")
    expect(dirs.crashReportsDir).toBe(path.join("/data", "Cognia", "crash-reports"))
    expect(dirs.logsDir).toBe(path.join("/data", "Cognia", "logs"))
  })
})

describe("listCrashReports", () => {
  const dir = "/data/Cognia/crash-reports"

  it("returns an empty array when the directory cannot be read", () => {
    const fs = fakeFs({})
    expect(listCrashReports(dir, fs)).toEqual([])
  })

  it("groups files by stem and enriches from the json sidecar", () => {
    const fs = fakeFs({
      [path.join(dir, "crash-2026-05-25_14-30-00-panic.txt")]: "txt body",
      [path.join(dir, "crash-2026-05-25_14-30-00-panic.json")]:
        '{"capturedAt":"2026-05-25T14:30:00Z","kind":"panic"}',
      [path.join(dir, "crash-2026-05-25_14-30-00-panic.dmp")]: "binary",
      [path.join(dir, "crash-2026-05-25_14-29-00-native.txt")]: "txt body 2",
      [path.join(dir, "crash-2026-05-25_14-29-00-native.json")]:
        '{"capturedAt":"2026-05-25T14:29:00Z","kind":"native"}',
    })
    const reports = listCrashReports(dir, fs)
    expect(reports).toHaveLength(2)
    // newest first
    expect(reports[0].stem).toBe("crash-2026-05-25_14-30-00-panic")
    expect(reports[0].kind).toBe("panic")
    expect(reports[0].hasTxt).toBe(true)
    expect(reports[0].hasJson).toBe(true)
    expect(reports[0].hasDmp).toBe(true)
    expect(reports[1].stem).toBe("crash-2026-05-25_14-29-00-native")
    expect(reports[1].kind).toBe("native")
  })

  it("ignores non-crash files", () => {
    const fs = fakeFs({
      [path.join(dir, "crash-2026-05-25_14-30-00-panic.txt")]: "txt body",
      [path.join(dir, "README.md")]: "# docs",
    })
    const reports = listCrashReports(dir, fs)
    expect(reports).toHaveLength(1)
    expect(reports[0].stem).toBe("crash-2026-05-25_14-30-00-panic")
  })
})

describe("readCrashReportText", () => {
  const dir = "/data/Cognia/crash-reports"

  it("prefers the txt file", () => {
    const fs = fakeFs({
      [path.join(dir, "crash-x.txt")]: "human readable",
      [path.join(dir, "crash-x.json")]: '{"kind":"panic"}',
    })
    expect(readCrashReportText(dir, "crash-x", fs)).toBe("human readable")
  })

  it("falls back to pretty-printed json", () => {
    const fs = fakeFs({
      [path.join(dir, "crash-x.json")]: '{"kind":"panic"}',
    })
    expect(readCrashReportText(dir, "crash-x", fs)).toBe('{\n  "kind": "panic"\n}')
  })

  it("returns null when no report exists", () => {
    const fs = fakeFs({})
    expect(readCrashReportText(dir, "crash-x", fs)).toBeNull()
  })

  it("rejects path traversal stems", () => {
    const fs = fakeFs({
      [path.join(dir, "../etc/passwd.txt")]: "oops",
    })
    expect(readCrashReportText(dir, "../etc/passwd", fs)).toBeNull()
  })
})

describe("sumLogDirBytes", () => {
  const dir = "/data/Cognia/logs"

  it("sums only .log files", () => {
    const fs = fakeFs({
      [path.join(dir, "cognia.log")]: "a".repeat(100),
      [path.join(dir, "cognia_2026-05-25.log")]: "b".repeat(200),
      [path.join(dir, "notes.txt")]: "c".repeat(999),
    })
    expect(sumLogDirBytes(dir, fs)).toBe(300)
  })

  it("returns 0 when the directory cannot be read", () => {
    const fs = fakeFs({})
    expect(sumLogDirBytes(dir, fs)).toBe(0)
  })
})

describe("formatBytes", () => {
  it("formats common sizes", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1024)).toBe("1.0 KB")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB")
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB")
  })
})
