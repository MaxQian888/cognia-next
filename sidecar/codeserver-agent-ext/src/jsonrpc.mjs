export const JSON_RPC_VERSION = "2.0"
export const MAX_FRAME_BYTES = 1024 * 1024
export const MAX_HEADER_BYTES = 8 * 1024

const HEADER_END = Buffer.from("\r\n\r\n", "ascii")

export class ContentLengthDecoder {
  constructor({ maxFrameBytes = MAX_FRAME_BYTES, maxHeaderBytes = MAX_HEADER_BYTES } = {}) {
    this.maxFrameBytes = maxFrameBytes
    this.maxHeaderBytes = maxHeaderBytes
    this.buffer = Buffer.alloc(0)
    this.expectedBodyBytes = null
  }

  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes])
    const messages = []

    while (true) {
      if (this.expectedBodyBytes === null) {
        const headerEnd = this.buffer.indexOf(HEADER_END)
        if (headerEnd < 0) {
          if (this.buffer.length > this.maxHeaderBytes) {
            throw new Error(`JSON-RPC header exceeds ${this.maxHeaderBytes} bytes`)
          }
          break
        }
        if (headerEnd > this.maxHeaderBytes) {
          throw new Error(`JSON-RPC header exceeds ${this.maxHeaderBytes} bytes`)
        }
        const header = this.buffer.subarray(0, headerEnd).toString("ascii")
        this.buffer = this.buffer.subarray(headerEnd + HEADER_END.length)
        this.expectedBodyBytes = parseContentLength(header)
        if (this.expectedBodyBytes > this.maxFrameBytes) {
          throw new Error(
            `JSON-RPC frame exceeds ${this.maxFrameBytes} bytes: ${this.expectedBodyBytes}`
          )
        }
      }

      if (this.buffer.length < this.expectedBodyBytes) break
      const body = this.buffer.subarray(0, this.expectedBodyBytes)
      this.buffer = this.buffer.subarray(this.expectedBodyBytes)
      this.expectedBodyBytes = null
      try {
        messages.push(JSON.parse(body.toString("utf8")))
      } catch (error) {
        throw new Error(`Invalid JSON-RPC JSON body: ${String(error?.message ?? error)}`)
      }
    }

    return messages
  }
}

function parseContentLength(header) {
  let contentLength = null
  for (const line of header.split("\r\n")) {
    const separator = line.indexOf(":")
    if (separator < 0) continue
    const name = line.slice(0, separator).trim().toLowerCase()
    if (name !== "content-length") continue
    const raw = line.slice(separator + 1).trim()
    if (!/^(0|[1-9]\d*)$/.test(raw)) {
      throw new Error(`Invalid Content-Length: ${raw}`)
    }
    contentLength = Number(raw)
  }
  if (contentLength === null) throw new Error("Missing Content-Length header")
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new Error(`Invalid Content-Length: ${contentLength}`)
  }
  return contentLength
}

export function serializeContentLength(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`JSON-RPC frame exceeds ${MAX_FRAME_BYTES} bytes: ${body.length}`)
  }
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii")
  return Buffer.concat([header, body])
}

export function requestMessage(id, method, params = {}) {
  return { jsonrpc: JSON_RPC_VERSION, id, method, params }
}

export function notificationMessage(method, params = {}) {
  return { jsonrpc: JSON_RPC_VERSION, method, params }
}

export function responseMessage(id, result = null) {
  return { jsonrpc: JSON_RPC_VERSION, id, result }
}

export function errorResponse(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: JSON_RPC_VERSION, id, error }
}

export function eventNotification(name, payload) {
  return notificationMessage("cognia/event", { name, payload: payload ?? null })
}

export function brokerChallengeRequest(tokenId) {
  return requestMessage("challenge", "cognia/auth/challenge", { tokenId })
}

export function brokerHelloRequest({ tokenId, proof, catalogHash, hostId, workspace }) {
  return requestMessage("hello", "cognia/hello", {
    tokenId,
    proof,
    protocolVersions: ["1.0", "0.2"],
    codeApiVersion: "1.128.0",
    catalogHash,
    hostId,
    workspace,
    capabilities: [
      "cancel",
      "progress",
      "structured-errors",
      "content-handles",
      "contribution-transactions",
    ],
  })
}

export function validateNegotiatedHello(result, expectedCatalogHash) {
  const requiredCapabilities = ["structured-errors", "content-handles", "contribution-transactions"]
  if (
    !result ||
    result.protocolVersion !== "1.0" ||
    result.codeApiVersion !== "1.128.0" ||
    result.catalogHash !== expectedCatalogHash ||
    !Number.isSafeInteger(result.generation) ||
    result.generation <= 0 ||
    !Array.isArray(result.capabilities) ||
    requiredCapabilities.some((capability) => !result.capabilities.includes(capability))
  ) {
    throw new Error("IDE_BROKER_NEGOTIATION_INVALID")
  }
  return Object.freeze({
    ...result,
    capabilities: Object.freeze([...new Set(result.capabilities)]),
  })
}
