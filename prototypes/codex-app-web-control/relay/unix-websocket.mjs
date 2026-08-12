import { createHash, randomBytes } from "node:crypto"
import { createConnection } from "node:net"

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

function frame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const mask = randomBytes(4)
  let header
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length])
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  const masked = Buffer.allocUnsafe(body.length)
  for (let index = 0; index < body.length; index += 1) {
    masked[index] = body[index] ^ mask[index % 4]
  }
  return Buffer.concat([header, mask, masked])
}

export function encodeClientTextFrame(text) {
  return frame(0x1, Buffer.from(text, "utf8"))
}

function payloadLength(buffer, offset) {
  const marker = buffer[offset + 1] & 0x7f
  if (marker < 126) return { length: marker, headerLength: 2 }
  if (marker === 126) {
    if (buffer.length < offset + 4) return null
    return { length: buffer.readUInt16BE(offset + 2), headerLength: 4 }
  }
  if (buffer.length < offset + 10) return null
  const value = buffer.readBigUInt64BE(offset + 2)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame is too large")
  return { length: Number(value), headerLength: 10 }
}

export async function connectUnixWebSocket(
  socketPath,
  { host = "localhost", path = "/", timeoutMs = 5000 } = {}
) {
  const socket = createConnection(socketPath)
  const key = randomBytes(16).toString("base64")
  const expectedAccept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64")
  let buffer = Buffer.alloc(0)
  let opened = false
  let closed = false
  let closeSent = false
  let continuationOpcode = null
  let continuationParts = []
  const messageListeners = new Set()
  const closeListeners = new Set()

  function emitClose(error = null) {
    if (closed) return
    closed = true
    for (const listener of closeListeners) listener(error)
  }

  function emitMessage(opcode, payload) {
    if (opcode === 0x1) {
      const text = payload.toString("utf8")
      for (const listener of messageListeners) listener(text)
    }
  }

  function processFrames() {
    let offset = 0
    while (buffer.length - offset >= 2) {
      const first = buffer[offset]
      const final = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (buffer[offset + 1] & 0x80) !== 0
      const parsedLength = payloadLength(buffer, offset)
      if (!parsedLength) break
      const maskLength = masked ? 4 : 0
      const frameLength = parsedLength.headerLength + maskLength + parsedLength.length
      if (buffer.length - offset < frameLength) break
      const maskOffset = offset + parsedLength.headerLength
      const bodyOffset = maskOffset + maskLength
      const payload = Buffer.from(buffer.subarray(bodyOffset, bodyOffset + parsedLength.length))
      if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4)
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4]
        }
      }
      offset += frameLength

      if (opcode === 0x8) {
        if (!closeSent && socket.writable && !socket.writableEnded) {
          closeSent = true
          socket.end(frame(0x8, payload))
        }
        emitClose()
        continue
      }
      if (opcode === 0x9) {
        socket.write(frame(0x0a, payload))
        continue
      }
      if (opcode === 0x0) {
        continuationParts.push(payload)
        if (final && continuationOpcode != null) {
          emitMessage(continuationOpcode, Buffer.concat(continuationParts))
          continuationOpcode = null
          continuationParts = []
        }
        continue
      }
      if (!final) {
        continuationOpcode = opcode
        continuationParts = [payload]
        continue
      }
      emitMessage(opcode, payload)
    }
    buffer = buffer.subarray(offset)
  }

  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => {
      socket.destroy()
      rejectOpen(new Error("Timed out connecting to the App Server control socket"))
    }, timeoutMs)

    socket.once("connect", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n")
      )
    })
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!opened) {
        const boundary = buffer.indexOf("\r\n\r\n")
        if (boundary < 0) return
        const head = buffer.subarray(0, boundary).toString("utf8")
        const lines = head.split("\r\n")
        const headers = new Map(
          lines.slice(1).map((line) => {
            const separator = line.indexOf(":")
            return [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()]
          })
        )
        if (
          !/^HTTP\/1\.1 101\b/.test(lines[0]) ||
          headers.get("sec-websocket-accept") !== expectedAccept
        ) {
          clearTimeout(timer)
          socket.destroy()
          rejectOpen(new Error(`App Server WebSocket upgrade failed: ${lines[0]}`))
          return
        }
        opened = true
        buffer = buffer.subarray(boundary + 4)
        clearTimeout(timer)
        resolveOpen()
      }
      if (opened) processFrames()
    })
    socket.once("error", (error) => {
      clearTimeout(timer)
      if (!opened) rejectOpen(error)
      else emitClose(error)
    })
    socket.once("close", () => emitClose())
  })

  return {
    close() {
      if (closed || closeSent || !socket.writable || socket.writableEnded) return
      closeSent = true
      socket.end(frame(0x8))
    },
    onClose(listener) {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    onMessage(listener) {
      messageListeners.add(listener)
      return () => messageListeners.delete(listener)
    },
    sendText(text) {
      if (closed || !socket.writable) throw new Error("App Server socket is not writable")
      socket.write(encodeClientTextFrame(text))
    },
  }
}
