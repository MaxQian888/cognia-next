import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"

import { renderCard, sendWebhook } from "./transport.mjs"

const url = "https://open.feishu.cn/open-apis/bot/v2/hook/test-token"
const input = { url, secret: "demo-secret", body: renderCard({ title: "CI", lines: ["Failed"] }) }
const response = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers })
const nodes = (value) => {
  if (!value || typeof value !== "object") return []
  return [value, ...Object.values(value).flatMap(nodes)]
}
const buttons = (body) => nodes(body).filter((item) => item.tag === "button")

test("renders literal untrusted text and only bounded GitHub HTTPS actions", () => {
  const card = renderCard({
    title: "<at id=all></at> **CI**",
    level: "error",
    lines: ["[click](https://evil.test) <at id=all></at>", "✅".repeat(30_000)],
    actions: [
      { label: "Run", url: "https://github.com/acme/repo/actions/runs/123" },
      { label: "Malicious", url: "https://github.com.evil.test/" },
      { label: "Userinfo", url: "https://secret@github.com/" },
      { label: "Port", url: "https://github.com:444/" },
    ],
  })
  assert.equal(card.msg_type, "interactive")
  assert.equal(card.card.header.template, "red")
  assert.equal(card.card.header.title.tag, "plain_text")
  assert.equal(card.card.schema, "2.0")
  assert.equal(card.card.body.elements[0].text.tag, "plain_text")
  assert.match(card.card.body.elements[0].text.content, /<at id=all>/)
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 18_000)
  assert.equal(buttons(card).length, 1)
  assert.doesNotMatch(JSON.stringify(card), /lark_md/)
  assert.doesNotMatch(JSON.stringify(buttons(card)), /evil\.test|secret@/)
})

test("bounds JSON bytes even with escaped text and large action URLs", () => {
  const card = renderCard({
    title: '"'.repeat(20_000),
    level: "__proto__",
    lines: Array(100).fill('"\\\n'.repeat(20_000)),
    actions: Array(100).fill({
      label: '"'.repeat(200),
      ref: `https://github.com/${"x".repeat(1900)}`,
    }),
  })
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 18_000)
  assert.equal(card.card.header.template, "blue")
  assert.equal(buttons(card).length, 3)
})

test("renders Card2 hierarchy with metrics, section actions and one primary action", () => {
  const card = renderCard({
    title: "Build failed",
    level: "error",
    subtitle: "acme/cognia · main",
    summary: "Two checks need attention.",
    tags: ["CI", "FAILED", "main", "extra"],
    metrics: [
      { label: "Duration", value: "3m 42s" },
      { label: "Failed", value: 2 },
      { label: "Passed", value: "16" },
    ],
    actions: [
      { label: "Open run", url: "https://github.com/acme/cognia/actions/runs/42" },
      { label: "Reports", url: "https://github.com/acme/cognia/actions/runs/42#artifacts" },
    ],
    sections: [
      {
        title: "Failed checks",
        lines: ["quality / lint", "test / unit"],
        actions: [
          { label: "Open failed job", url: "https://github.com/acme/cognia/actions/runs/42/job/7" },
        ],
      },
      { title: "Release", lines: ["No release was published."] },
    ],
    footer: "Cognia · GitHub Actions",
  }).card
  assert.equal(card.schema, "2.0")
  assert.equal(card.elements, undefined)
  assert.equal(card.config.wide_screen_mode, undefined)
  assert.equal(card.header.subtitle.content, "acme/cognia · main")
  assert.equal(card.header.text_tag_list.length, 3)
  assert.ok(card.header.text_tag_list.every((tag) => tag.text.tag === "plain_text"))
  assert.equal(card.config.summary.content, "Two checks need attention.")
  const metricRows = card.body.elements.filter(
    (node) => node.tag === "column_set" && node.flex_mode === "bisect"
  )
  assert.equal(metricRows.length, 2)
  assert.equal(metricRows[0].columns.length, 2)
  assert.equal(metricRows[0].columns[1].elements[1].text.content, "2")
  assert.equal(metricRows[0].columns[0].elements[0].text.text_size, "notation")
  assert.equal(metricRows[0].columns[0].elements[1].text.text_size, "heading-2")
  assert.equal(buttons(card).filter((button) => button.type === "primary_filled").length, 1)
  assert.ok(
    buttons(card)
      .slice(1)
      .every((button) => button.type === "default")
  )
  assert.ok(buttons(card).every((button) => !button.url && button.behaviors[0].type === "open_url"))
  assert.equal(card.body.elements.at(-1).text.content, "Cognia · GitHub Actions")
  assert.equal(card.body.elements.at(-1).text.text_size, "notation")
  assert.ok(card.body.elements.some((node) => node.tag === "hr"))
  assert.ok(
    nodes(card)
      .filter((node) => node.tag)
      .every((node) => !["action", "note", "lark_md", "markdown"].includes(node.tag))
  )
})

