/**
 * @jest-environment node
 */

import {
  detectPlatform,
  detectShellKind,
  filterDetectedShellOptions,
  hostShellOptions,
  platformDefaultShell,
  platformShellOptions,
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

  // Over ws/webrtc the user agent describes the wrong machine — a macOS
  // browser paired to a Linux server would ask it for /bin/zsh.
  it("prefers the host's own default over the user-agent sniff", () => {
    expect(
      resolveDefaultShell({
        hostDefaultShell: "/bin/ash",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
      })
    ).toBe("/bin/ash")
  })

  it("keeps explicit project and user shells above the host default", () => {
    expect(
      resolveDefaultShell({ settingShell: "/usr/bin/fish", hostDefaultShell: "/bin/ash" })
    ).toBe("/usr/bin/fish")
    expect(resolveDefaultShell({ projectShell: "/bin/zsh", hostDefaultShell: "/bin/ash" })).toBe(
      "/bin/zsh"
    )
  })

  it("ignores a blank host default", () => {
    expect(
      resolveDefaultShell({
        hostDefaultShell: "   ",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      })
    ).toBe("/bin/bash")
  })
})

describe("hostShellOptions", () => {
  it("labels a host's shells by family", () => {
    expect(
      hostShellOptions([
        { path: "/bin/bash", kind: "bash" },
        { path: "/usr/bin/fish", kind: "fish" },
      ])
    ).toEqual([
      { value: "/bin/bash", labelKey: "terminal.shellPicker.bash", bin: "bash" },
      { value: "/usr/bin/fish", labelKey: "terminal.shellPicker.fish", bin: "fish" },
    ])
  })

  // A hand-built shell or a Nix store path has no translated name; showing its
  // path beats silently dropping a shell the host actually has.
  it("keeps an unrecognised shell, labelled by its path", () => {
    const [option] = hostShellOptions([{ path: "/nix/store/abc/bin/xonsh", kind: "unknown" }])
    expect(option).toEqual({
      value: "/nix/store/abc/bin/xonsh",
      labelKey: "",
      bin: "/nix/store/abc/bin/xonsh",
    })
  })

  it("drops blanks and duplicates", () => {
    expect(
      hostShellOptions([
        { path: "/bin/bash", kind: "bash" },
        { path: "  ", kind: "sh" },
        { path: "/bin/bash", kind: "bash" },
      ]).map((o) => o.value)
    ).toEqual(["/bin/bash"])
  })

  // The host classifies against shells it can actually launch. Re-deriving the
  // family here from the path would disagree with it — `detectShellKind` calls
  // /bin/ash unknown, which would have hidden Alpine's only shell behind a raw
  // store path instead of labelling it "sh".
  it("trusts the family the host reported over the path", () => {
    expect(hostShellOptions([{ path: "/bin/ash", kind: "sh" }])).toEqual([
      { value: "/bin/ash", labelKey: "terminal.shellPicker.sh", bin: "sh" },
    ])
  })

  it("refuses to invent a label key the picker has no message for", () => {
    expect(hostShellOptions([{ path: "/bin/xonsh", kind: "xonsh" }])).toEqual([
      { value: "/bin/xonsh", labelKey: "", bin: "/bin/xonsh" },
    ])
  })

  // Order is the host's: it puts its default first so the picker needs no
  // re-sort.
  it("preserves the host's order", () => {
    expect(
      hostShellOptions([
        { path: "/bin/sh", kind: "sh" },
        { path: "/bin/bash", kind: "bash" },
      ]).map((o) => o.value)
    ).toEqual(["/bin/sh", "/bin/bash"])
  })
})

describe("platformShellOptions", () => {
  it("offers only Windows shells on Windows", () => {
    const bins = platformShellOptions("windows").map((o) => o.bin)
    expect(bins).toEqual(["pwsh", "powershell", "cmd"])
  })

  it("offers only POSIX shells on macOS (no PowerShell/cmd)", () => {
    const bins = platformShellOptions("macos").map((o) => o.bin)
    expect(bins).toContain("zsh")
    expect(bins).toContain("bash")
    expect(bins).not.toContain("pwsh")
    expect(bins).not.toContain("powershell")
    expect(bins).not.toContain("cmd")
    // zsh is the macOS default, so it leads the list.
    expect(bins[0]).toBe("zsh")
  })

  it("offers POSIX shells on Linux led by bash", () => {
    expect(platformShellOptions("linux").map((o) => o.bin)[0]).toBe("bash")
  })

  it("falls back to sh for unknown platforms", () => {
    expect(platformShellOptions("other").map((o) => o.value)).toEqual(["/bin/sh"])
  })

  it("every option carries a shellPicker label key", () => {
    for (const opt of platformShellOptions("macos")) {
      expect(opt.labelKey.startsWith("terminal.shellPicker.")).toBe(true)
    }
  })
})

describe("filterDetectedShellOptions", () => {
  const macos = platformShellOptions("macos")

  it("keeps the full list when nothing is detected (detection unavailable)", () => {
    expect(filterDetectedShellOptions(macos, new Set())).toHaveLength(macos.length)
  })

  it("narrows to the detected shells", () => {
    const kept = filterDetectedShellOptions(macos, new Set(["zsh", "bash"]))
    expect(kept.map((o) => o.bin)).toEqual(["zsh", "bash"])
  })

  it("matches case-insensitively", () => {
    const kept = filterDetectedShellOptions(macos, new Set(["zsh"]))
    expect(kept.map((o) => o.bin)).toEqual(["zsh"])
  })

  it("keeps the full list rather than emptying the menu when nothing matches", () => {
    const kept = filterDetectedShellOptions(macos, new Set(["does-not-exist"]))
    expect(kept).toHaveLength(macos.length)
  })
})
