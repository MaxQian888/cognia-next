/** @jest-environment jsdom */

import {
  remoteControlGetSigningSecret,
  remoteControlGetStatus,
  remoteControlGetToken,
  remoteControlRotateToken,
  remoteControlSetSigningSecret,
  remoteControlStart,
  remoteControlStop,
  remoteControlUpdateConfig,
} from "./remote-control"
import { transport } from "@/lib/tauri"
import { DEFAULT_REMOTE_CONTROL_CONFIG } from "@/types/remote-control"

afterEach(() => {
  jest.restoreAllMocks()
})

describe("remote-control transport wrappers", () => {
  describe("happy path (transport.call mocked)", () => {
    it("get_status routes to the snake-cased command and returns the response", async () => {
      const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce({
        inboundRunning: true,
        boundPort: 47821,
        lastCallAt: null,
        inboundCallsTotal: 3,
        hasInboundToken: true,
      })
      const status = await remoteControlGetStatus()
      expect(callSpy).toHaveBeenCalledWith("remote_control_get_status")
      expect(status.inboundRunning).toBe(true)
      expect(status.boundPort).toBe(47821)
    })

    it("start / stop / rotate are routed without args", async () => {
      const callSpy = jest.spyOn(transport, "call")
      callSpy
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce("rotated-token")
      await remoteControlStart()
      await remoteControlStop()
      const token = await remoteControlRotateToken()
      expect(callSpy).toHaveBeenNthCalledWith(1, "remote_control_start")
      expect(callSpy).toHaveBeenNthCalledWith(2, "remote_control_stop")
      expect(callSpy).toHaveBeenNthCalledWith(3, "remote_control_rotate_token")
      expect(token).toBe("rotated-token")
    })

    it("get_token returns null when no token exists", async () => {
      jest.spyOn(transport, "call").mockResolvedValueOnce(null)
      const token = await remoteControlGetToken()
      expect(token).toBeNull()
    })

    it("update_config forwards the config object as a named arg", async () => {
      const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce(undefined)
      await remoteControlUpdateConfig(DEFAULT_REMOTE_CONTROL_CONFIG)
      expect(callSpy).toHaveBeenCalledWith("remote_control_update_config", {
        config: DEFAULT_REMOTE_CONTROL_CONFIG,
      })
    })

    it("set_signing_secret accepts a string and null", async () => {
      const callSpy = jest.spyOn(transport, "call")
      callSpy.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      await remoteControlSetSigningSecret("hunter2")
      await remoteControlSetSigningSecret(null)
      expect(callSpy).toHaveBeenNthCalledWith(1, "remote_control_set_signing_secret", {
        secret: "hunter2",
      })
      expect(callSpy).toHaveBeenNthCalledWith(2, "remote_control_set_signing_secret", {
        secret: null,
      })
    })

    it("get_signing_secret returns the keyring value", async () => {
      jest.spyOn(transport, "call").mockResolvedValueOnce("hunter2")
      const secret = await remoteControlGetSigningSecret()
      expect(secret).toBe("hunter2")
    })
  })

  describe("web mode (no transport spy — WebStubTransport rejects)", () => {
    it.each([
      ["remote_control_get_status", () => remoteControlGetStatus()],
      ["remote_control_start", () => remoteControlStart()],
      ["remote_control_stop", () => remoteControlStop()],
      ["remote_control_get_token", () => remoteControlGetToken()],
      ["remote_control_rotate_token", () => remoteControlRotateToken()],
      [
        "remote_control_update_config",
        () => remoteControlUpdateConfig(DEFAULT_REMOTE_CONTROL_CONFIG),
      ],
      ["remote_control_set_signing_secret", () => remoteControlSetSigningSecret("x")],
      ["remote_control_get_signing_secret", () => remoteControlGetSigningSecret()],
    ])("throws the WebStub error from %s", async (cmd, run) => {
      await expect(run()).rejects.toThrow(new RegExp(`tauri-only command from web mode: ${cmd}`))
    })
  })
})
