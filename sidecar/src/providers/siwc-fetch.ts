/** Secret-free Responses transport shared by the sidecar and desktop renderer. */
export const SIWC_PROTOCOL = "chatgpt-siwc"
export const SIWC_RESPONSES_BASE_URL = "https://siwc.cognia.invalid/v1"
/** Satisfies the SDK's required key without consulting OPENAI_API_KEY. Never sent natively. */
export const SIWC_SDK_PLACEHOLDER = "cognia-native-siwc"

export interface SiwcConnectionReference {
  localAccountId: string
  connectionId: string
}

export type SiwcNativeCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

function assertReference(ref: SiwcConnectionReference): void {
  for (const value of [ref.localAccountId, ref.connectionId]) {
    if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error("SIWC connection reference is invalid")
    }
  }
}

export function encodeSiwcReference(ref: SiwcConnectionReference): string {
  assertReference(ref)
  return `siwc://${encodeURIComponent(ref.localAccountId)}/${encodeURIComponent(ref.connectionId)}`
}

export function decodeSiwcReference(value: unknown): SiwcConnectionReference {
  if (typeof value !== "string") throw new Error("SIWC connection reference is required")
  const match = /^siwc:\/\/([^/?#]+)\/([^/?#]+)$/.exec(value)
  if (!match) throw new Error("SIWC connection reference is invalid")
  try {
    const ref = {
      localAccountId: decodeURIComponent(match[1]!),
      connectionId: decodeURIComponent(match[2]!),
    }
    assertReference(ref)
    return ref
  } catch {
    throw new Error("SIWC connection reference is invalid")
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError")
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SIWC native response is invalid")
  }
  return value as Record<string, unknown>
}

/** The native Host owns endpoint, authorization, refresh and final-wire policy. */
export function createSiwcFetch(
  reference: SiwcConnectionReference,
  call: SiwcNativeCall
): typeof globalThis.fetch {
  assertReference(reference)
  const ref = { ...reference }
  return async (input, init) => {
    const request = new Request(input, init)
    if (request.signal.aborted) throw abortError()
    if (request.url !== `${SIWC_RESPONSES_BASE_URL}/responses` || request.method !== "POST") {
      throw new Error("SIWC supports only native Responses requests")
    }
    const body = await request.text()
    try {
      const parsed: unknown = JSON.parse(body)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
    } catch {
      throw new Error("SIWC Responses body must be a JSON object")
    }
    if (request.signal.aborted) throw abortError()
    const requestId = globalThis.crypto.randomUUID()
    let streamId: string | undefined
    let completed = false
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    let rejectAbort!: (reason: Error) => void
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject
    })
    // Reads may outlive the initial head race. Keep the rejection observed.
    void aborted.catch(() => undefined)
    const cancelNative = () =>
      call("siwc.responses.cancel", {
        localAccountId: ref.localAccountId,
        requestId,
        ...(streamId ? { streamId } : {}),
      }).catch(() => undefined)
    const cleanup = () => request.signal.removeEventListener("abort", onAbort)
    const onAbort = () => {
      if (completed) return
      completed = true
      const error = abortError()
      rejectAbort(error)
      streamController?.error(error)
      cleanup()
      void cancelNative()
    }
    request.signal.addEventListener("abort", onAbort, { once: true })
    if (request.signal.aborted) onAbort()
    try {
      const opening = call("siwc.responses.open", { ...ref, requestId, body }).then((value) => {
        const head = record(value)
        if (typeof head.streamId !== "string" || !head.streamId)
          throw new Error("SIWC native stream id is missing")
        streamId = head.streamId
        if (completed) void cancelNative()
        return head
      })
      const head = await Promise.race([opening, aborted])
      const status = head.status
      if (typeof status !== "number" || status < 200 || status > 599 || !Number.isInteger(status)) {
        throw new Error("SIWC native response status is invalid")
      }
      const headers = record(head.headers)
      if (Object.values(headers).some((value) => typeof value !== "string"))
        throw new Error("SIWC native headers are invalid")
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            streamController = controller
          },
          async pull(controller) {
            if (completed) return
            try {
              const value = record(
                await Promise.race([
                  call("siwc.responses.read", { localAccountId: ref.localAccountId, streamId }),
                  aborted,
                ])
              )
              if (completed) return
              if (value.done === true) {
                completed = true
                cleanup()
                controller.close()
                return
              }
              if (
                value.done !== false ||
                typeof value.chunkBase64 !== "string" ||
                !value.chunkBase64 ||
                value.chunkBase64.length > 2 * 1024 * 1024
              ) {
                throw new Error("SIWC native stream chunk is invalid")
              }
              const binary = atob(value.chunkBase64)
              controller.enqueue(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
            } catch (error) {
              if (!completed) controller.error(error)
              completed = true
              cleanup()
              await cancelNative()
            }
          },
          async cancel() {
            completed = true
            cleanup()
            await cancelNative()
          },
        },
        { highWaterMark: 0 }
      )
      if ([204, 205, 304].includes(status)) {
        completed = true
        cleanup()
        await cancelNative()
        return new Response(null, { status, headers: headers as Record<string, string> })
      }
      return new Response(stream, { status, headers: headers as Record<string, string> })
    } catch (error) {
      completed = true
      cleanup()
      await cancelNative()
      throw error
    }
  }
}
