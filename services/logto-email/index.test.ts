/** @jest-environment node */

import worker, { type EmailMessage, type Env } from "./index"
import { renderEmail, type MailInput } from "./template"

const TOKEN = "test-only-token-0123456789abcdef0123456789abcdef"
const payload = { to: "person@example.com", type: "SignIn", payload: { code: "123456" } }

function setup() {
  const send = jest.fn(async (_message: EmailMessage) => ({ messageId: "message-1" }))
  const env: Env = {
    LOGTO_EMAIL_TOKEN: TOKEN,
    LOGTO_EMAIL_HASH_KEY: "test-only-hash-key-0123456789abcdef0123456789abcdef",
    MAIL_FROM: "login@status.cognia.cn",
    EMAIL: { send },
    DELIVERY: {
      getByName: jest.fn(() => ({
        fetch: async (request: Request) => {
          const input = (await request.json()) as MailInput
          try {
            await send(renderEmail(input, env.MAIL_FROM))
            return new Response("Accepted", { headers: { "cache-control": "no-store" } })
          } catch {
            return new Response("Email delivery failed", { status: 502 })
          }
        },
      })),
    },
  }
  const request = (body: unknown = payload, authorization = `Bearer ${TOKEN}`) =>
    new Request("https://email.test/send", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  return { send, env, request }
}

test("sends a Logto sign-in code through the email binding", async () => {
  const { send, env, request } = setup()
  const response = await worker.fetch(request(), env)
  expect(response.status).toBe(200)
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      from: { email: "login@status.cognia.cn", name: "Cognia" },
      to: "person@example.com",
      subject: "Your Cognia sign-in code",
      text: expect.stringContaining("123456"),
      html: expect.stringContaining("123456"),
    })
  )
  expect(await response.text()).not.toContain("123456")
  expect(response.headers.get("cache-control")).toBe("no-store")
})

test("supports overlapping secret rotation without changing recipient coordination", async () => {
  const { env, request } = setup()
  const oldToken = "old-test-token-0123456789abcdef0123456789abcdef"
  env.LOGTO_EMAIL_PREVIOUS_TOKEN = oldToken
  expect((await worker.fetch(request(payload, `Bearer ${oldToken}`), env)).status).toBe(200)
  expect((await worker.fetch(request(), env)).status).toBe(200)
  const names = jest.mocked(env.DELIVERY!.getByName).mock.calls.map(([name]) => name)
  expect(names[0]).toBe(names[1])
  expect(names[0]).not.toContain(payload.to)
  expect(names[0]).not.toContain(payload.payload.code)
})

test("fails closed without durable coordination or a stable hashing secret", async () => {
  const { env, request, send } = setup()
  expect((await worker.fetch(request(), { ...env, DELIVERY: undefined })).status).toBe(503)
  expect((await worker.fetch(request(), { ...env, LOGTO_EMAIL_HASH_KEY: "" })).status).toBe(503)
  expect(send).not.toHaveBeenCalled()
})

test("bounds the time spent waiting for a stalled request body", async () => {
  jest.useFakeTimers()
  try {
    const { env, send } = setup()
    let reading = false
    const body = new ReadableStream(
      {
        pull() {
          reading = true
        },
      },
      { highWaterMark: 0 }
    )
    const request = new Request("https://email.test/send", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit)
    const response = worker.fetch(request, env)
    const realImmediate =
      jest.requireActual<typeof import("node:timers")>("node:timers").setImmediate
    while (!reading) await new Promise<void>((resolve) => realImmediate(resolve))
    await jest.advanceTimersByTimeAsync(3001)
    expect((await response).status).toBe(408)
    expect(send).not.toHaveBeenCalled()
  } finally {
    jest.useRealTimers()
  }
})

test("renders Chinese mail for the Logto locale", async () => {
  const { send, env, request } = setup()
  await worker.fetch(request({ ...payload, payload: { code: "123456", locale: "zh-CN" } }), env)
  expect(send.mock.calls[0][0].subject).toBe("Cognia 登录验证码")
})

test.each(["", "Bearer wrong", `Bearer ${TOKEN}extra`])(
  "rejects unauthenticated requests without sending: %s",
  async (authorization) => {
    const { send, env, request } = setup()
    expect((await worker.fetch(request(payload, authorization), env)).status).toBe(401)
    expect(send).not.toHaveBeenCalled()
  }
)

test("fails closed when the secret or email binding is missing", async () => {
  const { send, env, request } = setup()
  expect((await worker.fetch(request(), { ...env, LOGTO_EMAIL_TOKEN: "" })).status).toBe(503)
  expect((await worker.fetch(request(), { ...env, EMAIL: undefined })).status).toBe(503)
  expect(send).not.toHaveBeenCalled()
})

test.each([
  null,
  { ...payload, to: ["a@example.com", "b@example.com"] },
  { ...payload, to: "a@example.com\r\nBcc: b@example.com" },
  { ...payload, type: "OrganizationInvitation" },
  { ...payload, payload: { code: "<script>" } },
  { ...payload, payload: {} },
])("rejects unsupported or malformed mail payloads: %j", async (body) => {
  const { send, env, request } = setup()
  expect((await worker.fetch(request(body), env)).status).toBe(400)
  expect(send).not.toHaveBeenCalled()
})

test("rejects malformed JSON, oversized bodies, and non-JSON content", async () => {
  const { send, env } = setup()
  for (const [body, contentType, status] of [
    ["{broken", "application/json", 400],
    ["x".repeat(16_385), "application/json", 413],
    [JSON.stringify(payload), "text/plain", 415],
  ] as const) {
    const request = new Request("https://email.test/send", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": contentType },
      body,
    })
    expect((await worker.fetch(request, env)).status).toBe(status)
  }
  expect(send).not.toHaveBeenCalled()
})

test("does not acknowledge a provider failure or expose its details", async () => {
  const { send, env, request } = setup()
  send.mockRejectedValueOnce(new Error("private provider details person@example.com 123456"))
  const response = await worker.fetch(request(), env)
  expect(response.status).toBe(502)
  expect(await response.text()).toBe("Email delivery failed")
})

test("supports the Logto code template usages without accepting caller-provided text", async () => {
  const { send, env, request } = setup()
  for (const type of ["Register", "ForgotPassword", "Generic"]) {
    expect(
      (await worker.fetch(request({ ...payload, type, text: "untrusted text" }), env)).status
    ).toBe(200)
  }
  expect(send).toHaveBeenCalledTimes(3)
  expect(JSON.stringify(send.mock.calls)).not.toContain("untrusted text")
})

test("exposes no other route or method", async () => {
  const { env, send } = setup()
  expect((await worker.fetch(new Request("https://email.test/"), env)).status).toBe(404)
  expect((await worker.fetch(new Request("https://email.test/send"), env)).status).toBe(405)
  expect(send).not.toHaveBeenCalled()
})

test("rejects an oversized stream before reading its entire body", async () => {
  const { send, env } = setup()
  let cancelled = false
  let chunksRead = 0
  const body = new ReadableStream({
    pull(controller) {
      chunksRead++
      if (chunksRead > 8) {
        controller.close()
        return
      }
      controller.enqueue(new Uint8Array(8192))
    },
    cancel() {
      cancelled = true
    },
  })
  const request = new Request("https://email.test/send", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit)
  expect((await worker.fetch(request, env)).status).toBe(413)
  expect(cancelled).toBe(true)
  expect(chunksRead).toBeLessThan(6)
  expect(send).not.toHaveBeenCalled()
})
