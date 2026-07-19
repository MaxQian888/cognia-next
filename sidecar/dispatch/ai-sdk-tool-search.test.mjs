import { test } from "node:test"
import assert from "node:assert/strict"

import {
  AI_SDK_TOOL_SEARCH_NAME,
  createAiSdkToolSearchController,
  markAiSdkToolSource,
} from "./ai-sdk-tool-search.mjs"

function fakeTool(description) {
  return { description, execute: async () => "ok" }
}

test("tool search stays disabled unless the resolved runtime policy enables it", () => {
  assert.equal(createAiSdkToolSearchController({ tools: { read: fakeTool("Read a file") } }), null)
})

test("source metadata helper tolerates non-tools and accepts callable tool objects", () => {
  assert.equal(markAiSdkToolSource(null, { alwaysLoad: true }), null)
  const callable = () => {}
  assert.equal(markAiSdkToolSource(callable, { alwaysLoad: true }), callable)
})

test("an enabled empty catalog still exposes ToolSearch safely", async () => {
  const controller = createAiSdkToolSearchController({
    sendOptions: { toolSearchEnabled: true },
  })

  assert.deepEqual(controller.prepareStep().activeTools, [AI_SDK_TOOL_SEARCH_NAME])
  const output = JSON.parse(
    await controller.tools[AI_SDK_TOOL_SEARCH_NAME].execute({ query: "anything" })
  )
  assert.deepEqual(output.matches, [])
})

test("initial active tools contain only ToolSearch and always-load tools", () => {
  const read = fakeTool("Read a file")
  const write = fakeTool("Write a file")
  markAiSdkToolSource(read, { serverName: "cognia-tools", alwaysLoad: true })
  markAiSdkToolSource(write, { serverName: "cognia-tools" })

  const controller = createAiSdkToolSearchController({
    tools: { write, read },
    sendOptions: { toolSearchEnabled: true },
  })

  assert.deepEqual(Object.keys(controller.tools), [AI_SDK_TOOL_SEARCH_NAME, "read", "write"])
  assert.deepEqual(controller.prepareStep().activeTools, [AI_SDK_TOOL_SEARCH_NAME, "read"])
})

test("a ToolSearch call discovers and activates matching tools for the next step", async () => {
  const tools = {
    read: fakeTool("Read files without modifying them"),
    write: fakeTool("Create or replace a file"),
    git_status: fakeTool("Inspect repository status"),
  }
  markAiSdkToolSource(tools.read, { serverName: "cognia-tools", alwaysLoad: true })

  const controller = createAiSdkToolSearchController({
    tools,
    sendOptions: { toolSearchEnabled: true },
  })
  const output = JSON.parse(
    await controller.tools[AI_SDK_TOOL_SEARCH_NAME].execute({ query: "write file", limit: 1 })
  )

  assert.deepEqual(output.activated, ["write"])
  assert.equal(output.matches[0].name, "write")
  assert.deepEqual(controller.prepareStep().activeTools, [AI_SDK_TOOL_SEARCH_NAME, "read", "write"])
})

test("select: activates exact permitted names and never invents absent tools", async () => {
  const controller = createAiSdkToolSearchController({
    tools: {
      edit: fakeTool("Edit text"),
      bash: fakeTool("Run a shell command"),
    },
    sendOptions: { toolSearchEnabled: true },
  })
  const output = JSON.parse(
    await controller.tools[AI_SDK_TOOL_SEARCH_NAME].execute({
      query: "select:bash,denied_tool,edit",
    })
  )

  assert.deepEqual(output.activated, ["bash", "edit"])
  assert.deepEqual(output.missing, ["denied_tool"])
  assert.deepEqual(controller.prepareStep().activeTools, [AI_SDK_TOOL_SEARCH_NAME, "bash", "edit"])
})

test("configured always-load servers and namespaced tools map onto AI SDK keys", () => {
  const write = fakeTool("Write a file")
  const plugin = fakeTool("Plugin operation")
  const remote = fakeTool("Remote lookup")
  markAiSdkToolSource(write, { serverName: "cognia-tools" })
  markAiSdkToolSource(plugin, { serverName: "cognia-plugin-tools" })

  const controller = createAiSdkToolSearchController({
    tools: {
      write,
      plugin_action: plugin,
      mcp__remote__lookup: remote,
    },
    sendOptions: {
      toolSearchEnabled: true,
      alwaysLoadServers: ["cognia-plugin-tools", "remote"],
      alwaysLoadTools: ["mcp__cognia-tools__write"],
    },
  })

  assert.deepEqual(controller.prepareStep().activeTools, [
    AI_SDK_TOOL_SEARCH_NAME,
    "mcp__remote__lookup",
    "plugin_action",
    "write",
  ])
})

test("free-text discovery respects the per-call result limit", async () => {
  const controller = createAiSdkToolSearchController({
    tools: {
      file_a: fakeTool("File operation A"),
      file_b: fakeTool("File operation B"),
      file_c: fakeTool("File operation C"),
    },
    sendOptions: { toolSearchEnabled: true },
  })
  const output = JSON.parse(
    await controller.tools[AI_SDK_TOOL_SEARCH_NAME].execute({ query: "file", limit: 2 })
  )

  assert.equal(output.matches.length, 2)
  assert.equal(output.activated.length, 2)
})

test("free-text ranking prioritizes an exact name over a name substring", async () => {
  const controller = createAiSdkToolSearchController({
    tools: {
      status: fakeTool("Exact status"),
      git_status: fakeTool("Repository status"),
    },
    sendOptions: { toolSearchEnabled: true, alwaysLoadTools: ["status"] },
  })
  const exact = JSON.parse(
    await controller.tools[AI_SDK_TOOL_SEARCH_NAME].execute({ query: "status", limit: 1 })
  )
  const substring = JSON.parse(
    await controller.tools[AI_SDK_TOOL_SEARCH_NAME].execute({ query: "git_stat", limit: 1 })
  )

  assert.equal(exact.matches[0].name, "status")
  assert.equal(substring.matches[0].name, "git_status")
  assert.ok(controller.prepareStep().activeTools.includes("status"))
})

test("exact selection also respects the per-call activation limit", async () => {
  const controller = createAiSdkToolSearchController({
    tools: {
      a: fakeTool("A"),
      b: fakeTool("B"),
      c: fakeTool("C"),
    },
    sendOptions: { toolSearchEnabled: true },
  })
  const output = JSON.parse(
    await controller.tools[AI_SDK_TOOL_SEARCH_NAME].execute({
      query: "select:c,b,a",
      limit: 2,
    })
  )

  assert.deepEqual(output.activated, ["a", "b"])
  assert.ok(!controller.prepareStep().activeTools.includes("c"))
})
