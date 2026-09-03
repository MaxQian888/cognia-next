import { canProxyRemoteToolCall } from "./controller-tool-proxy"

describe("canProxyRemoteToolCall", () => {
  // The case that was broken: a browser paired to a headless host. It is not
  // driving anyone, and the frame reached it because the host addressed it
  // there, so refusing is refusing to answer a question it was asked.
  it("answers a host it belongs to, without consulting the remote-host store", () => {
    const remoteHostAdvertises = jest.fn(() => false)

    expect(
      canProxyRemoteToolCall("plugin_tool_exec", {
        drivingRemoteHost: () => false,
        remoteHostAdvertises,
      })
    ).toBe(true)
    expect(remoteHostAdvertises).not.toHaveBeenCalled()
  })

  it("keeps the ADR-0082 compatibility check when driving another host", () => {
    expect(
      canProxyRemoteToolCall("plugin_tool_exec", {
        drivingRemoteHost: () => true,
        remoteHostAdvertises: () => true,
      })
    ).toBe(true)
  })

  it("refuses when the host being driven does not advertise the round-trip", () => {
    expect(
      canProxyRemoteToolCall("protocol_adapter_exec", {
        drivingRemoteHost: () => true,
        remoteHostAdvertises: () => false,
      })
    ).toBe(false)
  })

  it("asks about the operation it was given, not the feature as a whole", () => {
    const advertised = new Set(["plugin_tool_exec"])
    const deps = {
      drivingRemoteHost: () => true,
      remoteHostAdvertises: (op: string) => advertised.has(op),
    }

    expect(canProxyRemoteToolCall("plugin_tool_exec", deps)).toBe(true)
    expect(canProxyRemoteToolCall("tool_result_review", deps)).toBe(false)
  })
})
