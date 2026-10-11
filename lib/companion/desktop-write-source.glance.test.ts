/**
 * @jest-environment jsdom
 *
 * The `glance_*` family (ADR-0225 §9). `dispatchCommand` delegates every name
 * in `GLANCE_REMOTE_COMMANDS` wholesale to the glance host arms, with the
 * payload untouched (the companion server's injected `callerDeviceId`
 * included), and loads nothing glance-related for any other command.
 */

import "fake-indexeddb/auto"

jest.mock("@/lib/glance/remote/host-dispatch", () => ({
  dispatchGlanceHostCommand: jest.fn(async () => ({ ok: true })),
}))

import { GLANCE_REMOTE_COMMAND_NAMES } from "@/lib/glance/remote/commands"

import { dispatchCommand } from "./desktop-write-source"

const hostDispatch = jest.requireMock("@/lib/glance/remote/host-dispatch") as {
  dispatchGlanceHostCommand: jest.Mock
}

beforeEach(() => jest.clearAllMocks())

describe("dispatchCommand: glance_*", () => {
  it.each(GLANCE_REMOTE_COMMAND_NAMES.map((name) => [name]))(
    "hands %s and its payload to the glance host arms",
    async (command) => {
      const payload = { consumer: "phone-1", callerDeviceId: "dev-A", kind: "refresh" }
      await expect(dispatchCommand(command, payload)).resolves.toEqual({ ok: true })
      expect(hostDispatch.dispatchGlanceHostCommand).toHaveBeenCalledTimes(1)
      expect(hostDispatch.dispatchGlanceHostCommand).toHaveBeenCalledWith(command, payload)
    }
  )

  it("does not route a look-alike name to the glance arms", async () => {
    await expect(dispatchCommand("glance_unknown", {})).rejects.toThrow()
    expect(hostDispatch.dispatchGlanceHostCommand).not.toHaveBeenCalled()
  })
})
