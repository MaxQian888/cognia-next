import { test } from "node:test"
import assert from "node:assert/strict"

import type { Tool } from "ai"

import {
  AI_SDK_TOOL_SEARCH_NAME,
  createAiSdkToolSearchController,
  markAiSdkToolSource,
  type AiSdkToolSearchController,
} from "./ai-sdk-tool-search.ts"

/** A stand-in AI SDK tool: the controller reads only its description. */
function fakeTool(description: string): Tool {
  return { description, execute: async () => "ok" } as unknown as Tool
}

interface SearchOutput {
  query: string
  matches: { name: string; description: string }[]
  activated: string[]
  missing?: string[]
}

/** Call the controller's ToolSearch the way the model does, and parse its reply. */
async function search(
  controller: AiSdkToolSearchController | null,
  input: { query: string; limit?: number }
): Promise<SearchOutput> {
  const execute = controller!.tools[AI_SDK_TOOL_SEARCH_NAME]!.execute as (
    input: unknown
  ) => Promise<string>
  return JSON.parse(await execute(input)) as SearchOutput
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

  assert.deepEqual(controller!.prepareStep().activeTools, [AI_SDK_TOOL_SEARCH_NAME])
  const output = await search(controller, { query: "anything" })
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

  assert.deepEqual(Object.keys(controller!.tools), [AI_SDK_TOOL_SEARCH_NAME, "read", "write"])
  assert.deepEqual(controller!.prepareStep().activeTools, [AI_SDK_TOOL_SEARCH_NAME, "read"])
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
  const output = await search(controller, { query: "write file", limit: 1 })

  assert.deepEqual(output.activated, ["write"])
  assert.equal(output.matches[0]!.name, "write")
  assert.deepEqual(controller!.prepareStep().activeTools, [
    AI_SDK_TOOL_SEARCH_NAME,
    "read",
    "write",
  ])
})

