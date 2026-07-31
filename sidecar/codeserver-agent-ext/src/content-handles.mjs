import { createHash } from "node:crypto"

const CONTENT_TIMEOUT_MS = 30_000

export class ContentHandleClient {
  constructor({ port, credential, fetchImpl = globalThis.fetch }) {
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error("IDE_CONTENT_PORT_INVALID")
    }
    if (typeof credential !== "string" || credential.length === 0) {
      throw new Error("IDE_CONTENT_CREDENTIAL_INVALID")
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("IDE_CONTENT_FETCH_UNAVAILABLE")
    }
    this.baseUrl = `http://127.0.0.1:${port}/v1/content`
    this.credential = credential
    this.fetchImpl = fetchImpl
  }

  async upload(provider, bytes, mediaType = "application/octet-stream") {
    const body = Buffer.from(bytes)
    const response = await this.fetchImpl(this.baseUrl, {
      method: "PUT",
      headers: this.headers(provider, { "content-type": mediaType }),
      body,
      signal: AbortSignal.timeout(CONTENT_TIMEOUT_MS),
    })
    if (!response.ok) throw await responseError(response)
    const handle = await response.json()
    validateHandle(handle, body)
    return handle
  }

  async download(provider, handle) {
    validateHandle(handle)
    const response = await this.fetchImpl(`${this.baseUrl}/${encodeURIComponent(handle.id)}`, {
      method: "GET",
      headers: this.headers(provider),
      signal: AbortSignal.timeout(CONTENT_TIMEOUT_MS),
    })
    if (!response.ok) throw await responseError(response)
    const bytes = new Uint8Array(await response.arrayBuffer())
    validateHandle(handle, bytes)
    return bytes
  }

  headers(provider, extra = {}) {
    return {
      authorization: `Bearer ${this.credential}`,
      "x-cognia-plugin-id": provider.pluginId,
      "x-cognia-provider-id": provider.id,
      ...(provider.permission ? { "x-cognia-permission": provider.permission } : {}),
      ...extra,
    }
  }
}

function validateHandle(handle, bytes) {
  if (
    !handle ||
    handle.$type !== "ContentHandle" ||
    typeof handle.id !== "string" ||
    !Number.isSafeInteger(handle.size) ||
    handle.size < 0 ||
    !/^[a-f0-9]{64}$/.test(handle.sha256 ?? "")
  ) {
    throw new Error("IDE_CONTENT_HANDLE_INVALID")
  }
  if (!bytes) return
  if (bytes.length !== handle.size) {
    throw new Error("IDE_CONTENT_HANDLE_SIZE_MISMATCH")
  }
  const digest = createHash("sha256").update(bytes).digest("hex")
  if (digest !== handle.sha256) {
    throw new Error("IDE_CONTENT_HANDLE_INTEGRITY_FAILED")
  }
}

async function responseError(response) {
  const detail = await response.text().catch(() => "")
  return new Error(`IDE_CONTENT_TRANSFER_FAILED: HTTP ${response.status} ${detail}`.trim())
}
