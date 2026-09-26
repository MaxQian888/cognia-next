/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import zh from "@/i18n/messages/zh-CN.json"
import { DEVICE_GRANT_IDS } from "@/lib/devices/grant-capabilities"

import { useCapabilityGrantLabel } from "./use-capability-grant-label"

// The global next-intl mock (jest.setup.ts) resolves keys against the real
// English bundle, so these assert on the words a reader sees.
describe("useCapabilityGrantLabel", () => {
  it("names the device-console switch instead of the capability id", () => {
    const { result } = renderHook(() => useCapabilityGrantLabel())
    expect(result.current("git.write")).toBe("Remote control")
    expect(result.current("terminal.open")).toBe("Terminal access")
    expect(result.current("ssh.files")).toBe("SSH file transfer")
    expect(result.current("process.spawn")).toBe("Run agents")
  })

  it("names host.admin plainly and falls back to the id for anything else", () => {
    const { result } = renderHook(() => useCapabilityGrantLabel())
    expect(result.current("host.admin")).toBe("Host administration")
    expect(result.current("some.unknown")).toBe("some.unknown")
    expect(result.current(undefined)).toBe("")
  })

  it("has a zh-CN label for every grant it can name", () => {
    const companion = zh.mobile.companion as Record<string, { col?: string }>
    const namespaces = {
      control: "remoteControl",
      agentControl: "agentControl",
      terminal: "remoteTerminal",
      sshFiles: "sshFiles",
      lockedComputerUse: "lockedComputerUse",
    } as const
    for (const id of DEVICE_GRANT_IDS) {
      expect(companion[namespaces[id]]?.col).toEqual(expect.any(String))
    }
    expect((zh.mobile.companion as Record<string, unknown>).hostAdminCapability).toEqual(
      expect.any(String)
    )
  })
})
