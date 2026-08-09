/**
 * Serial port connection manager — frontend orchestration layer.
 *
 * Bridges the Tauri serial port commands to a clean interface for the
 * terminal dock to consume. Like `buffer-persist.ts`, all operations
 * are no-ops outside of Tauri.
 */

import { isTauri } from "@/lib/tauri"
import type {
  SerialConfig,
  SerialPortInfo,
  SerialConnectionStatus,
  SerialLineEnding,
} from "./types"

/**
 * List available serial ports on the system.
 */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  if (!isTauri()) return []

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<SerialPortInfo[]>("terminal_list_serial_ports")
  } catch {
    return []
  }
}

/**
 * Open a serial port connection.
 *
 * @param config - Port configuration (path, baud, etc.)
 * @returns A session id for the opened connection, or null on failure.
 */
export async function openSerialPort(
  config: SerialConfig
): Promise<{ sessionId: string } | { error: string }> {
  if (!isTauri()) {
    return { error: "Serial ports require the desktop app" }
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    const result = await invoke<{ session_id: string }>("terminal_open_serial", {
      config: {
        port: config.port,
        baud_rate: config.baudRate,
        data_bits: config.dataBits,
        parity: config.parity,
        stop_bits: config.stopBits,
        flow_control: config.flowControl,
      },
    })
    return { sessionId: result.session_id }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to open serial port" }
  }
}

/**
 * Close a serial port connection.
 */
export async function closeSerialPort(sessionId: string): Promise<boolean> {
  if (!isTauri()) return false

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("terminal_close_serial", { sessionId })
    return true
  } catch {
    return false
  }
}

/**
 * Write data to an open serial port.
 *
 * @param sessionId - The serial session id
 * @param data - The data to send
 * @param lineEnding - Line ending to append
 */
export async function writeSerialPort(
  sessionId: string,
  data: string,
  lineEnding: SerialLineEnding = "none"
): Promise<boolean> {
  if (!isTauri()) return false

  const payload = data + lineEndingStr(lineEnding)

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("terminal_serial_write", { sessionId, data: payload })
    return true
  } catch {
    return false
  }
}

/**
 * Get the current connection status of a serial session.
 */
export async function getSerialStatus(sessionId: string): Promise<SerialConnectionStatus> {
  if (!isTauri()) return "disconnected"

  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<SerialConnectionStatus>("terminal_serial_status", { sessionId })
  } catch {
    return "error"
  }
}

/** Convert a line ending enum to its string representation. */
export function lineEndingStr(ending: SerialLineEnding): string {
  switch (ending) {
    case "none":
      return ""
    case "cr":
      return "\r"
    case "lf":
      return "\n"
    case "crlf":
      return "\r\n"
  }
}

/** Format a serial config for display (e.g. "115200 8N1"). */
export function formatSerialConfig(config: Omit<SerialConfig, "port">): string {
  const parityChar = config.parity === "none" ? "N" : config.parity[0].toUpperCase()
  return `${config.baudRate} ${config.dataBits}${parityChar}${config.stopBits}`
}

/** Format bytes as a hex dump string. */
export function formatHexDump(data: string): string {
  const bytes: string[] = []
  for (let i = 0; i < data.length; i++) {
    bytes.push(data.charCodeAt(i).toString(16).padStart(2, "0"))
  }
  return bytes.join(" ")
}

/** Validate a serial config has all required fields. */
export function isValidSerialConfig(config: Partial<SerialConfig>): config is SerialConfig {
  return (
    typeof config.port === "string" &&
    config.port.length > 0 &&
    typeof config.baudRate === "number" &&
    config.baudRate > 0 &&
    (config.dataBits === 5 ||
      config.dataBits === 6 ||
      config.dataBits === 7 ||
      config.dataBits === 8) &&
    (config.parity === "none" ||
      config.parity === "odd" ||
      config.parity === "even" ||
      config.parity === "mark" ||
      config.parity === "space") &&
    (config.stopBits === 1 || config.stopBits === 1.5 || config.stopBits === 2) &&
    (config.flowControl === "none" ||
      config.flowControl === "hardware" ||
      config.flowControl === "software")
  )
}
