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
import { invoke } from "@tauri-apps/api/core"
import { DEFAULT_REMOTE_CONTROL_CONFIG } from "@/types/remote-control"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>

function setTauri(present: boolean) {
  if (present) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    })
  } else {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  }
}

beforeEach(() => {
  mockedInvoke.mockReset()
})

afterEach(() => {
  setTauri(false)
})

describe("remote-control Tauri wrappers", () => {
  describe("when running in the Tauri webview", () => {
    beforeEach(() => setTauri(true))

    it("get_status routes to the snake-cased command and returns the response", async () => {
      mockedInvoke.mockResolvedValueOnce({
        inboundRunning: true,
        boundPort: 47821,
        lastCallAt: null,
        inboundCallsTotal: 3,
        hasInboundToken: true,
      })
      const status = await remoteControlGetStatus()
      expect(mockedInvoke).toHaveBeenCalledWith("remote_control_get_status")
      expect(status.inboundRunning).toBe(true)
      expect(status.boundPort).toBe(47821)
    })

    it("start / stop / rotate are routed without args", async () => {
      mockedInvoke.mockResolvedValue(undefined)
      await remoteControlStart()
      await remoteControlStop()
      mockedInvoke.mockResolvedValueOnce("rotated-token")
      const token = await remoteControlRotateToken()
      expect(mockedInvoke).toHaveBeenNthCalledWith(1, "remote_control_start")
      expect(mockedInvoke).toHaveBeenNthCalledWith(2, "remote_control_stop")
      expect(mockedInvoke).toHaveBeenNthCalledWith(3, "remote_control_rotate_token")
      expect(token).toBe("rotated-token")
    })

    it("get_token returns null when no token exists", async () => {
      mockedInvoke.mockResolvedValueOnce(null)
      const token = await remoteControlGetToken()
      expect(token).toBeNull()
    })

    it("update_config forwards the config object as a named arg", async () => {
      mockedInvoke.mockResolvedValueOnce(undefined)
      await remoteControlUpdateConfig(DEFAULT_REMOTE_CONTROL_CONFIG)
      expect(mockedInvoke).toHaveBeenCalledWith("remote_control_update_config", {
        config: DEFAULT_REMOTE_CONTROL_CONFIG,
      })
    })

    it("set_signing_secret accepts a string and null", async () => {
      mockedInvoke.mockResolvedValue(undefined)
      await remoteControlSetSigningSecret("hunter2")
      await remoteControlSetSigningSecret(null)
      expect(mockedInvoke).toHaveBeenNthCalledWith(1, "remote_control_set_signing_secret", {
        secret: "hunter2",
      })
      expect(mockedInvoke).toHaveBeenNthCalledWith(2, "remote_control_set_signing_secret", {
        secret: null,
      })
    })

    it("get_signing_secret returns the keyring value", async () => {
      mockedInvoke.mockResolvedValueOnce("hunter2")
      const secret = await remoteControlGetSigningSecret()
      expect(secret).toBe("hunter2")
    })
  })

  describe("when running outside Tauri (web)", () => {
    beforeEach(() => setTauri(false))

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
    ])("throws a clear error from %s", async (cmd, run) => {
      await expect(run()).rejects.toThrow(new RegExp(`${cmd} requires the Tauri desktop runtime`))
      expect(mockedInvoke).not.toHaveBeenCalled()
    })
  })
})
