/**
 * Serial port — barrel export.
 */

export type {
  BaudRate,
  DataBits,
  Parity,
  StopBits,
  FlowControl,
  SerialConfig,
  SerialPortInfo,
  SerialConnectionStatus,
  SerialDisplayMode,
  SerialLineEnding,
} from "./types"

export { BAUD_RATES, DEFAULT_SERIAL_CONFIG } from "./types"

export {
  listSerialPorts,
  openSerialPort,
  closeSerialPort,
  writeSerialPort,
  getSerialStatus,
  lineEndingStr,
  formatSerialConfig,
  formatHexDump,
  isValidSerialConfig,
} from "./serial-connection"