test("preserves summary, main CTA and early section evidence when pruning pathological input", () => {
  const marker = "<at id=all></at> **untrusted** "
  const card = renderCard({
    title: "FAILED",
    level: "error",
    subtitle: marker,
    summary: "Critical: signing failed",
    tags: [marker],
    metrics: Array.from({ length: 20 }, (_, index) => ({
      label: `Metric ${index}`,
      value: "9".repeat(900),
    })),
    lines: Array(100).fill('"\\\n'.repeat(2000)),
    sections: Array.from({ length: 30 }, (_, index) => ({
      title: `Section ${index}`,
      lines: [`Evidence ${index}: ${marker}`, ...Array(20).fill('"\\\n'.repeat(2000))],
      actions: Array.from({ length: 10 }, (_, action) => ({
        label: `Action ${action}`,
        url: `https://github.com/acme/cognia/${"x".repeat(1800)}?section=${index}&action=${action}`,
      })),
    })),
    actions: [{ label: "Open source", url: "https://github.com/acme/cognia/actions/runs/42" }],
    footer: "Preserve source conclusions",
  })
  const serialized = JSON.stringify(card)
  assert.ok(Buffer.byteLength(serialized) < 18_000)
  assert.match(serialized, /Critical: signing failed/)
  assert.match(serialized, /Evidence 0:/)
  assert.match(serialized, /Section 5/)
  assert.doesNotMatch(serialized, /Section 6/)
  assert.match(serialized, /shortened or omitted/)
  assert.equal(
    buttons(card).find((button) => button.type === "primary_filled").behaviors[0].default_url,
    "https://github.com/acme/cognia/actions/runs/42"
  )
  assert.ok(nodes(card).filter((node) => node.tag).length <= 200)
  assert.ok(
    nodes(card)
      .filter((node) => typeof node.content === "string" && node.tag)
      .every((node) => node.tag === "plain_text")
  )
  assert.doesNotMatch(serialized, /lark_md|"tag":"action"|"url":/)
})

test("retains six useful sections and bounds all action groups", () => {
  const action = { label: "Open", url: "https://github.com/acme/cognia" }
  const card = renderCard({
    title: "Summary",
    sections: Array.from({ length: 6 }, (_, index) => ({
      title: `Section ${index}`,
      lines: ["Useful detail"],
      actions: Array(5).fill(action),
    })),
  })
  assert.equal(buttons(card).length, 18)
  assert.equal(buttons(card).filter((button) => button.type === "primary_filled").length, 1)
  assert.ok(nodes(card).filter((node) => node.tag).length <= 200)
  for (let index = 0; index < 6; index++)
    assert.match(JSON.stringify(card), new RegExp(`Section ${index}`))
})

test("retains all fifteen workflow digest lines without an omission notice", () => {
  const lines = Array.from(
    { length: 15 },
    (_, index) => `Workflow ${index + 1}: 2 passed / 1 failed`
  )
  const card = renderCard({
    title: "Daily workflows",
    sections: [{ title: "Workflow breakdown", lines }],
    actions: [{ label: "Open Actions", url: "https://github.com/acme/cognia/actions" }],
  })
  assert.equal(
    card.card.body.elements.find((element) => element.text?.content === lines.join("\n"))?.text.tag,
    "plain_text"
  )
  assert.doesNotMatch(JSON.stringify(card), /shortened or omitted/)
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 18_000)
})

