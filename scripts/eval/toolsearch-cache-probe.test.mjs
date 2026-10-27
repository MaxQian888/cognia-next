import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import {
  parseArgs,
  prepare,
  run,
  executeTrial,
  parseEventStream,
  normalizeUsage,
  summarize,
  sourceManifest,
  sanitizeCapture,
  createCampaignCancellation,
} from "./toolsearch-cache-probe.mjs"

function outputPath() {
  return path.resolve(".cache", `toolsearch-probe-test-${randomUUID()}`)
}

function completion(message, overrides = {}) {
  return {
    message: { role: "assistant", content: null, ...message },
    usage: { input: 1000, output: 20, cachedInput: 800 },
    durationMs: 10,
    ttftMs: 3,
    done: true,
    ...overrides,
  }
}

function localTransport({ amount = 20, observations = [] } = {}) {
  return async (body) => {
    observations.push(structuredClone(body))
    const name = body.tool_choice?.function?.name
    if (!name) return completion({ content: JSON.stringify({ files: 2, sum: amount }) })
    const prompt = body.messages.at(-1).content
    const args =
      name === "ToolSearch"
        ? { query: prompt.match(/select:(\w+)/)[0], limit: 1 }
        : name === "file_search"
          ? { directory: JSON.parse(prompt.match(/directory=("[^"\n]+")/)[1]), pattern: "**/*.txt" }
          : {
              directory: JSON.parse(prompt.match(/directory=("[^"\n]+")/)[1]),
              pattern: "amount=",
              extensions: ["txt"],
            }
    return completion({
      tool_calls: [
        {
          id: `call_${observations.length}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    })
  }
}

test("defaults to preparation and rejects unsafe or ambiguous launch options", () => {
  assert.equal(parseArgs([]).mode, "prepare")
  assert.equal(parseArgs([]).samples, 10)
  assert.equal(parseArgs([]).warmupPairs, 1)
  for (const args of [
    ["--run"],
    ["--run", "--prepare"],
    ["--samples", "0"],
    ["--samples", "1.5"],
    ["--samples", "21"],
    ["--timeout-ms", "0"],
    ["--output", "/tmp/unsafe"],
    ["--model", "another-model"],
    ["--run", "--output", outputPath(), "--samples", "2"],
  ])
    assert.throws(() => parseArgs(args))
})

test("preparation is offline, preserves existing output and binds its source manifest", async (t) => {
  const output = outputPath()
  t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => {
    throw new Error("unexpected network")
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const plan = await prepare({ ...parseArgs([]), output, samples: 1 })
  assert.equal(plan.model, "ark-deepseek-v4.1-flash")
  assert.equal(plan.maxConcurrency, 1)
  assert.equal(plan.plannedMaxRequests, 24)
  assert.equal(plan.schedule.length, 4)
  assert.deepEqual(
    plan.schedule.map((s) => s.arm),
    ["dynamic", "fixed", "fixed", "dynamic"]
  )
  assert.equal(plan.inferenceCalls, 0)
  assert.deepEqual(plan.manifest, sourceManifest())
  assert.ok(plan.catalog.toolNames.includes("content_search"))
  assert.ok(!plan.catalog.initialDynamicToolNames.includes("content_search"))
  await assert.rejects(prepare({ ...parseArgs([]), output }), /exist/i)
})

test("both arms execute real gated tools; only the dynamic palette changes", async (t) => {
  const output = outputPath()
  t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  const plan = await prepare({ ...parseArgs([]), output, samples: 1 })
  const results = []
  for (const arm of ["dynamic", "fixed"]) {
    const observations = []
    const result = await executeTrial({
      plan,
      output,
      trial: { arm, pair: 0, warmup: true },
      transport: localTransport({ observations }),
    })
    assert.equal(result.success, true)
    assert.equal(result.toolExecutions.length, 4)
    assert.ok(result.toolExecutions.every((r) => r.resultOK))
    assert.equal(result.requests.length, arm === "dynamic" ? 7 : 5)
    const variants = new Set(result.requests.map((r) => r.toolsHash))
    assert.equal(variants.size, arm === "dynamic" ? 3 : 1)
    assert.ok(observations.every((b) => b.model === plan.model))
    assert.deepEqual(result.answer, { files: 2, sum: 20 })
    results.push(result)
  }
  assert.deepEqual(
    results[0].toolExecutions.map((x) => x.result),
    results[1].toolExecutions.map((x) => x.result)
  )
})

test("outbound PII is rejected before invoking even the injected transport", async (t) => {
  const output = outputPath()
  t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  const plan = await prepare({ ...parseArgs([]), output, samples: 1 })
  plan.system += "\napi_key=sk-proj-FAKELEAKCHECK000000000000000000000000"
  let calls = 0
  const result = await executeTrial({
    plan,
    output,
    trial: { arm: "fixed", pair: 0, warmup: true },
    transport: async () => {
      calls++
      throw new Error("unexpected")
    },
  })
  assert.equal(calls, 0)
  assert.equal(result.success, false)
  assert.match(result.error, /PII/)
})

test("unexpected paths and invalid arguments cannot reach the tool handler", async (t) => {
  const output = outputPath()
  t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  const plan = await prepare({ ...parseArgs([]), output, samples: 1 })
  for (const [pair, args] of [{ directory: "/tmp" }, { directory: 7 }].entries()) {
    const result = await executeTrial({
      plan,
      output,
      trial: { arm: "fixed", pair, warmup: pair === 0 },
      transport: async () =>
        completion({
          tool_calls: [
            {
              id: "bad",
              type: "function",
              function: { name: "file_search", arguments: JSON.stringify(args) },
            },
          ],
        }),
    })
    assert.equal(result.success, false)
    assert.equal(result.toolExecutions.length, 0)
    assert.match(result.error, /arguments|workspace/)
  }
})

test("launch resource admission precedes credentials and network access", async (t) => {
  const output = outputPath()
  t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  await prepare({ ...parseArgs([]), output, samples: 1 })
  let credentials = 0
  await assert.rejects(
    run(output, {
      freeBytes: () => 100,
      loadKey: () => {
        credentials++
        throw new Error("unexpected")
      },
    }),
    /disk/i
  )
  assert.equal(credentials, 0)
  assert.equal(fs.existsSync(path.join(output, "admission.json")), false)
})

test("source drift is rejected before credentials or network access", async (t) => {
  const output = outputPath()
  t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  const plan = await prepare({ ...parseArgs([]), output, samples: 1 })
  plan.manifest["package.json"] = "changed"
  const serialized = JSON.stringify(plan, null, 2) + "\n"
  fs.writeFileSync(path.join(output, "plan.json"), serialized)
  const { createHash } = await import("node:crypto")
  fs.writeFileSync(
    path.join(output, "plan.sha256"),
    createHash("sha256").update(serialized).digest("hex") + "\n"
  )
  let credentials = 0
  await assert.rejects(
    run(output, {
      freeBytes: () => 8 * 1024 ** 3,
      loadKey: () => {
        credentials++
        throw new Error("unexpected")
      },
    }),
    /Source/
  )
  assert.equal(credentials, 0)
})

test("launch preserves existing trial reports before reading credentials", async (t) => {
  const output = outputPath()
  t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  await prepare({ ...parseArgs([]), output, samples: 1 })
  const report = path.join(output, "report.md")
  fs.writeFileSync(report, "previous result\n")
  let credentials = 0
  await assert.rejects(
    run(output, {
      freeBytes: () => 8 * 1024 ** 3,
      loadKey: () => {
        credentials++
        throw new Error("unexpected")
      },
    }),
    /Existing trial results/
  )
  assert.equal(credentials, 0)
  assert.equal(fs.readFileSync(report, "utf8"), "previous result\n")
})

test("missing usage stays unknown and cached input is never counted twice", () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, completion_tokens: 3 }), {
    input: 100,
    output: 3,
    cachedInput: null,
  })
  assert.deepEqual(normalizeUsage(undefined), { input: null, output: null, cachedInput: null })
  assert.deepEqual(
    normalizeUsage({ prompt_tokens: 100, completion_tokens: 3, prompt_cache_hit_tokens: 80 }),
    { input: 100, output: 3, cachedInput: 80 }
  )
  const trial = {
    arm: "fixed",
    pair: 1,
    warmup: false,
    success: true,
    durationMs: 100,
    requests: [
      {
        phase: "final",
        stage: 4,
        usage: { input: 100, output: 3, cachedInput: 80 },
        durationMs: 10,
        ttftMs: 2,
      },
    ],
  }
  const report = summarize([trial], { samples: 1 })
  assert.equal(report.arms.fixed.tokens.totalKnown, 103)
  assert.equal(report.arms.fixed.tokens.uncachedInputKnown, 20)
  assert.equal(report.arms.fixed.currencyCost, null)
  assert.equal(report.verdict, "inconclusive")
  trial.requests[0].usage = normalizeUsage(undefined)
  const incomplete = summarize([trial], { samples: 1 })
  assert.equal(incomplete.arms.fixed.tokens.complete, false)
  assert.equal(incomplete.arms.fixed.tokens.cacheRatio, null)
})

test("stream parser handles split UTF-8, reasoning and streamed tool arguments", async () => {
  const sse =
    [
      { choices: [{ delta: { reasoning_content: "inspect" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "file_search", arguments: '{"directory":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '"测试"}' } }] },
            finish_reason: "tool_calls",
          },
        ],
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      },
    ]
      .map((x) => `data: ${JSON.stringify(x)}\n\n`)
      .join("") + "data: [DONE]\n\n"
  const bytes = new TextEncoder().encode(sse)
  const response = new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3))
        c.close()
      },
    })
  )
  let tick = 0
  const result = await parseEventStream(response, { clock: () => ++tick, started: 0 })
  assert.equal(result.done, true)
  assert.equal(result.message.reasoning_content, "inspect")
  assert.equal(result.message.tool_calls[0].function.arguments, '{"directory":"测试"}')
  assert.equal(result.usage.cachedInput, 80)
  assert.ok(result.firstReasoningMs < result.firstToolMs)
  assert.equal(result.firstContentMs, null)
})

test("interrupted streams preserve partial usage and remain failed trials", async (t) => {
  const output = outputPath()
  t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  const plan = await prepare({ ...parseArgs([]), output, samples: 1 })
  const result = await executeTrial({
    plan,
    output,
    trial: { arm: "fixed", pair: 0, warmup: true },
    transport: async () => {
      let sent = false
      return parseEventStream(
        new Response(
          new ReadableStream({
            pull(controller) {
              if (sent) controller.error(new Error("stream interrupted"))
              else {
                sent = true
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":4,"prompt_cache_hit_tokens":80}}\n\n'
                  )
                )
              }
            },
          })
        )
      )
    },
  })
  assert.equal(result.success, false)
  assert.equal(result.requests[0].usage.input, 100)
  assert.equal(result.requests[0].usage.cachedInput, 80)
  assert.equal(result.requests[0].completed, false)
  assert.ok(fs.existsSync(path.join(output, "trials/0-fixed/request-01.response.json.gz")))
})

test("unknown timing and zero usage envelopes cannot improve statistics", () => {
  const result = {
    arm: "fixed",
    pair: 1,
    warmup: false,
    success: true,
    durationMs: 100,
    requests: [
      { usage: { input: 100, output: 1, cachedInput: 80 }, ttftMs: 10 },
      { usage: { input: 0, output: 0, cachedInput: 0 }, ttftMs: null },
    ],
  }
  const report = summarize([result], { samples: 1 })
  assert.deepEqual(report.arms.fixed.ttftMs, { n: 1, median: 10, mad: 0 })
  assert.equal(report.arms.fixed.tokens.complete, false)
  assert.equal(report.verdict, "inconclusive")
})

test("response retention decodes Unicode escapes and nested argument JSON before redaction", () => {
  const marker = "FAKELEAKCHECK000000000000000000000000"
  const text = String.raw`api_key=\u0073k-proj-` + marker
  const direct = `data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`
  const nested =
    "data: " +
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ function: { arguments: `{"pattern":"${text}"}` } }] } }],
    }) +
    "\n\n"
  const partial = direct.slice(0, -8)
  for (const source of [direct, nested, partial]) {
    const safe = sanitizeCapture(source, { role: "assistant", content: text })
    assert.ok(!safe.includes(marker))
    assert.ok(!safe.includes("sk-proj-"))
  }
})

test("retention cannot reassemble secrets split across streaming deltas", () => {
  const marker = "FAKELEAKCHECK000000000000000000000000"
  const raw = ["api_key=sk-pr", "oj-" + marker]
    .map((content) => "data: " + JSON.stringify({ choices: [{ delta: { content } }] }))
    .join("\n\n")
  const capture = sanitizeCapture(raw, { role: "assistant", content: "api_key=sk-proj-" + marker })
  assert.ok(!capture.includes(marker))
  assert.ok(!capture.includes("sk-proj-"))
  assert.equal(JSON.parse(capture).originalStreamRetained, false)
})

test("a failed observed warmup prevents an improvement verdict", () => {
  const results = []
  for (const arm of ["dynamic", "fixed"]) {
    for (let pair = 0; pair <= 10; pair++)
      results.push({
        arm,
        pair,
        warmup: pair === 0,
        success: true,
        durationMs: 100,
        requests: [
          {
            usage: { input: arm === "dynamic" ? 1000 : 100, output: 5, cachedInput: 0 },
            ttftMs: 10,
            done: true,
          },
        ],
      })
  }
  assert.equal(summarize(results, { samples: 10 }).verdict, "observed-mechanism-improvement")
  results[0].success = false
  assert.equal(summarize(results, { samples: 10 }).verdict, "inconclusive")
})

test("graceful campaign cancellation aborts active work and removes signal handlers", () => {
  const before = process.listenerCount("SIGINT")
  const cancellation = createCampaignCancellation()
  try {
    assert.equal(process.listenerCount("SIGINT"), before + 1)
    process.emit("SIGINT")
    assert.equal(cancellation.signal.aborted, true)
    assert.equal(cancellation.signal.reason.code, "CANCELLED")
  } finally {
    cancellation.dispose()
  }
  assert.equal(process.listenerCount("SIGINT"), before)
})

test("fixture additions are rejected before model or filesystem tool execution", async (t) => {
  const output = outputPath()
  t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  const plan = await prepare({ ...parseArgs([]), output, samples: 1 })
  fs.writeFileSync(
    path.join(plan.fixtures[0].workspace, "unexpected.txt"),
    "not an admitted fixture\n"
  )
  let calls = 0
  await assert.rejects(
    executeTrial({
      plan,
      output,
      trial: { arm: "fixed", pair: 0, warmup: true },
      transport: () => {
        calls++
        throw new Error("unexpected")
      },
    }),
    /Fixture/
  )
  assert.equal(calls, 0)
})
