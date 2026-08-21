/**
 * Barrel surface guard. The serial monitor imports everything through
 * `@/lib/terminal/serial`, so a re-export dropped during a refactor breaks the
 * panel at runtime rather than at the type level in the module that lost it.
 */
import * as serial from "./index"
import { BAUD_RATES, DEFAULT_SERIAL_CONFIG } from "./types"

describe("lib/terminal/serial barrel", () => {
  it("re-exports the connection functions the panel calls", () => {
    for (const name of [
      "listSerialPorts",
      "openSerialPort",
      "closeSerialPort",
      "writeSerialPort",
      "getSerialStatus",
      "lineEndingStr",
      "formatSerialConfig",
      "formatHexDump",
      "isValidSerialConfig",
    ]) {
      expect(typeof (serial as unknown as Record<string, unknown>)[name]).toBe("function")
    }
  })

  it("re-exports the runtime constants by identity, not by copy", () => {
    expect(serial.BAUD_RATES).toBe(BAUD_RATES)
    expect(serial.DEFAULT_SERIAL_CONFIG).toBe(DEFAULT_SERIAL_CONFIG)
  })

  it("exposes exactly the documented runtime surface", () => {
    expect(Object.keys(serial).sort()).toEqual([
      "BAUD_RATES",
      "DEFAULT_SERIAL_CONFIG",
      "closeSerialPort",
      "formatHexDump",
      "formatSerialConfig",
      "getSerialStatus",
      "isValidSerialConfig",
      "lineEndingStr",
      "listSerialPorts",
      "openSerialPort",
      "writeSerialPort",
    ])
  })
})
