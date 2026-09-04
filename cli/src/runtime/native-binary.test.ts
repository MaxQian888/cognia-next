import path from "node:path"

import {
  bundledCandidates,
  defaultNativeCandidates,
  findNativeBinary,
  isExecutable,
  nativeBinaryName,
} from "./native-binary"

describe("nativeBinaryName", () => {
  it("adds the Windows extension and leaves POSIX names alone", () => {
    expect(nativeBinaryName("cognia-sandbox-exec", "win32")).toBe("cognia-sandbox-exec.exe")
    expect(nativeBinaryName("cognia-sandbox-exec", "darwin")).toBe("cognia-sandbox-exec")
    expect(nativeBinaryName("cognia-sandbox-exec", "linux")).toBe("cognia-sandbox-exec")
  })
})

describe("bundledCandidates", () => {
  it("covers both the single-file and the chunks bundle layout", () => {
    const candidates = bundledCandidates("file:///opt/app/chunks/entry.mjs", "helper")
    expect(candidates).toEqual([
      path.join("/opt/app/chunks", "helper"),
      path.join("/opt/app/chunks", "..", "helper"),
    ])
  })
})

describe("defaultNativeCandidates", () => {
  const options = {
    base: "cognia-sandbox-exec",
    envVar: "COGNIA_SANDBOX_EXEC",
    moduleUrl: "file:///opt/app/entry.mjs",
    platform: "linux" as NodeJS.Platform,
    arch: "arm64",
    execPath: "/usr/local/bin/cognia-agent",
    cwd: "/repo",
  }

  it("checks the env override first so an operator can point at a fresh build", () => {
    const candidates = defaultNativeCandidates({
      ...options,
      env: { COGNIA_SANDBOX_EXEC: "/custom/helper" },
    })
    expect(candidates[0]).toBe("/custom/helper")
  })

  it("omits the override when unset rather than emitting an empty candidate", () => {
    const candidates = defaultNativeCandidates({ ...options, env: {} })
    expect(candidates).not.toContain("")
    expect(candidates[0]).toBe(path.join("/opt/app", "cognia-sandbox-exec"))
  })

  it("puts the repo target directories last so a stale debug build never wins", () => {
    const candidates = defaultNativeCandidates({ ...options, env: {} })
    const shipped = candidates.indexOf(path.join("/usr/local/bin", "cognia-sandbox-exec"))
    const debug = candidates.indexOf(path.join("/repo", "target", "debug", "cognia-sandbox-exec"))
    expect(shipped).toBeGreaterThanOrEqual(0)
    expect(debug).toBeGreaterThan(shipped)
  })

  it("applies the platform extension across every candidate", () => {
    const candidates = defaultNativeCandidates({ ...options, platform: "win32", env: {} })
    expect(candidates.every((c) => c.endsWith(".exe"))).toBe(true)
  })

  it("uses the platform-arch directory the CLI stages native helpers into", () => {
    const candidates = defaultNativeCandidates({ ...options, env: {} })
    expect(candidates).toContain(
      path.join("/repo", "cli", "dist", "native", "linux-arm64", "cognia-sandbox-exec")
    )
  })
})

describe("findNativeBinary", () => {
  it("returns the first executable candidate, not the first existing one", () => {
    // A present-but-non-executable file is the same failure as a missing one,
    // and accepting it would surface much later as a spawn error.
    expect(findNativeBinary(["/a", "/b"], (c) => c === "/b")).toBe("/b")
  })

  it("returns undefined when nothing is executable", () => {
    expect(findNativeBinary(["/a", "/b"], () => false)).toBeUndefined()
  })

  it("returns undefined for an empty candidate list", () => {
    expect(findNativeBinary([], () => true)).toBeUndefined()
  })
})

describe("isExecutable", () => {
  it("is false for a path that does not exist", () => {
    expect(isExecutable("/definitely/not/here/cognia-sandbox-exec")).toBe(false)
  })

  it("is true for a real executable on this host", () => {
    // `process.execPath` is the running Node/Bun binary, so it is executable by
    // construction and needs no fixture.
    expect(isExecutable(process.execPath)).toBe(true)
  })
})
