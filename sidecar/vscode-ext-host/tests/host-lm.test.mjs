// `vscode.lm` through the real host: the test plays the renderer, describing
// the app's model and answering the host's reads of each response.
import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"

import { activation, FIXTURES, startHost } from "./host-harness.mjs"

const ID = "cognia.lm-extension"
const PATH = join(FIXTURES, "lm-extension")

const MODEL = {
  id: "cognia/fixture",
  name: "Fixture Model",
  vendor: "cognia",
  family: "fixture",
  version: "fixture",
  maxInputTokens: 4096,
  canSendRequest: true,
}

/**
 * `send` answers `lm:sendChatRequest`; `reads` is what each
 * `lm:readChatResponse` answers, in order (a function waits on the test).
 */
async function startLm({ send = () => ({ ok: true }), reads = [], models = [MODEL] } = {}) {
  const commands = new Map()
  const requests = []
  const queue = [...reads]
  const host = startHost(ID, (method, params) => {
    requests.push({ method, params })
    if (method === "commands:register") {
      commands.set(params.command, params.token)
      return { registered: true }
    }
    if (method === "lm:selectChatModels") {
      return models.filter(
        (model) => params.selector.vendor === undefined || params.selector.vendor === model.vendor
      )
    }
    if (method === "lm:sendChatRequest") return send(params)
    if (method === "lm:readChatResponse") {
      const next = queue.shift() ?? { text: "", done: true }
      return typeof next === "function" ? next(params) : next
    }
    if (method === "lm:countTokens") return params.text.split(" ").length
    if (method === "lm:cancelChatRequest") return null
    if (method.startsWith("lm:register")) return { registered: false }
    return null
  })
  await host.request("extension:load", {
    extensionId: ID,
    extensionPath: PATH,
    main: "./extension.js",
    bundleFormat: "cjs",
    grantedModules: [],
  })
  await host.request("extension:activate", activation(ID, PATH))
  const run = (command) =>
    host.request("extension:call", { extensionId: ID, token: commands.get(command), payload: [] })
  const sent = (method) => requests.filter((entry) => entry.method === method)
  return { host, run, sent }
}

test("selectChatModels hands back working models, and access follows what the renderer said", async () => {
  const { host, run, sent } = await startLm()
  try {
    assert.deepEqual(await run("lmFixture.select"), {
      id: "cognia/fixture",
      name: "Fixture Model",
      vendor: "cognia",
      family: "fixture",
      version: "fixture",
      maxInputTokens: 4096,
      methods: ["function", "function"],
      before: "undefined",
      after: true,
      none: [],
    })
    assert.deepEqual(sent("lm:selectChatModels")[0].params, {
      extensionId: ID,
      selector: { vendor: "cognia" },
    })
  } finally {
    host.stop()
  }
})

test("sendRequest streams the reply in order; text and stream each replay it", async () => {
  const { host, run, sent } = await startLm({
    reads: [
      { text: "Hello", done: false },
      { text: ", ", done: false },
      { text: "world", done: true },
    ],
  })
  try {
    assert.deepEqual(await run("lmFixture.ask"), {
      text: "Hello, world",
      parts: [
        { isTextPart: true, value: "Hello" },
        { isTextPart: true, value: ", " },
        { isTextPart: true, value: "world" },
      ],
    })
    const [request] = sent("lm:sendChatRequest")
    assert.equal(request.params.extensionId, ID)
    assert.equal(request.params.modelId, "cognia/fixture")
    assert.deepEqual(request.params.messages, [
      { role: "user", content: "Say hello" },
      { role: "assistant", content: "Hello?" },
    ])
    assert.deepEqual(request.params.options, {
      justification: "a test",
      modelOptions: { temperature: 0 },
      toolCount: 0,
    })
    // Every read names the request the host started.
    assert.deepEqual(
      new Set(sent("lm:readChatResponse").map((entry) => entry.params.requestId)),
      new Set([request.params.requestId])
    )
  } finally {
    host.stop()
  }
})

test("a refused request throws the LanguageModelError the renderer named", async () => {
  for (const code of ["NoPermissions", "Blocked", "NotFound"]) {
    const { host, run } = await startLm({
      send: () => ({ error: { code, message: `refused: ${code}` } }),
    })
    try {
      assert.deepEqual(await run("lmFixture.refused"), {
        name: "LanguageModelError",
        code,
        message: `refused: ${code}`,
        isLanguageModelError: true,
        isCancellation: false,
      })
    } finally {
      host.stop()
    }
  }
})

test("a failure mid-reply ends the stream with that error, after the text so far", async () => {
  const { host, run } = await startLm({
    reads: [
      { text: "partial", done: false },
      { text: "", done: true, error: { code: "Blocked", message: "rate limited" } },
    ],
  })
  try {
    const result = await run("lmFixture.failsMidway")
    assert.equal(result.text, "partial")
    assert.equal(result.error.code, "Blocked")
    assert.equal(result.error.message, "rate limited")
    assert.equal(result.error.isLanguageModelError, true)
  } finally {
    host.stop()
  }
})

test("cancelling the token ends the reply with a CancellationError and tells the renderer", async () => {
  let release
  const { host, run, sent } = await startLm({
    reads: [
      { text: "first", done: false },
      // The renderer holds the next read until the cancel arrives.
      () => new Promise((resolve) => (release = resolve)),
    ],
  })
  try {
    const result = await run("lmFixture.cancel")
    assert.equal(result.text, "first")
    assert.equal(result.error.isCancellation, true)
    const [cancel] = sent("lm:cancelChatRequest")
    assert.equal(cancel.params.requestId, sent("lm:sendChatRequest")[0].params.requestId)
    release({ text: "", done: true, error: { code: "Cancelled", message: "Canceled" } })
  } finally {
    host.stop()
  }
})

test("messages with tool parts are refused before anything is sent", async () => {
  const { host, run, sent } = await startLm()
  try {
    assert.match(await run("lmFixture.toolParts"), /LanguageModelToolCallPart is not supported/)
    assert.equal(sent("lm:sendChatRequest").length, 0)
  } finally {
    host.stop()
  }
})

test("countTokens counts strings and messages through the renderer", async () => {
  const { host, run, sent } = await startLm()
  try {
    assert.deepEqual(await run("lmFixture.count"), [3, 2])
    assert.deepEqual(
      sent("lm:countTokens").map((entry) => entry.params.text),
      ["one two three", "four five"]
    )
  } finally {
    host.stop()
  }
})

test("tools: registering is reported and inert, and no tool can be invoked", async () => {
  const { host, run, sent } = await startLm()
  try {
    assert.deepEqual(await run("lmFixture.tools"), {
      tools: 0,
      invoke: 'Tool "fixture_search" was not found: no language model tools are available',
      toolMode: 2,
    })
    assert.deepEqual(sent("lm:registerTool")[0].params, { extensionId: ID, name: "fixture_search" })
  } finally {
    host.stop()
  }
})

test("lm:modelsChanged fires both change events and updates access", async () => {
  const { host, run } = await startLm()
  try {
    await run("lmFixture.select")
    await host.request("lm:modelsChanged", { models: [{ ...MODEL, canSendRequest: false }] })
    assert.deepEqual(await run("lmFixture.changes"), {
      modelsChanged: 1,
      accessChanged: 1,
      canSend: false,
    })
    await host.request("lm:modelsChanged", { models: [] })
    const after = await run("lmFixture.changes")
    assert.equal(after.modelsChanged, 2)
    assert.equal(after.canSend, undefined)
  } finally {
    host.stop()
  }
})