test("signs and posts via an injected boundary to a real loopback server", async (t) => {
  let received
  const server = createServer(async (request, reply) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received = JSON.parse(Buffer.concat(chunks).toString())
    reply.writeHead(200, { "content-type": "application/json" })
    reply.end('{"code":0}')
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const result = await sendWebhook({
    ...input,
    now: () => 1599360473000,
    fetchImpl: (target, options) => {
      assert.equal(target, url)
      assert.equal(options.redirect, "error")
      return fetch(`http://127.0.0.1:${server.address().port}`, options)
    },
  })
  assert.deepEqual(result, { outcome: "accepted", attempts: 1, code: 0 })
  assert.equal(received.timestamp, "1599360473")
  assert.equal(received.sign, "3/MaVZ8JLIy4TUG+7KSFJqvUkTKd+HWY8g+56DZWq8s=")
  assert.equal(input.body.sign, undefined)
})

test("fails closed on missing credentials and invalid endpoint before fetch", async () => {
  const fetchImpl = () => assert.fail("must not send")
  for (const target of [
    "http://open.feishu.cn/open-apis/bot/v2/hook/test-token",
    "https://open.feishu.cn.evil.test/open-apis/bot/v2/hook/test-token",
    `${url}?token=secret`,
    `${url}#secret`,
    "https://secret@open.feishu.cn/open-apis/bot/v2/hook/test-token",
    "https://open.feishu.cn:443/open-apis/bot/v2/hook/test-token",
    "https://open.feishu.cn/open-apis/bot/v2/hook/../test-token",
  ]) {
    assert.deepEqual(await sendWebhook({ ...input, url: target, fetchImpl }), {
      outcome: "invalid-target",
      attempts: 0,
    })
  }
  assert.deepEqual(await sendWebhook({ ...input, secret: "", fetchImpl }), {
    outcome: "auth-failed",
    attempts: 0,
  })
})

test("requires a numeric business code and classifies refusals without exposing messages", async () => {
  for (const [payload, expected] of [
    [{ code: 19021, msg: url }, "auth-failed"],
    [{ code: 19024, msg: url }, "rejected"],
    [{ code: 1, msg: "frequency signature secret" }, "rejected"],
    [{ StatusCode: 0 }, "delivery-unknown"],
    [{ code: "0" }, "delivery-unknown"],
    [null, "delivery-unknown"],
  ]) {
    const result = await sendWebhook({ ...input, fetchImpl: async () => response(payload) })
    assert.equal(result.outcome, expected)
    assert.equal(result.attempts, 1)
    assert.doesNotMatch(JSON.stringify(result), /secret|https/)
  }
})

test("only retries definite rate limits with bounded Retry-After", async () => {
  for (const first of [response({}, 429, { "retry-after": "2" }), response({ code: 11232 })]) {
    let calls = 0
    const sleeps = []
    const result = await sendWebhook({
      ...input,
      fetchImpl: async () => (++calls === 1 ? first : response({ code: 0 })),
      sleep: async (ms) => sleeps.push(ms),
    })
    assert.equal(result.outcome, "accepted")
    assert.equal(result.attempts, 2)
    assert.equal(sleeps.length, 1)
    assert.ok(sleeps[0] >= 1000 && sleeps[0] <= 30_000)
  }
  const sleeps = []
  const result = await sendWebhook({
    ...input,
    maxAttempts: 100,
    fetchImpl: async () => response({}, 429),
    sleep: async (ms) => sleeps.push(ms),
  })
  assert.equal(result.outcome, "rate-limited")
  assert.equal(result.attempts, 3)
  assert.deepEqual(sleeps, [1000, 2000])
})

test("does not retry sooner than a Retry-After exceeding the wait budget", async () => {
  const now = () => Date.parse("2026-10-03T00:00:00Z")
  for (const header of ["31", "9999999", "9".repeat(400), "Sat, 03 Oct 2026 00:02:00 GMT"]) {
    for (const status of [200, 429]) {
      let calls = 0
      const sleeps = []
      const result = await sendWebhook({
        ...input,
        now,
        fetchImpl: async () =>
          ++calls === 1
            ? response({ code: 11232 }, status, { "retry-after": header })
            : response({ code: 0 }),
        sleep: async (ms) => sleeps.push(ms),
      })
      assert.equal(result.outcome, "rate-limited")
      assert.equal(result.attempts, 1)
      assert.equal(calls, 1)
      assert.deepEqual(sleeps, [])
    }
  }
})

test("honors numeric and HTTP-date Retry-After within the wait budget", async () => {
  const now = () => Date.parse("2026-10-03T00:00:00Z")
  for (const [header, delay] of [
    ["30", 30_000],
    ["Sat, 03 Oct 2026 00:00:20 GMT", 20_000],
  ]) {
    let calls = 0
    const sleeps = []
    const result = await sendWebhook({
      ...input,
      now,
      fetchImpl: async () =>
        ++calls === 1 ? response({}, 429, { "retry-after": header }) : response({ code: 0 }),
      sleep: async (ms) => sleeps.push(ms),
    })
    assert.equal(result.outcome, "accepted")
    assert.equal(result.attempts, 2)
    assert.deepEqual(sleeps, [delay])
  }
})

test("does not retry ambiguous delivery or redirects", async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error(`Timeout ${url}`)
    },
    async () => response({}, 503),
    async () => new Response("invalid", { status: 200 }),
    async () => new Response("x".repeat(20_000), { status: 200 }),
    async () => response({}, 302),
  ]) {
    let calls = 0
    const result = await sendWebhook({
      ...input,
      fetchImpl: (...args) => {
        calls++
        return fetchImpl(...args)
      },
      sleep: () => assert.fail("must not retry"),
    })
    assert.equal(calls, 1)
    assert.ok(["delivery-unknown", "rejected"].includes(result.outcome))
    assert.doesNotMatch(JSON.stringify(result), /secret|https/)
  }
})

