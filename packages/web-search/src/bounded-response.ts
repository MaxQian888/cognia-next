/**
 * Decoded-byte ceilings on HTTP response bodies, shared by Search and the
 * Reader so neither can buffer an unbounded body before its own output caps
 * apply. A declared `Content-Length` over the ceiling is refused before any
 * byte is read; a streamed body is cut off (and its source cancelled) at the
 * first chunk past the ceiling.
 */

export class ResponseTooLargeError extends Error {
  readonly ceiling: number
  constructor(ceiling: number) {
    super(`Response body exceeds the ${ceiling}-byte transport ceiling`)
    this.name = "ResponseTooLargeError"
    this.ceiling = ceiling
  }
}

export function isResponseTooLarge(error: unknown): error is ResponseTooLargeError {
  return error instanceof ResponseTooLargeError
}

function declaredLength(res: Response): number {
  return Number(res.headers?.get?.("content-length") ?? "")
}

/**
 * Read a body as text under `ceiling` decoded bytes. Streams when the
 * transport exposes a body stream, cancelling at the ceiling; otherwise reads
 * the text and checks its size (UTF-16 length is a lower bound on UTF-8 bytes,
 * enough to refuse a runaway).
 */
export async function readBodyBounded(res: Response, ceiling: number): Promise<string> {
  const declared = declaredLength(res)
  if (Number.isFinite(declared) && declared > ceiling) throw new ResponseTooLargeError(ceiling)
  const stream = (res as { body?: ReadableStream<Uint8Array> | null }).body
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let received = 0
    let text = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > ceiling) {
        await reader.cancel().catch(() => {})
        throw new ResponseTooLargeError(ceiling)
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  }
  const text = await res.text()
  if (text.length > ceiling) throw new ResponseTooLargeError(ceiling)
  return text
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

/**
 * Wrap a response so every later `json()` / `text()` / stream read stops at
 * `ceiling` bytes. Throws immediately on an oversized declared length. A
 * response without a readable stream (test doubles, some native bridges that
 * already bounded the body) is returned unchanged.
 */
export function limitResponseBody(res: Response, ceiling: number): Response {
  const declared = declaredLength(res)
  if (Number.isFinite(declared) && declared > ceiling) throw new ResponseTooLargeError(ceiling)
  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body
  if (
    !body ||
    typeof body.pipeThrough !== "function" ||
    typeof TransformStream === "undefined" ||
    typeof Response === "undefined" ||
    NULL_BODY_STATUSES.has(res.status)
  ) {
    return res
  }
  let received = 0
  const limited = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > ceiling) controller.error(new ResponseTooLargeError(ceiling))
        else controller.enqueue(chunk)
      },
    })
  )
  const bounded = new Response(limited, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
  // `url` is read-only on a constructed Response; keep the transport's final
  // URL so redirect/origin checks downstream still see it.
  if (res.url) Object.defineProperty(bounded, "url", { value: res.url })
  return bounded
}
