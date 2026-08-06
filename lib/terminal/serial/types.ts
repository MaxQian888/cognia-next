/**
 * Type definitions for serial/COM port connectivity.
 */

/** Standard baud rates. */
export const BAUD_RATES = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
] as const

export type BaudRate = (typeof BAUD_RATES)[number] | number

/** Data bits. */
export type DataBits = 5 | 6 | 7 | 8

/** Parity. */
export type Parity = "none" | "odd" | "even" | "mark" | "space"

/** Stop bits. */
export type StopBits = 1 | 1.5 | 2

/** Flow control. */
export type FlowControl = "none" | "hardware" | "software"

/** Serial port configuration. */
export interface SerialConfig {
  /** Port path (e.g. /dev/ttyUSB0, COM3). */
  port: string
  /** Baud rate. Defaults to 115200. */
  baudRate: BaudRate
  /** Data bits. Defaults to 8. */
  dataBits: DataBits
  /** Parity. Defaults to "none". */
  parity: Parity
  /** Stop bits. Defaults to 1. */
  stopBits: StopBits
  /** Flow control. Defaults to "none". */
  flowControl: FlowControl
}

/** Information about an available serial port. */
export interface SerialPortInfo {
  /** System port path. */
  path: string
  /** Port type. */
  portType: "usb" | "bluetooth" | "pci" | "unknown"
  /** Manufacturer name if available. */
  manufacturer: string | null
  /** Product name if available. */
  product: string | null
  /** Serial number if available. */
  serialNumber: string | null
  /** USB vendor ID (hex string). */
  vendorId: string | null
  /** USB product ID (hex string). */
  productId: string | null
}

/** Connection status for a serial session. */
export type SerialConnectionStatus = "disconnected" | "connecting" | "connected" | "error"

/** Display mode for the serial monitor. */
export type SerialDisplayMode = "ascii" | "hex" | "mixed"

/** Line ending to append when sending data. */
export type SerialLineEnding = "none" | "cr" | "lf" | "crlf"

/** Default serial configuration. */
export const DEFAULT_SERIAL_CONFIG: Omit<SerialConfig, "port"> = {
  baudRate: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  flowControl: "none",
}
