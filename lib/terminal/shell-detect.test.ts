/**
 * @jest-environment node
 */

import {
  detectPlatform,
  detectShellKind,
  platformDefaultShell,
  resolveDefaultShell,
} from "./shell-detect"

describe("detectPlatform", () => {
  it("detects Windows UA", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows")
  })

  it("detects macOS UA", () => {
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("macos")
  })

  it("detects Linux UA", () => {
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux")
  })

  it("falls back to other on unknown UA", () => {
    expect(detectPlatform("CustomBot/1.0")).toBe("other")
  })

  it("is case-insensitive", () => {
    expect(detectPlatform("WINDOWS NT 11.0")).toBe("windows")
  })
})

describe("platformDefaultShell", () => {
  it.each([
    ["windows", "pwsh.exe"],
    ["macos", "/bin/zsh"],
    ["linux", "/bin/bash"],
    ["other", "/bin/sh"],
  ] as const)("returns the expected default for %s", (platform, expected) => {
    expect(platformDefaultShell(platform)).toBe(expected)
  })
})

describe("detectShellKind", () => {
  it.each([
    ["/bin/bash", "bash"],
    ["/usr/bin/zsh", "zsh"],
    ["/bin/sh", "sh"],
    ["/usr/bin/dash", "sh"],
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "pwsh"],
    ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "powershell"],
    ["C:\\Windows\\System32\\cmd.exe", "cmd"],
    ["/usr/local/bin/fish", "fish"],
    ["/usr/bin/nu", "nu"],
    ["nushell", "nu"],
    ["/usr/bin/elvish", "unknown"],
    ["", "unknown"],
  ] as const)("classifies %s as %s", (path, kind) => {
    expect(detectShellKind(path)).toBe(kind)
  })
})

describe("resolveDefaultShell", () => {
  it("prefers projectShell when set", () => {
    expect(
      resolveDefaultShell({
        projectShell: "/usr/local/bin/fish",
        settingShell: "/bin/zsh",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
      })
    ).toBe("/usr/local/bin/fish")
  })

  it("falls through to settingShell when projectShell is empty", () => {
    expect(
      resolveDefaultShell({
        projectShell: "   ",
        settingShell: "/bin/zsh",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      })
    ).toBe("/bin/zsh")
  })

  it("falls through to platform default when both overrides are unset", () => {
    expect(
      resolveDefaultShell({
        userAgent: "Mozilla/5.0 (Windows NT 10.0)",
      })
    ).toBe("pwsh.exe")
  })

  it("treats an empty-string override as unset", () => {
    expect(
      resolveDefaultShell({
        projectShell: "",
        settingShell: "",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      })
    ).toBe("/bin/bash")
  })
})
