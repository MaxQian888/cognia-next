import {
  isResponseTooLarge,
  limitResponseBody,
  readBodyBounded,
  ResponseTooLargeError,
} from "./bounded-response"

function streamed(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, init)
}

describe("readBodyBounded", () => {
  it("returns a body within the ceiling", async () => {
    await expect(readBodyBounded(streamed(["ab", "cd"]), 4)).resolves.toBe("abcd")
  })

  it("refuses a declared length over the ceiling before reading", async () => {
    const res = new Response("x", { headers: { "content-length": "100" } })
    await expect(readBodyBounded(res, 10)).rejects.toBeInstanceOf(ResponseTooLargeError)
  })

  it("stops a streamed body at the first chunk past the ceiling", async () => {
    const error = await readBodyBounded(streamed(["abc", "def"]), 4).catch((e: unknown) => e)
    expect(isResponseTooLarge(error)).toBe(true)
  })

  it("checks text size when the transport exposes no stream", async () => {
    const fake = { headers: new Headers(), text: async () => "x".repeat(11) } as unknown as Response
    await expect(readBodyBounded(fake, 10)).rejects.toThrow(/ceiling/)
  })
})

describe("limitResponseBody", () => {
  it("passes small bodies through with status, headers and url", async () => {
    const res = streamed(['{"a":1}'], { status: 201, headers: { "x-k": "v" } })
    Object.defineProperty(res, "url", { value: "https://s.example/search" })
    const limited = limitResponseBody(res, 100)
    expect(limited.status).toBe(201)
    expect(limited.headers.get("x-k")).toBe("v")
    expect(limited.url).toBe("https://s.example/search")
    await expect(limited.json()).resolves.toEqual({ a: 1 })
  })

  it("makes json() fail once the body passes the ceiling", async () => {
    const limited = limitResponseBody(streamed(['{"a":"', "x".repeat(20), '"}']), 10)
    await expect(limited.json()).rejects.toThrow(/ceiling/)
  })

  it("refuses an oversized declared length immediately", () => {
    const res = new Response("x", { headers: { "content-length": "9999" } })
    expect(() => limitResponseBody(res, 10)).toThrow(ResponseTooLargeError)
  })

  it("leaves bodiless doubles and null-body statuses unchanged", () => {
    const fake = { status: 200, headers: new Headers() } as unknown as Response
    expect(limitResponseBody(fake, 10)).toBe(fake)
    const empty = new Response(null, { status: 204 })
    expect(limitResponseBody(empty, 10)).toBe(empty)
  })
})
