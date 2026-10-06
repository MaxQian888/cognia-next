/** @jest-environment node */
import {
  getInstalledExternalAgentHost,
  installExternalAgentHost,
  type InstalledExternalAgentHost,
} from "./installed-host"

function host(kind: string): InstalledExternalAgentHost {
  return {
    kind,
    process: {} as InstalledExternalAgentHost["process"],
    terminals: {} as InstalledExternalAgentHost["terminals"],
    hooks: { run: async () => null, pluginHooks: null },
  }
}

describe("installed external-agent host", () => {
  afterEach(() => {
    // Every test uninstalls what it installed; nothing may leak into the next.
    expect(getInstalledExternalAgentHost()).toBeNull()
  })

  it("is absent in the app, which uses its own transports", () => {
    expect(getInstalledExternalAgentHost()).toBeNull()
  })

  it("installs, is idempotent for the same host, and uninstalls", () => {
    const cli = host("cli")
    const uninstall = installExternalAgentHost(cli)
    expect(getInstalledExternalAgentHost()).toBe(cli)
    const again = installExternalAgentHost(cli)
    expect(getInstalledExternalAgentHost()).toBe(cli)
    again()
    expect(getInstalledExternalAgentHost()).toBeNull()
    uninstall()
  })

  it("refuses a second host, which would split the process table", () => {
    const uninstall = installExternalAgentHost(host("cli"))
    try {
      expect(() => installExternalAgentHost(host("other"))).toThrow(
        /external-agent host \(cli\) is already installed/
      )
      expect(getInstalledExternalAgentHost()?.kind).toBe("cli")
    } finally {
      uninstall()
    }
  })

  it("leaves a newer host in place when a stale uninstall runs", () => {
    const first = host("first")
    const uninstallFirst = installExternalAgentHost(first)
    uninstallFirst()
    const second = host("second")
    const uninstallSecond = installExternalAgentHost(second)
    uninstallFirst()
    expect(getInstalledExternalAgentHost()).toBe(second)
    uninstallSecond()
  })
})
