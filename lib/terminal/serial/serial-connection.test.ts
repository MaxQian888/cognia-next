/**
 * Tests for the serial port connection module.
 */

import {
  listSerialPorts,
  openSerialPort,
  attachSerialPort,
  closeSerialPort,
  writeSerialPort,
  lineEndingStr,
  formatSerialConfig,
  formatHexDump,
  isValidSerialConfig,
} from "./serial-connection"
import type { SerialConfig } from "./types"

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
}))

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

import { isTauri } from "@/lib/tauri"
const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

describe("serial/serial-connection", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsTauri.mockReturnValue(false)
  })

  describe("listSerialPorts", () => {
    it("returns empty when not in Tauri", async () => {
      expect(await listSerialPorts()).toEqual([])
    })
  })

  describe("openSerialPort", () => {
    it("returns error when not in Tauri", async () => {
      const config: SerialConfig = {
        port: "/dev/ttyUSB0",
        baudRate: 115200,
        dataBits: 8,
        parity: "none",
        stopBits: 1,
        flowControl: "none",
      }
      const result = await openSerialPort(config)
      expect("error" in result).toBe(true)
    })
  })

  describe("attachSerialPort", () => {
    it("returns false when not in Tauri", async () => {
      expect(await attachSerialPort("s1")).toBe(false)
    })

    /**
     * The attach is what starts the read loop, so it is the one call that must
     * carry the id the open returned. A silent `true` on a mismatched id would
     * leave a session that never streams and never says why.
     */
    it("passes the session id through and reports what the host answered", async () => {
      mockIsTauri.mockReturnValue(true)
      const { invoke } = jest.requireMock("@tauri-apps/api/core")
      invoke.mockResolvedValueOnce(true)
      expect(await attachSerialPort("sess-9")).toBe(true)
      expect(invoke).toHaveBeenCalledWith("terminal_serial_attach", { sessionId: "sess-9" })

      invoke.mockResolvedValueOnce(false)
      expect(await attachSerialPort("gone")).toBe(false)
    })
  })

  describe("closeSerialPort", () => {
    it("returns false when not in Tauri", async () => {
      expect(await closeSerialPort("s1")).toBe(false)
    })
  })

  describe("writeSerialPort", () => {
    it("returns false when not in Tauri", async () => {
      expect(await writeSerialPort("s1", "data")).toBe(false)
    })
  })

  describe("lineEndingStr", () => {
    it("returns empty for none", () => {
      expect(lineEndingStr("none")).toBe("")
    })

    it("returns \\r for cr", () => {
      expect(lineEndingStr("cr")).toBe("\r")
    })

    it("returns \\n for lf", () => {
      expect(lineEndingStr("lf")).toBe("\n")
    })

    it("returns \\r\\n for crlf", () => {
      expect(lineEndingStr("crlf")).toBe("\r\n")
    })
  })

  describe("formatSerialConfig", () => {
    it("formats standard config", () => {
      expect(
        formatSerialConfig({
          baudRate: 115200,
          dataBits: 8,
          parity: "none",
          stopBits: 1,
          flowControl: "none",
        })
      ).toBe("115200 8N1")
    })

    it("formats config with even parity", () => {
      expect(
        formatSerialConfig({
          baudRate: 9600,
          dataBits: 7,
          parity: "even",
          stopBits: 2,
          flowControl: "hardware",
        })
      ).toBe("9600 7E2")
    })

    it("formats config with odd parity", () => {
      expect(
        formatSerialConfig({
          baudRate: 57600,
          dataBits: 8,
          parity: "odd",
          stopBits: 1,
          flowControl: "none",
        })
      ).toBe("57600 8O1")
    })
  })

  describe("formatHexDump", () => {
    it("formats ASCII as hex bytes", () => {
      expect(formatHexDump("ABC")).toBe("41 42 43")
    })

    it("handles empty string", () => {
      expect(formatHexDump("")).toBe("")
    })

    it("pads single-digit hex values with zero", () => {
      expect(formatHexDump("\x00\x0f")).toBe("00 0f")
    })
  })

  describe("isValidSerialConfig", () => {
    it("returns true for valid config", () => {
      expect(
        isValidSerialConfig({
          port: "/dev/ttyUSB0",
          baudRate: 115200,
          dataBits: 8,
          parity: "none",
          stopBits: 1,
          flowControl: "none",
        })
      ).toBe(true)
    })

    it("returns false for missing port", () => {
      expect(
        isValidSerialConfig({
          port: "",
          baudRate: 115200,
          dataBits: 8,
          parity: "none",
          stopBits: 1,
          flowControl: "none",
        })
      ).toBe(false)
    })

    it("returns false for invalid baud rate", () => {
      expect(
        isValidSerialConfig({
          port: "/dev/ttyUSB0",
          baudRate: 0,
          dataBits: 8,
          parity: "none",
          stopBits: 1,
          flowControl: "none",
        })
      ).toBe(false)
    })

    it("returns false for invalid data bits", () => {
      expect(
        isValidSerialConfig({
          port: "/dev/ttyUSB0",
          baudRate: 115200,
          dataBits: 9 as never,
          parity: "none",
          stopBits: 1,
          flowControl: "none",
        })
      ).toBe(false)
    })

    it("returns false for missing fields", () => {
      expect(isValidSerialConfig({ port: "/dev/ttyUSB0" })).toBe(false)
    })
  })
})
