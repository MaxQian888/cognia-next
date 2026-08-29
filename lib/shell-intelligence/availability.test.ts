import type { TerminalHostCapabilities } from "@/lib/terminal/host-capabilities"
import { resolveShellContext } from "./availability"

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"

const host = (over: Partial<TerminalHostCapabilities> = {}): TerminalHostCapabilities => ({
  platform: "linux",
  defaultShell: "/bin/bash",
  availableShells: [
    { path: "/bin/bash", kind: "bash" },
    { path: "/bin/sh", kind: "sh" },
  ],
  ...over,
})

describe("resolveShellContext precedence", () => {
  it("prefers the user setting over everything", () => {
    const out = resolveShellContext({
      settingShell: "/bin/bash",
      hostCapabilities: host({ defaultShell: "/bin/sh" }),
      hostReachable: true,
      userAgent: MAC_UA,
    })
    expect(out.shell).toMatchObject({ path: "/bin/bash", kind: "bash", source: "setting" })
  })

  it("falls back to the host default when the setting is empty", () => {
    for (const settingShell of [undefined, "", "   ", null]) {
      const out = resolveShellContext({
        settingShell,
        hostCapabilities: host({ defaultShell: "/bin/bash" }),
        hostReachable: true,
        userAgent: MAC_UA,
      })
      expect(out.shell).toMatchObject({ path: "/bin/bash", source: "host-default" })
    }
  })

  it("falls back to the platform default with no host answer at all", () => {
    const out = resolveShellContext({
      hostCapabilities: null,
      hostReachable: false,
      userAgent: MAC_UA,
    })
    expect(out.shell).toMatchObject({ path: "/bin/zsh", kind: "zsh", source: "platform-default" })
  })

  it("takes the family from the host rather than reclassifying the path", () => {
    const out = resolveShellContext({
      settingShell: "/bin/ash",
      hostCapabilities: host({ availableShells: [{ path: "/bin/ash", kind: "sh" }] }),
      hostReachable: true,
    })
    expect(out.shell.kind).toBe("sh")
  })
})

describe("resolveShellContext availability", () => {
  it("is static-only without a host, and still names a usable shell", () => {
    const out = resolveShellContext({ hostReachable: false, userAgent: MAC_UA })
    expect(out.availability).toBe("static-only")
    expect(out.reason).toBe("no-host")
    expect(out.shell.path).toBe("/bin/zsh")
  })

  it("is full when the host has the configured shell", () => {
    const out = resolveShellContext({
      settingShell: "/bin/bash",
      hostCapabilities: host(),
      hostReachable: true,
    })
    expect(out.availability).toBe("full")
    expect(out.reason).toBeUndefined()
  })

  it("reports shell-missing when the host does not have the configured shell", () => {
    const out = resolveShellContext({
      settingShell: "/usr/bin/fish",
      hostCapabilities: host(),
      hostReachable: true,
    })
    expect(out.availability).toBe("shell-unavailable")
    expect(out.reason).toBe("shell-missing")
    // The shell is still resolved — completion keeps working, execution does not.
    expect(out.shell.kind).toBe("fish")
  })

  it("matches a bare shell name against the host's full path", () => {
    const out = resolveShellContext({
      settingShell: "bash",
      hostCapabilities: host(),
      hostReachable: true,
    })
    expect(out.availability).toBe("full")
  })

  it("does not claim a shell is missing when the host listed none", () => {
    const out = resolveShellContext({
      settingShell: "/usr/bin/fish",
      hostCapabilities: host({ availableShells: [] }),
      hostReachable: true,
    })
    expect(out.availability).toBe("full")
  })

  it("never blames the user for a fallback it chose itself", () => {
    // The host default is not in its own list — a host inconsistency, not a
    // user mistake, so it must not surface as "your shell is missing".
    const out = resolveShellContext({
      hostCapabilities: host({ defaultShell: "/bin/weirdsh", availableShells: [] }),
      hostReachable: true,
    })
    expect(out.reason).not.toBe("shell-missing")
  })

  it("keeps an unclassified shell runnable instead of refusing it", () => {
    // ksh/ash/csh/elvish all classify as `unknown`, and `shell-argv` drives
    // them with the universal `-c` form. Refusing here would have taken `!`
    // away from every user of a shell outside the eight named families —
    // the line ran under the host's `sh -c` before this module existed.
    const out = resolveShellContext({
      settingShell: "/opt/exotic/xsh",
      hostCapabilities: host({ availableShells: [{ path: "/opt/exotic/xsh", kind: "xsh" }] }),
      hostReachable: true,
    })
    expect(out.shell.kind).toBe("unknown")
    expect(out.availability).toBe("full")
    expect(out.reason).toBeUndefined()
  })

  it("stays usable when the host is reachable but its capabilities have not landed", () => {
    const out = resolveShellContext({
      settingShell: "/bin/zsh",
      hostCapabilities: null,
      hostReachable: true,
    })
    expect(out.availability).toBe("full")
  })
})
