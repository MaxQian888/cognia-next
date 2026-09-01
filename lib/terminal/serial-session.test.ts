/**
 * @jest-environment jsdom
 *
 * Pins the three places a serial session is NOT a PTY, because each one is a
 * base-class assumption that a cable cannot answer: resize is a no-op, the
 * exit carries no code, and a failed write must throw rather than resolve.
 */

const listenMock = jest.fn()
jest.mock("@tauri-apps/api/event", () => ({
  listen: (topic: string, handler: (event: { payload: unknown }) => void) =>
    listenMock(topic, handler),
}))

const openSerialPortMock = jest.fn()
const writeSerialPortMock = jest.fn()
const closeSerialPortMock = jest.fn()
jest.mock("./serial/serial-connection", () => {
  const actual = jest.requireActual("./serial/serial-connection")
  return {
    ...actual,
    openSerialPort: (...args: unknown[]) => openSerialPortMock(...args),
    writeSerialPort: (...args: unknown[]) => writeSerialPortMock(...args),
    closeSerialPort: (...args: unknown[]) => closeSerialPortMock(...args),
  }
})

import { DEFAULT_SERIAL_CONFIG } from "./serial/types"
import {
  decodeBase64,
  SerialTerminalSession,
  serialDataTopic,
  serialStatusTopic,
} from "./serial-session"

const config = { ...DEFAULT_SERIAL_CONFIG, port: "/dev/cu.usbserial-1420" }
/** topic → the handler the session registered for it. */
const handlers = new Map<string, (event: { payload: unknown }) => void>()

beforeEach(() => {
  handlers.clear()
  listenMock.mockReset().mockImplementation((topic: string, handler) => {
    handlers.set(topic, handler)
    return Promise.resolve(() => handlers.delete(topic))
  })
  openSerialPortMock.mockReset().mockResolvedValue({ sessionId: "sess-1" })
  writeSerialPortMock.mockReset().mockResolvedValue(true)
  closeSerialPortMock.mockReset().mockResolvedValue(true)
})

it("labels the tab with the port and its line settings", async () => {
  const session = await SerialTerminalSession.open(config, "proj-a")
  expect(session.info.id).toBe("sess-1")
  expect(session.info.kind).toBe("serial")
  expect(session.info.projectId).toBe("proj-a")
  expect(session.info.shell).toBe("/dev/cu.usbserial-1420 (115200 8N1)")
})

/**
 * A device that greets on open (most bootloaders do) sends its banner before
 * any consumer mounts. Subscribing after the open call would drop it, and the
 * base class's early-data buffer only covers the window after the first byte.
 */
it("subscribes to both topics before returning", async () => {
  await SerialTerminalSession.open(config)
  expect(handlers.has(serialDataTopic("sess-1"))).toBe(true)
  expect(handlers.has(serialStatusTopic("sess-1"))).toBe(true)
})

it("decodes inbound base64 into the data stream", async () => {
  const session = await SerialTerminalSession.open(config)
  const seen: Uint8Array[] = []
  session.onData((bytes) => seen.push(bytes))
  handlers.get(serialDataTopic("sess-1"))?.({ payload: { base64: btoa("boot\r\n") } })
  expect(new TextDecoder().decode(seen[0])).toBe("boot\r\n")
})

/**
 * A cable pulled mid-transfer must be visible IN the stream. The scrollback
 * above it is real data, and without a marker there is nothing to tell the
 * user where the device stopped answering.
 */
it("writes the failure into the stream and exits with no code", async () => {
  const session = await SerialTerminalSession.open(config)
  const seen: string[] = []
  session.onData((bytes) => seen.push(new TextDecoder().decode(bytes)))
  const exits: (number | null)[] = []
  session.onExit((code) => exits.push(code))

  handlers.get(serialStatusTopic("sess-1"))?.({
    payload: { status: "error", reason: "the device closed the port" },
  })

  expect(seen.join("")).toContain("the device closed the port")
  // Not 0, not 1. There was no process, so there is no exit code, and the dock
  // renders `null` as "no exit code" the same way it does for a signalled shell.
  expect(exits).toEqual([null])
  expect(session.connectionStatus).toBe("error")
})

it("passes bytes through on write and throws when the port refuses", async () => {
  const session = await SerialTerminalSession.open(config)
  await session.write("AT\r\n")
  expect(writeSerialPortMock).toHaveBeenCalledWith("sess-1", "AT\r\n")

  writeSerialPortMock.mockResolvedValue(false)
  await expect(session.write("AT\r\n")).rejects.toThrow(/did not accept/)
})

/** A serial line has no window size. Resizing must not reach the device. */
it("resizes without touching the transport", async () => {
  const session = await SerialTerminalSession.open(config)
  await expect(session.resize(120, 40)).resolves.toBeUndefined()
  expect(writeSerialPortMock).not.toHaveBeenCalled()
})

it("closes the port and stops listening on kill", async () => {
  const session = await SerialTerminalSession.open(config)
  await session.kill()
  expect(closeSerialPortMock).toHaveBeenCalledWith("sess-1")
  expect(handlers.size).toBe(0)
  expect(session.connectionStatus).toBe("disconnected")
})

it("surfaces an open failure as a throw rather than a half-built session", async () => {
  openSerialPortMock.mockResolvedValue({ error: "permission denied" })
  await expect(SerialTerminalSession.open(config)).rejects.toThrow(/permission denied/)
})

it("decodes base64 to bytes, including high bytes a text decoder would mangle", () => {
  expect(Array.from(decodeBase64(btoa("\x00\xff\x7f")))).toEqual([0, 255, 127])
})