test("classifies HTTP auth and target refusals and accepts Lark endpoints", async () => {
  for (const [status, outcome] of [
    [401, "auth-failed"],
    [403, "auth-failed"],
    [404, "invalid-target"],
    [410, "invalid-target"],
    [400, "rejected"],
  ]) {
    assert.deepEqual(await sendWebhook({ ...input, fetchImpl: async () => response({}, status) }), {
      outcome,
      attempts: 1,
    })
  }
  assert.equal(
    (
      await sendWebhook({
        ...input,
        url: url.replace("open.feishu.cn", "open.larksuite.com"),
        fetchImpl: async () => response({ code: 0 }),
      })
    ).outcome,
    "accepted"
  )
})

test("rejects invalid or oversized outgoing bodies with safe fixed errors", async () => {
  const circular = {}
  circular.self = circular
  for (const body of [null, circular, { msg_type: "text", content: "x".repeat(20_000) }]) {
    await assert.rejects(
      sendWebhook({ ...input, body, fetchImpl: () => assert.fail("must not send") }),
      /^Error: Invalid Feishu notification body$/
    )
  }
})

test("enforces the deadline even when the fetch boundary ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let started
  let signal
  const fetchStarted = new Promise((resolve) => {
    started = resolve
  })
  const pending = sendWebhook({
    ...input,
    fetchImpl: async (_url, options) => {
      signal = options.signal
      started()
      return new Promise(() => {})
    },
    sleep: () => assert.fail("must not retry"),
  })
  await fetchStarted
  t.mock.timers.tick(10_000)
  assert.deepEqual(await pending, { outcome: "delivery-unknown", attempts: 1 })
  assert.equal(signal.aborted, true)
})

test("enforces the same deadline while reading a stalled response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let reading
  const readStarted = new Promise((resolve) => {
    reading = resolve
  })
  const pending = sendWebhook({
    ...input,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          pull() {
            reading()
          },
        })
      ),
    sleep: () => assert.fail("must not retry"),
  })
  await readStarted
  t.mock.timers.tick(10_000)
  assert.deepEqual(await pending, { outcome: "delivery-unknown", attempts: 1 })
})
