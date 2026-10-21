/** Authenticated Logto boundary; delivery coordination lives in a private binding. */
import { PURPOSES, type EmailMessage, type MailInput } from "./template"

export { EmailDelivery } from "./delivery"
export type { EmailMessage } from "./template"

export interface Env {
  LOGTO_EMAIL_TOKEN: string
  LOGTO_EMAIL_PREVIOUS_TOKEN?: string
  /** Stable across auth-token rotations; prevents offline guessing of stored OTP hashes. */
  LOGTO_EMAIL_HASH_KEY: string
  MAIL_FROM: string
  EMAIL?: { send(message: EmailMessage): Promise<{ messageId: string }> }
  DELIVERY?: { getByName(name: string): { fetch(request: Request): Promise<Response> } }
}

const MAX_BODY_BYTES = 16_384
const BODY_TIMEOUT_MS = 3_000

function reply(text: string, status: number): Response {
  return new Response(text, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  })
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Compare fixed-size digests rather than exiting at the first differing character. */
async function authorized(header: string | null, secret: string): Promise<boolean> {
  if (!header?.startsWith("Bearer ") || header.length > 256) return false
  const encoder = new TextEncoder()
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(header.slice(7))),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ])
  const left = new Uint8Array(actual)
  const right = new Uint8Array(expected)
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
  return difference === 0
}

class PayloadError extends Error {
  constructor(readonly status: number) {
    super("Invalid payload")
  }
}

/** Bound memory while reading, including chunked requests without Content-Length. */
async function readBody(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length")
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new PayloadError(413)
  }
  if (!request.body) throw new PayloadError(400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PayloadError(408)), BODY_TIMEOUT_MS)
  })
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline])
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_BODY_BYTES) throw new PayloadError(413)
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => undefined)
  }
}

async function digest(key: CryptoKey, fields: string[]): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(JSON.stringify(fields))
  )
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/send") return reply("Not found", 404)
    if (request.method !== "POST") return reply("Method not allowed", 405)
    if (
      !env.EMAIL ||
      !env.DELIVERY ||
      !env.MAIL_FROM ||
      !env.LOGTO_EMAIL_TOKEN ||
      env.LOGTO_EMAIL_TOKEN.length < 32 ||
      !env.LOGTO_EMAIL_HASH_KEY ||
      env.LOGTO_EMAIL_HASH_KEY.length < 32 ||
      (env.LOGTO_EMAIL_PREVIOUS_TOKEN !== undefined && env.LOGTO_EMAIL_PREVIOUS_TOKEN.length < 32)
    ) {
      return reply("Email delivery unavailable", 503)
    }
    const header = request.headers.get("authorization")
    const [current, previous] = await Promise.all([
      authorized(header, env.LOGTO_EMAIL_TOKEN),
      env.LOGTO_EMAIL_PREVIOUS_TOKEN ? authorized(header, env.LOGTO_EMAIL_PREVIOUS_TOKEN) : false,
    ])
    if (!current && !previous) {
      return reply("Unauthorized", 401)
    }
    if (
      request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
    ) {
      return reply("JSON required", 415)
    }
    let body: unknown
    try {
      body = await readBody(request)
    } catch (error) {
      return reply("Invalid payload", error instanceof PayloadError ? error.status : 400)
    }
    if (
      !record(body) ||
      typeof body.to !== "string" ||
      body.to.length > 254 ||
      !/^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+\.[^\s@<>\x00-\x1f\x7f]+$/.test(body.to) ||
      typeof body.type !== "string" ||
      !Object.hasOwn(PURPOSES, body.type) ||
      !record(body.payload) ||
      typeof body.payload.code !== "string" ||
      !/^\d{6,8}$/.test(body.payload.code)
    ) {
      return reply("Invalid payload", 400)
    }
    const input: MailInput = {
      to: body.to,
      type: body.type as keyof typeof PURPOSES,
      code: body.payload.code,
      locale:
        typeof body.payload.locale === "string" && /^zh(?:-|$)/i.test(body.payload.locale)
          ? "zh"
          : "en",
    }
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(env.LOGTO_EMAIL_HASH_KEY),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      )
      const recipient = input.to.toLowerCase()
      const [name, message] = await Promise.all([
        digest(key, ["recipient", recipient]),
        digest(key, ["message", recipient, input.type, input.code]),
      ])
      return await env.DELIVERY.getByName(name).fetch(
        new Request("https://internal/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...input, digest: message }),
        })
      )
    } catch {
      // Never expose credentials, recipient addresses, OTPs or provider diagnostics.
      return reply("Email delivery unavailable", 503)
    }
  },
}

export default worker
