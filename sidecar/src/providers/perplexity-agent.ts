/**
 * Perplexity Agent uses Open Responses, with preset requests and search_results
 * output extensions not understood by @ai-sdk/openai. Keep this fetch adapter
 * shared by the renderer, CLI and sidecar; all prompt/PII gates stay upstream.
 * https://docs.perplexity.ai/docs/agent-api/openai-compatibility
 */

type JsonObject = Record<string, unknown>

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function resolvePerplexityEndpoint({
  model,
  baseURL,
  apiFlavor,
}: {
  model: string
  baseURL?: string
  apiFlavor?: string
}): { baseURL: string | undefined; flavor: "chat" | "responses" } {
  // Explicit endpoint preferences and relay paths belong to the user. Only the
  // official host's documented root/version difference can be normalized.
  const flavor =
    apiFlavor === "chat" || apiFlavor === "responses"
      ? apiFlavor
      : /^sonar(?:-|$)/.test(model)
        ? "chat"
        : "responses"
  if (!baseURL || /^https:\/\/api\.perplexity\.ai(?:\/v1)?\/?$/.test(baseURL)) {
    return {
      baseURL: flavor === "chat" ? "https://api.perplexity.ai" : "https://api.perplexity.ai/v1",
      flavor,
    }
  }
  return { baseURL, flavor }
}

function searchAnnotations(item: unknown): JsonObject[] {
  if (!object(item) || item.type !== "search_results" || !Array.isArray(item.results)) return []
  return item.results.flatMap((result) => {
    if (!object(result) || typeof result.url !== "string") return []
    return [
      {
        type: "url_citation",
        url: result.url,
        title: typeof result.title === "string" ? result.title : result.url,
        start_index: 0,
        end_index: 0,
      },
    ]
  })
}

function normalizeUsage(value: unknown): unknown {
  if (!object(value) || !object(value.input_tokens_details)) return value
  const details = value.input_tokens_details
  return {
    ...value,
    input_tokens_details: {
      ...details,
      cached_tokens: details.cached_tokens ?? details.cache_read_input_tokens,
      cache_write_tokens: details.cache_write_tokens ?? details.cache_creation_input_tokens,
    },
  }
}

function normalizeResponse(value: JsonObject): JsonObject {
  const output = Array.isArray(value.output) ? value.output : []
  const annotations = output.flatMap(searchAnnotations)
  const seen = new Set<string>()
  const unique = annotations.filter((annotation) => {
    const url = annotation.url as string
    if (seen.has(url)) return false
    seen.add(url)
    return true
  })
  return {
    ...value,
    ...(value.usage ? { usage: normalizeUsage(value.usage) } : {}),
    ...(Array.isArray(value.output)
      ? {
          output: output
            .filter((item) => !object(item) || item.type !== "search_results")
            .map((item) => {
              if (!object(item) || item.type !== "message" || !Array.isArray(item.content))
                return item
              return {
                ...item,
                content: item.content.map((part) => {
                  if (!object(part) || part.type !== "output_text") return part
                  const existing = Array.isArray(part.annotations) ? part.annotations : []
                  return {
                    ...part,
                    annotations: [
                      ...existing,
                      ...unique.filter(
                        (entry) =>
                          !existing.some((prior) => object(prior) && prior.url === entry.url)
                      ),
                    ],
                  }
                }),
              }
            }),
        }
      : {}),
  }
}

function normalizedHeaders(response: Response): Headers {
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return headers
}

function normalizeStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""
  const sources = new Set<string>()
  const emit = (block: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    let value: unknown
    try {
      value = JSON.parse(data)
    } catch {
      controller.enqueue(encoder.encode(`${block}\n\n`))
      return
    }
    if (!object(value)) {
      controller.enqueue(encoder.encode(`${block}\n\n`))
      return
    }
    const annotations = [
      ...searchAnnotations(value.item),
      ...(object(value.response) && Array.isArray(value.response.output)
        ? value.response.output.flatMap(searchAnnotations)
        : []),
    ]
    if (
      value.type === "response.output_text.annotation.added" &&
      object(value.annotation) &&
      typeof value.annotation.url === "string"
    ) {
      if (sources.has(value.annotation.url)) return
      sources.add(value.annotation.url)
    }
    for (const annotation of annotations) {
      if (sources.has(annotation.url as string)) continue
      sources.add(annotation.url as string)
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "response.output_text.annotation.added", annotation })}\n\n`
        )
      )
    }
    if (object(value.item) && value.item.type === "search_results") return
    if (object(value.response)) value = { ...value, response: normalizeResponse(value.response) }
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
  }
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true })
        let match: RegExpExecArray | null
        while ((match = /\r?\n\r?\n/.exec(pending))) {
          emit(pending.slice(0, match.index), controller)
          pending = pending.slice(match.index + match[0].length)
        }
        // Bound malformed/incomplete event buffering without buffering the stream.
        if (pending.length > 1024 * 1024)
          throw new Error("Perplexity Agent SSE event exceeds 1 MiB")
      },
      flush(controller) {
        pending += decoder.decode()
        if (pending.trim()) emit(pending, controller)
      },
    })
  )
}

/** Wrap the existing gated fetch; do not perform any extra network request. */
export function withPerplexityAgentFetch(fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (!/\/(?:responses|agent)\/?(?:\?|$)/.test(url)) return fetchImpl(input, init)
    const request = new Request(input, init)
    if (request.method !== "POST") return fetchImpl(input, init)
    const parsed: unknown = await request.clone().json()
    if (!object(parsed)) return fetchImpl(input, init)
    const body = { ...parsed }
    if (typeof body.model === "string" && body.model.startsWith("preset/")) {
      const preset = body.model.slice("preset/".length)
      if (!["fast", "low", "medium", "high", "xhigh"].includes(preset))
        throw new Error(`Unsupported Perplexity preset: ${preset}`)
      delete body.model
      body.preset = preset
      // Empty SDK tool arrays must not disable the preset's built-in search.
      if (Array.isArray(body.tools) && body.tools.length === 0) delete body.tools
    }
    const response = await fetchImpl(new Request(request, { body: JSON.stringify(body) }))
    if (!response.ok || !response.body) return response
    const type = response.headers.get("content-type") ?? ""
    if (type.includes("text/event-stream")) {
      return new Response(normalizeStream(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers: normalizedHeaders(response),
      })
    }
    if (!type.includes("json")) return response
    const value: unknown = await response.json()
    return new Response(JSON.stringify(object(value) ? normalizeResponse(value) : value), {
      status: response.status,
      statusText: response.statusText,
      headers: normalizedHeaders(response),
    })
  }
}
