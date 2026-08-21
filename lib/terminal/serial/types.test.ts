import { BAUD_RATES, DEFAULT_SERIAL_CONFIG } from "./types"
import type { SerialConfig, SerialPortInfo } from "./types"

describe("BAUD_RATES", () => {
  it("is ascending and free of duplicates — the picker renders it verbatim", () => {
    expect([...BAUD_RATES]).toEqual([...BAUD_RATES].slice().sort((a, b) => a - b))
    expect(new Set(BAUD_RATES).size).toBe(BAUD_RATES.length)
  })

  it("includes the default so the picker can always show the current value", () => {
    expect(BAUD_RATES).toContain(DEFAULT_SERIAL_CONFIG.baudRate)
  })
})

describe("DEFAULT_SERIAL_CONFIG", () => {
  it("is the conventional 115200 8N1, no flow control", () => {
    expect(DEFAULT_SERIAL_CONFIG).toEqual({
      baudRate: 115200,
      dataBits: 8,
      parity: "none",
      stopBits: 1,
      flowControl: "none",
    })
  })

  it("omits `port`, so a caller must name one to build a usable config", () => {
    expect(DEFAULT_SERIAL_CONFIG).not.toHaveProperty("port")
    const config: SerialConfig = { ...DEFAULT_SERIAL_CONFIG, port: "/dev/ttyUSB0" }
    expect(config.port).toBe("/dev/ttyUSB0")
  })
})

describe("SerialPortInfo shape", () => {
  it("spells every unknown descriptor as null rather than omitting it", () => {
    // The enumeration comes from Rust, where an absent descriptor serializes as
    // `null`; the fields are required-and-nullable, not optional.
    const info: SerialPortInfo = {
      path: "/dev/ttyUSB0",
      portType: "usb",
      manufacturer: null,
      product: null,
      serialNumber: null,
      vendorId: "1a86",
      productId: "7523",
    }
    expect(info.manufacturer).toBeNull()
    expect(info.portType).toBe("usb")
  })
})
