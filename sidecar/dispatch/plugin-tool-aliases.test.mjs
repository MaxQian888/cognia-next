import { test } from "node:test"
import assert from "node:assert/strict"

import {
  bareNameOnServer,
  modelPluginToolName,
  modelPluginToolNameList,
  planPluginToolNames,
  qualifiedPluginToolName,
  restorePluginToolName,
  restorePluginToolNamesInSdkMessage,
} from "./plugin-tool-aliases.mjs"

const SERVER = "cognia-plugin-tools"

test("planPluginToolNames renames only what a provider would reject", () => {
  const { modelNameOf, aliases } = planPluginToolNames([
    { name: "ocr.extract" },
    { name: "docs/search" },
    { name: "sandbox_bash" },
  ])
  assert.equal(modelNameOf.get("ocr.extract"), "ocr_extract")
  assert.equal(modelNameOf.get("docs/search"), "docs_search")
  assert.equal(modelNameOf.has("sandbox_bash"), false)
  assert.deepEqual(
    [...aliases],
    [
      ["ocr_extract", "ocr.extract"],
      ["docs_search", "docs/search"],
    ]
  )
})

test("planPluginToolNames keeps a renamed tool distinct from a safe one it would collide with", () => {
  const { modelNameOf } = planPluginToolNames([{ name: "ocr_extract" }, { name: "ocr.extract" }])
  assert.equal(modelNameOf.get("ocr.extract"), "ocr_extract_2")
})

test("qualified names split and restore on the plugin server only", () => {
  const aliases = new Map([["ocr_extract", "ocr.extract"]])
  assert.equal(
    qualifiedPluginToolName(SERVER, "ocr.extract"),
    "mcp__cognia-plugin-tools__ocr.extract"
  )
  assert.equal(bareNameOnServer(SERVER, "mcp__cognia-plugin-tools__ocr_extract"), "ocr_extract")
  assert.equal(bareNameOnServer(SERVER, "mcp__other__ocr_extract"), null)
  assert.equal(bareNameOnServer(SERVER, "Read"), null)
  assert.equal(bareNameOnServer(SERVER, "mcp__cognia-plugin-tools__"), null)
  assert.equal(
    restorePluginToolName(aliases, SERVER, "mcp__cognia-plugin-tools__ocr_extract"),
    "mcp__cognia-plugin-tools__ocr.extract"
  )
  assert.equal(
    restorePluginToolName(aliases, SERVER, "mcp__other__ocr_extract"),
    "mcp__other__ocr_extract"
  )
  assert.equal(restorePluginToolName(aliases, SERVER, "Read"), "Read")
  assert.equal(
    restorePluginToolName(undefined, SERVER, "mcp__cognia-plugin-tools__ocr_extract"),
    "mcp__cognia-plugin-tools__ocr_extract"
  )
  assert.equal(
    modelPluginToolName(aliases, SERVER, "mcp__cognia-plugin-tools__ocr.extract"),
    "mcp__cognia-plugin-tools__ocr_extract"
  )
  assert.equal(
    modelPluginToolName(aliases, SERVER, "mcp__cognia-plugin-tools__sandbox_bash"),
    "mcp__cognia-plugin-tools__sandbox_bash"
  )
})

test("modelPluginToolNameList translates only the entries that change and keeps identity otherwise", () => {
  const aliases = new Map([["ocr_extract", "ocr.extract"]])
  const untouched = ["Read", "mcp__cognia-plugin-tools__sandbox_bash", 42]
  assert.equal(modelPluginToolNameList(aliases, SERVER, untouched), untouched)
  assert.deepEqual(
    modelPluginToolNameList(aliases, SERVER, ["Read", "mcp__cognia-plugin-tools__ocr.extract"]),
    ["Read", "mcp__cognia-plugin-tools__ocr_extract"]
  )
  assert.equal(modelPluginToolNameList(aliases, SERVER, undefined), undefined)
  assert.equal(modelPluginToolNameList(new Map(), SERVER, untouched), untouched)
})

test("restorePluginToolNamesInSdkMessage rewrites the streamed vocabulary and nothing else", () => {
  const aliases = new Map([["ocr_extract", "ocr.extract"]])
  const assistant = {
    type: "assistant",
    message: {
      id: "m1",
      content: [
        { type: "text", text: "hi" },
        {
          type: "tool_use",
          id: "t1",
          name: "mcp__cognia-plugin-tools__ocr_extract",
          input: { p: 1 },
        },
        { type: "tool_use", id: "t2", name: "Read", input: {} },
      ],
    },
  }
  const restored = restorePluginToolNamesInSdkMessage(aliases, SERVER, assistant)
  assert.notEqual(restored, assistant)
  assert.equal(restored.message.content[1].name, "mcp__cognia-plugin-tools__ocr.extract")
  assert.equal(restored.message.content[1].input, assistant.message.content[1].input)
  assert.equal(restored.message.content[2], assistant.message.content[2])
  assert.equal(assistant.message.content[1].name, "mcp__cognia-plugin-tools__ocr_extract")

  const plain = {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
  }
  assert.equal(restorePluginToolNamesInSdkMessage(aliases, SERVER, plain), plain)

  const start = {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "t1",
        name: "mcp__cognia-plugin-tools__ocr_extract",
        input: {},
      },
    },
  }
  assert.equal(
    restorePluginToolNamesInSdkMessage(aliases, SERVER, start).event.content_block.name,
    "mcp__cognia-plugin-tools__ocr.extract"
  )
  const delta = {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
  }
  assert.equal(restorePluginToolNamesInSdkMessage(aliases, SERVER, delta), delta)

  const init = {
    type: "system",
    subtype: "init",
    tools: ["Read", "mcp__cognia-plugin-tools__ocr_extract"],
  }
  assert.deepEqual(restorePluginToolNamesInSdkMessage(aliases, SERVER, init).tools, [
    "Read",
    "mcp__cognia-plugin-tools__ocr.extract",
  ])
  const progress = {
    type: "tool_progress",
    tool_use_id: "t1",
    tool_name: "mcp__cognia-plugin-tools__ocr_extract",
  }
  assert.equal(
    restorePluginToolNamesInSdkMessage(aliases, SERVER, progress).tool_name,
    "mcp__cognia-plugin-tools__ocr.extract"
  )

  const result = { type: "result", subtype: "success" }
  assert.equal(restorePluginToolNamesInSdkMessage(aliases, SERVER, result), result)
  assert.equal(restorePluginToolNamesInSdkMessage(new Map(), SERVER, assistant), assistant)
  assert.equal(restorePluginToolNamesInSdkMessage(aliases, SERVER, null), null)
})
