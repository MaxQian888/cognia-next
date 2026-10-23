/** @jest-environment node */

import { EmailDelivery, SEND_TIMEOUT_MS, type DeliveryStorage, type StoredState } from "./delivery"
import type { Env } from "./index"
import { type EmailMessage, type MailInput } from "./template"

function fixture() {
  let data: StoredState | undefined
  let alarmTime: number | undefined
  let tail = Promise.resolve()
  const storage: DeliveryStorage = {
    get: jest.fn(async () => structuredClone(data)),
    put: jest.fn(async (_key, value) => {
      data = structuredClone(value)
    }),
    transaction: async (callback) => {
      const previous = tail
      let release!: () => void
      tail = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      const before = structuredClone(data)
      const previousAlarm = alarmTime
      try {
        return await callback(storage)
      } catch (error) {
        data = before
        alarmTime = previousAlarm
        throw error
      } finally {
        release()
      }
    },
    setAlarm: jest.fn(async (time) => {
      alarmTime = time
    }),
    deleteAll: jest.fn(async () => {
      data = undefined
    }),
  }
  const send = jest.fn(async (_mail: EmailMessage) => ({ messageId: "accepted-1" }))
  const env: Env = {
    EMAIL: { send },
    MAIL_FROM: "login@status.cognia.cn",
    LOGTO_EMAIL_TOKEN: "test-only-token-0123456789abcdef0123456789abcdef",
    LOGTO_EMAIL_HASH_KEY: "test-only-hash-key-0123456789abcdef0123456789abcdef",
  }
  const actor = () => new EmailDelivery({ storage, waitUntil: () => undefined }, env)
  const request = (digest = "a".repeat(64), code = "123456", type: MailInput["type"] = "SignIn") =>
    new Request("https://internal/send", {
      method: "POST",
      body: JSON.stringify({
        digest,
        to: "person@example.com",
        type,
        code,
        locale: "en",
      }),
    })
  return { storage, send, env, actor, request, read: () => data }
}

afterEach(() => jest.useRealTimers())

test("coalesces 32 concurrent requests and persists acceptance across actor restarts", async () => {
  const f = fixture()
  const actor = f.actor()
  const responses = await Promise.all(Array.from({ length: 32 }, () => actor.fetch(f.request())))
  expect(responses.every((r) => r.status === 200)).toBe(true)
  expect(f.send).toHaveBeenCalledTimes(1)
  expect((await f.actor().fetch(f.request())).status).toBe(200)
  expect(f.send).toHaveBeenCalledTimes(1)
  const persisted = JSON.stringify(f.read())
  expect(persisted).not.toContain("person@example.com")
  expect(persisted).not.toContain("123456")
})

test("does not acknowledge duplicates until the provider accepts", async () => {
  const f = fixture()
  let accept!: (value: { messageId: string }) => void
  f.send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        accept = resolve
      })
  )
  const actor = f.actor()
  let completed = false
  const pending = Promise.all([actor.fetch(f.request()), actor.fetch(f.request())]).then((r) => {
    completed = true
    return r
  })
  while (!accept) await new Promise((resolve) => setImmediate(resolve))
  expect(completed).toBe(false)
  accept({ messageId: "accepted" })
  expect((await pending).every((r) => r.status === 200)).toBe(true)
  expect(f.send).toHaveBeenCalledTimes(1)
})

test("reserves a send and its cleanup alarm atomically, allowing retry if alarm setup fails", async () => {
  const f = fixture()
  jest.mocked(f.storage.setAlarm).mockRejectedValueOnce(new Error("alarm unavailable"))
  const actor = f.actor()
  expect((await actor.fetch(f.request())).status).toBe(503)
  expect(f.send).not.toHaveBeenCalled()
  expect(f.read()).toBeUndefined()
  expect((await actor.fetch(f.request())).status).toBe(200)
  expect(f.send).toHaveBeenCalledTimes(1)
})