test("select: activates exact permitted names and never invents absent tools", async () => {
  const controller = createAiSdkToolSearchController({
    tools: {
      edit: fakeTool("Edit text"),
      bash: fakeTool("Run a shell command"),
    },
    sendOptions: { toolSearchEnabled: true },
  })
  const output = await search(controller, {
    query: "select:bash,denied_tool,edit",
  })

  assert.deepEqual(output.activated, ["bash", "edit"])
  assert.deepEqual(output.missing, ["denied_tool"])
  assert.deepEqual(controller!.prepareStep().activeTools, [AI_SDK_TOOL_SEARCH_NAME, "bash", "edit"])
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

  assert.deepEqual(controller!.prepareStep().activeTools, [
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
  const output = await search(controller, { query: "file", limit: 2 })

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
  const exact = await search(controller, { query: "status", limit: 1 })
  const substring = await search(controller, { query: "git_stat", limit: 1 })

  assert.equal(exact.matches[0]!.name, "status")
  assert.equal(substring.matches[0]!.name, "git_status")
  assert.ok(controller!.prepareStep().activeTools.includes("status"))
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
  const output = await search(controller, {
    query: "select:c,b,a",
    limit: 2,
  })

  assert.deepEqual(output.activated, ["a", "b"])
  assert.ok(!controller!.prepareStep().activeTools.includes("c"))
})

test("select: and alwaysLoadTools accept the cognia name of a tool renamed for the provider", async () => {
  const ocr = fakeTool("Extract text from an image")
  const draw = fakeTool("Draw a diagram")
  markAiSdkToolSource(ocr, { serverName: "cognia-plugin-tools" })
  markAiSdkToolSource(draw, { serverName: "cognia-plugin-tools" })
  const controller = createAiSdkToolSearchController({
    tools: { ocr_extract: ocr, diagram_draw: draw },
    sendOptions: { toolSearchEnabled: true, alwaysLoadTools: ["diagram.draw"] },
    toolNameAliases: new Map([
      ["ocr_extract", "ocr.extract"],
      ["diagram_draw", "diagram.draw"],
    ]),
  })
  // The always-load rule was written with the cognia name and still applies.
  assert.deepEqual(controller!.prepareStep().activeTools, [AI_SDK_TOOL_SEARCH_NAME, "diagram_draw"])
  const output = await search(controller, { query: "select:ocr.extract" })
  // The model is told the name it can actually call.
  assert.deepEqual(output.activated, ["ocr_extract"])
  assert.deepEqual(output.missing, undefined)
  assert.ok(controller!.prepareStep().activeTools.includes("ocr_extract"))
})

/** `count` deferrable tools named `t000`…, plus any extra named tools. */
function manyTools(count: number, extra: Record<string, Tool> = {}): Record<string, Tool> {
  const tools: Record<string, Tool> = { ...extra }
  for (let i = 0; i < count; i += 1) {
    tools[`t${String(i).padStart(3, "0")}`] = fakeTool(`Plugin capability ${i}`)
  }
  return tools
}

test("a tool cap forces the controller on even when tool search is off", () => {
  const controller = createAiSdkToolSearchController({
    tools: manyTools(200),
    force: true,
    maxActiveTools: 128,
  })
  assert.ok(controller, "forced by the cap")
  assert.equal(controller!.maxActiveTools(), 128)
  assert.ok(controller!.prepareStep().activeTools.length <= 128)
  assert.equal(controller!.deferredToolNames().length, 200)
})

test("forced resident tools stay loaded under the cap, after always-load tools", () => {
  const read = fakeTool("Read a file")
  markAiSdkToolSource(read, { serverName: "cognia-tools", alwaysLoad: true })
  const controller = createAiSdkToolSearchController({
    tools: manyTools(200, { read, write: fakeTool("Write"), edit: fakeTool("Edit") }),
    force: true,
    maxActiveTools: 128,
    residentTools: ["write", "edit", "not_owned"],
  })
  assert.deepEqual(controller!.prepareStep().activeTools, [
    AI_SDK_TOOL_SEARCH_NAME,
    "edit",
    "read",
    "write",
  ])
  assert.ok(!controller!.deferredToolNames().includes("write"))
  assert.ok(!controller!.deferredToolNames().includes("not_owned"), "unowned names are ignored")
})

test("a cap smaller than the resident set keeps the highest-priority prefix and room to discover", async () => {
  const always: Record<string, Tool> = {}
  for (const name of ["a1", "a2", "a3"]) {
    always[name] = markAiSdkToolSource(fakeTool(name), { alwaysLoad: true })
  }
  const controller = createAiSdkToolSearchController({
    tools: manyTools(20, {
      ...always,
      core1: fakeTool("c1"),
      core2: fakeTool("c2"),
      core3: fakeTool("c3"),
    }),
    force: true,
    // 10 slots: ToolSearch + 4 for discovery headroom leaves 5 resident.
    maxActiveTools: 10,
    // Caller order is priority order: core3 is last, so it is the one dropped.
    residentTools: ["core2", "core1", "core3"],
  })
  assert.deepEqual(controller!.prepareStep().activeTools, [
    AI_SDK_TOOL_SEARCH_NAME,
    "a1",
    "a2",
    "a3",
    "core1",
    "core2",
  ])
  assert.ok(controller!.deferredToolNames().includes("core3"), "the end of the list is dropped")
  const output = await search(controller, { query: "select:t000,t001,t002,t003", limit: 8 })
  assert.deepEqual(output.activated, ["t000", "t001", "t002", "t003"])
  assert.equal(controller!.prepareStep().activeTools.length, 10)
})

test("discovery past the cap unloads the least recently activated tools", async () => {
  const controller = createAiSdkToolSearchController({
    tools: manyTools(30),
    force: true,
    maxActiveTools: 5,
  })
  // 5 slots: ToolSearch + headroom of 2 leaves 2 resident (none here) → 4 discoverable.
  await search(controller, { query: "select:t000,t001" })
  await search(controller, { query: "select:t002,t003" })
  // Touch t000 again so t001 becomes the least recently used.
  await search(controller, { query: "select:t000" })
  const output = (await search(controller, { query: "select:t004" })) as SearchOutput & {
    unloaded?: string[]
  }
  assert.deepEqual(output.activated, ["t004"])
  assert.deepEqual(output.unloaded, ["t001"])
  assert.deepEqual(controller!.prepareStep().activeTools, [
    AI_SDK_TOOL_SEARCH_NAME,
    "t000",
    "t002",
    "t003",
    "t004",
  ])
})

test("setMaxActiveTools only tightens, demoting resident tools and unloading discoveries", async () => {
  const controller = createAiSdkToolSearchController({
    tools: manyTools(40),
    force: true,
    maxActiveTools: 30,
    residentTools: ["t000", "t001", "t002", "t003", "t004", "t005"],
  })
  await search(controller, { query: "select:t010,t011,t012" })
  assert.equal(controller!.prepareStep().activeTools.length, 10)

  controller!.setMaxActiveTools(6)
  // 6 slots: ToolSearch + headroom 2 → 3 resident; discoveries fill the rest.
  const active = controller!.prepareStep().activeTools
  assert.equal(active.length, 6)
  assert.deepEqual(active.slice(0, 4), [AI_SDK_TOOL_SEARCH_NAME, "t000", "t001", "t002"])
  assert.ok(controller!.deferredToolNames().includes("t005"), "demoted tools become deferred")

  controller!.setMaxActiveTools(50)
  assert.equal(controller!.maxActiveTools(), 6, "a looser limit never widens the cap")
})

test("restored discoveries obey unloads, current permissions and the current cap", () => {
  const controller = createAiSdkToolSearchController({
    tools: Object.fromEntries(["a", "b", "c", "d", "e"].map((name) => [name, fakeTool(name)])),
    sendOptions: { toolSearchEnabled: true },
    maxActiveTools: 3,
  })!
  const result = (value: string) => ({
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: "search",
        toolName: "ToolSearch",
        output: { type: "text" as const, value },
      },
    ],
  })
  controller.restoreConversation([
    result(JSON.stringify({ activated: ["a", "b", "denied"] })),
    result("invalid JSON"),
    result("null"),
    result(JSON.stringify({ activated: ["c"], unloaded: ["b"] })),
  ])
  assert.deepEqual(controller.activeToolNames(), ["ToolSearch", "a", "c"])
  controller.restoreConversation([result(JSON.stringify({ activated: ["a", "b", "c", "d"] }))])
  assert.deepEqual(controller.activeToolNames(), ["ToolSearch", "c", "d"])
  controller.restoreConversation([])
  assert.deepEqual(controller.activeToolNames(), ["ToolSearch"])
})

test("deferredToolsPrompt names every deferred tool and the cap", () => {
  const controller = createAiSdkToolSearchController({
    tools: manyTools(3, { write: fakeTool("Write") }),
    force: true,
    maxActiveTools: 128,
    residentTools: ["write"],
  })
  const prompt = controller!.deferredToolsPrompt()!
  assert.match(prompt, /at most 128 tool definitions/)
  assert.match(prompt, /select:<name>/)
  assert.match(prompt, /t000, t001, t002\.$/)
  assert.ok(!prompt.includes("write"))

  const uncapped = createAiSdkToolSearchController({
    tools: { write: fakeTool("Write") },
    sendOptions: { toolSearchEnabled: true },
  })
  assert.equal(uncapped!.maxActiveTools(), null)
  assert.match(uncapped!.deferredToolsPrompt()!, /not loaded into this conversation up front/)
})