test("concurrent distinct codes for one recipient cannot bypass the cooldown", async () => {
  const f = fixture()
  const actor = f.actor()
  const results = await Promise.all(
    Array.from({ length: 32 }, (_, i) => actor.fetch(f.request(i.toString(16).padStart(64, "0"))))
  )
  expect(results.filter((result) => result.status === 200)).toHaveLength(1)
  expect(results.filter((result) => result.status === 429)).toHaveLength(31)
  expect(f.send).toHaveBeenCalledTimes(1)
})

test("failed acceptance persistence stays pending across restart and never acknowledges or resends", async () => {
  const f = fixture()
  const put = jest.mocked(f.storage.put)
  put
    .mockImplementationOnce(put.getMockImplementation()!)
    .mockRejectedValueOnce(new Error("commit unavailable"))
  expect((await f.actor().fetch(f.request())).status).toBe(503)
  expect((await f.actor().fetch(f.request())).status).toBe(503)
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(Object.values(f.read()!.deliveries)[0].status).toBe("pending")
})

test("enforces cooldown across purposes, then admits another code", async () => {
  jest.useFakeTimers({ now: 1_800_000_000_000 })
  const f = fixture()
  const actor = f.actor()
  expect((await actor.fetch(f.request())).status).toBe(200)
  const denied = await actor.fetch(f.request("b".repeat(64), "654321", "Register"))
  expect(denied.status).toBe(429)
  expect(denied.headers.get("retry-after")).toBe("60")
  jest.setSystemTime(Date.now() + 60_000)
  expect((await actor.fetch(f.request("b".repeat(64), "654321"))).status).toBe(200)
  expect(f.send).toHaveBeenCalledTimes(2)
})

test("bounds hourly sends and releases quota with a sliding window", async () => {
  jest.useFakeTimers({ now: 1_800_000_000_000 })
  const f = fixture()
  const actor = f.actor()
  for (let index = 0; index < 10; index++) {
    expect((await f.actor().fetch(f.request(String(index).repeat(64)))).status).toBe(200)
    jest.setSystemTime(Date.now() + 60_000)
  }
  expect((await actor.fetch(f.request("b".repeat(64)))).status).toBe(429)
  jest.setSystemTime(Date.now() + 3_600_000)
  expect((await actor.fetch(f.request("b".repeat(64)))).status).toBe(200)
  expect(f.send).toHaveBeenCalledTimes(11)
})

test("keeps unknown provider failures from triggering a duplicate send", async () => {
  const f = fixture()
  f.send.mockRejectedValueOnce(new Error("private email and OTP"))
  expect((await f.actor().fetch(f.request())).status).toBe(502)
  expect((await f.actor().fetch(f.request())).status).toBe(503)
  expect(f.send).toHaveBeenCalledTimes(1)
})

test("times out without resending and records a late acceptance", async () => {
  jest.useFakeTimers({ now: 1_800_000_000_000 })
  const f = fixture()
  let accept!: (value: { messageId: string }) => void
  f.send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        accept = resolve
      })
  )
  const actor = f.actor()
  const pending = actor.fetch(f.request())
  await jest.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 1)
  expect((await pending).status).toBe(503)
  expect((await f.actor().fetch(f.request())).status).toBe(503)
  expect(f.send).toHaveBeenCalledTimes(1)
  accept({ messageId: "late-accepted" })
  await jest.advanceTimersByTimeAsync(0)
  expect((await f.actor().fetch(f.request())).status).toBe(200)
  expect(f.send).toHaveBeenCalledTimes(1)
})

test("fails closed on storage errors and cleans expired state with an alarm", async () => {
  jest.useFakeTimers({ now: 1_800_000_000_000 })
  const f = fixture()
  const actor = f.actor()
  await actor.fetch(f.request())
  await actor.alarm()
  expect(f.storage.deleteAll).not.toHaveBeenCalled()
  jest.setSystemTime(Date.now() + 3_600_001)
  await actor.alarm()
  expect(f.read()).toBeUndefined()
  jest.mocked(f.storage.get).mockRejectedValueOnce(new Error("storage unavailable"))
  expect((await actor.fetch(f.request())).status).toBe(503)
  expect(f.send).toHaveBeenCalledTimes(1)
})
