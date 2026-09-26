// P2, P3, P3b and P9 characterization pins for the built-in tool surface
// (ADR-0197).
//
// Three rails put the built-in tools in front of a model: the Claude Agent SDK
// rail registers them on an in-process MCP server, the ai-sdk rail converts
// them into AI SDK tools, and the MCP tool bridge serves them to external
// agents. The migration moves the registry, the middleware and the adapters
// behind all three, so this file records what each rail exposes and how a call
// flows through it:
//
// - P3: every tool each rail lists, in order, with hashes of its description
//   and input schema, its `_meta` and annotations, and which ai-sdk tools stay
//   resident behind ToolSearch; across the flag combinations the rails use.
// - P3b and P9: real calls whose output shows the middleware order —
//   confinement, the read-only deadline, the result cap and its marker, and the
//   PII gate.
// - P2: the read-only deadline's text on each rail.
//
// The golden pins each rail exactly as it is, divergences included.
// Regenerate it with `UPDATE_GOLDEN=1` only for an intended behaviour change,
// and say why in the commit.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { asSchema } from "ai"
import type { ToolSet } from "ai"

import data from "../../../lib/settings/builtin-tools-data.json" with { type: "json" }
import { stableStringify } from "../shared/stable-stringify.ts"
import { READ_ONLY_TOOL_NAMES } from "../policy/tool-catalog/catalog.ts"
import {
  applyToolPresentation,
  buildCogniaToolsServer,
  collectCogniaToolDefs,
} from "../../builtin-tools/index.mjs"
import { wrapDefsWithReadOnlyTimeout } from "./middleware/read-only-timeout.ts"
import { createReadTracker } from "../../builtin-tools/core/read-tracker.mjs"
import { createBgShellRegistry } from "../../builtin-tools/core/bash-sessions.mjs"
import { createSessionTaskStore } from "../../builtin-tools/core/tasks.mjs"
import { probeSandbox } from "../../builtin-tools/run-code/supervisor.mjs"
import { buildAiSdkTools, __testing__ as aiSdkTools } from "../../dispatch/ai-sdk-tools.mjs"
import { createAiSdkToolSearchController } from "./adapters/ai-sdk-tool-search.ts"
import { buildToolSurface } from "../../cognia-tool-bridge.mjs"

// ---- the rails under test -----------------------------------------------------
//
// The registry, the adapters and the bridge are untyped JavaScript until they
// move; the pins reach them through these views, which name only what a pin
// calls. As each module moves, its view points at the typed module instead.

interface ToolDef {
  name: string
  description?: string
  inputSchema?: unknown
  handler(args: unknown, extra?: unknown): unknown
}

interface ExecutableTool {
  description?: string
  inputSchema: unknown
  execute(args: unknown, options: unknown): Promise<unknown>
}

interface McpServerConfig {
  instance: { connect(transport: unknown): Promise<void> }
}

interface BridgeTool {
  name: string
  description: string
  inputSchema: unknown
  run(args: unknown): Promise<{ content?: unknown; isError?: boolean }>
}

const rails = {
  buildServer: buildCogniaToolsServer as unknown as (
    options: Record<string, unknown>
  ) => McpServerConfig | null,
  collect: collectCogniaToolDefs as unknown as (options: Record<string, unknown>) => ToolDef[],
  present: applyToolPresentation as unknown as (
    defs: ToolDef[],
    presentation: string | undefined
  ) => ToolDef[],
  withDeadline: wrapDefsWithReadOnlyTimeout as unknown as (
    defs: ToolDef[],
    timeoutMs: number,
    readOnly: ReadonlySet<string>
  ) => ToolDef[],
  buildAiSdk: buildAiSdkTools as unknown as (params: Record<string, unknown>) => ToolSet,
  toAiSdkTool: aiSdkTools.builtinDefToAiSdkTool as unknown as (
    def: ToolDef,
    gate: null,
    timeoutMs: number,
    review: undefined
  ) => ExecutableTool,
  bridge: buildToolSurface as unknown as (
    serverName: string,
    session: Record<string, unknown>,
    broker: unknown
  ) => BridgeTool[],
  probe: probeSandbox as unknown as () => { canSpawnProcess?: boolean; strictSandbox?: boolean },
}

const GOLDEN = new URL("../../test-support/fixtures/tool-surface.golden.txt", import.meta.url)

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cognia-surface-root-")))
const OUTSIDE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cognia-surface-out-")))

// A file whose text is both over the result cap and carries PII, so one read
// shows whether the cap or the PII gate ran first.
const NOTES = path.join(ROOT, "notes.txt")
fs.writeFileSync(
  NOTES,
  [
    "alpha line: contact alice.example@example.com for access",
    "beta line: call +1 415 555 0132 after five",
    ...Array.from({ length: 4 }, (_, i) => `filler ${i} ${"x".repeat(30)}`),
    "omega line: bob.example@example.com closes the file",
  ].join("\n")
)
const SECRET = path.join(OUTSIDE, "secret.txt")
fs.writeFileSync(SECRET, "outside the roots\n")
// Confinement refuses writes outside the writable roots (reads stay allowed
// unless the path is protected); no rail may create this file.
const ESCAPE = path.join(OUTSIDE, "escape.txt")
const SANDBOX = { builtinProcessSandbox: { writableRoots: [ROOT] } }

/** Every category the settings UI offers, switched on. */
const ALL_CATEGORIES: Record<string, boolean> = Object.fromEntries(
  data.categories.map((category) => [category.id, true])
)

const MODEL_SESSION = { sessionId: "pins-session" }

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12)
}

/** Replace the temp roots so the golden is the same on every machine. */
function normalize(text: string): string {
  return text.split(ROOT).join("<root>").split(OUTSIDE).join("<outside>")
}

/** Resolver-bound categories only need their resolver to exist at build time. */
function sessionState() {
  return {
    readTracker: createReadTracker(),
    bgShells: createBgShellRegistry(),
    taskStore: createSessionTaskStore(),
    lspResolver: {
      request: async () => null,
      getDiagnostics: async () => [],
    },
    codeGraphResolver: {
      ensureIndexed: async () => {},
      syncStale: async () => 0,
      status: () => ({}),
    },
  }
}

// ---- P3: the Claude Agent SDK rail --------------------------------------------

interface ListedTool {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: unknown
  _meta?: unknown
}

/** Connect an in-memory MCP client to an in-process SDK server. */
async function connect(server: McpServerConfig): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.instance.connect(serverSide)
  const client = new Client({ name: "surface-pins", version: "0" })
  await client.connect(clientSide)
  return client
}

function listedLine(tool: ListedTool): string {
  const parts = [
    tool.name,
    `desc=${sha(tool.description ?? "")}`,
    `schema=${sha(stableStringify(tool.inputSchema ?? null))}`,
  ]
  if (tool._meta !== undefined) parts.push(`meta=${stableStringify(tool._meta)}`)
  if (tool.annotations !== undefined) parts.push(`ann=${stableStringify(tool.annotations)}`)
  return parts.join(" ")
}

async function anthropicSurface(
  label: string,
  options: Record<string, unknown>
): Promise<string[]> {
  const server = rails.buildServer({
    dispatchPath: "anthropic",
    cwd: ROOT,
    ...MODEL_SESSION,
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    ...sessionState(),
    ...options,
  })
  if (!server) return [`## anthropic · ${label}`, "(no server)"]
  const client = await connect(server)
  try {
    const { tools } = await client.listTools()
    return [`## anthropic · ${label}`, ...tools.map((tool) => listedLine(tool as ListedTool))]
  } finally {
    await client.close()
  }
}

// ---- P3: the ai-sdk rail --------------------------------------------------------

const PLUGIN_TOOLS = [
  {
    name: "notes_search",
    description: "Search the user's notes.",
    jsonSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  { name: "dispatch_agent", description: "Run a child agent.", timeoutMs: 0 },
]

type PendingApprovals = Map<string, { input?: unknown; resolve(answer: unknown): void }>

/** Approvals the renderer was asked for, answered "allow" as the host would. */
const approvalsAsked: string[] = []

function buildAiSdk(sendOptions: Record<string, unknown>): ToolSet {
  const pendingApprovals: PendingApprovals = new Map()
  const emit = (frame: { type?: string; toolName?: string }) => {
    if (frame.type !== "permission_request") return
    approvalsAsked.push(String(frame.toolName))
    queueMicrotask(() => {
      for (const [requestId, entry] of [...pendingApprovals]) {
        pendingApprovals.delete(requestId)
        entry.resolve({ behavior: "allow", updatedInput: entry.input })
      }
    })
  }
  return rails.buildAiSdk({
    sendOptions: { cwd: ROOT, ...sendOptions },
    emit,
    sessionId: MODEL_SESSION.sessionId,
    pendingApprovals,
    pendingPluginToolCalls: new Map(),
    ...sessionState(),
  })
}

async function aiSdkSurface(label: string, sendOptions: Record<string, unknown>) {
  const tools = buildAiSdk(sendOptions)
  const lines = [`## ai-sdk · ${label}`]
  for (const [name, tool] of Object.entries(tools)) {
    const schema = await asSchema(tool.inputSchema).jsonSchema
    // Every rail tool carries a plain string description.
    const description = typeof tool.description === "string" ? tool.description : ""
    lines.push(
      [name, `desc=${sha(description)}`, `schema=${sha(stableStringify(schema))}`].join(" ")
    )
  }
  // Which tools stay resident when ToolSearch defers the rest: the `alwaysLoad`
  // flag and the server each tool is attributed to.
  const resident = (extra: Record<string, unknown>) =>
    createAiSdkToolSearchController({
      tools,
      sendOptions: { toolSearchEnabled: true, ...extra },
    })?.activeToolNames() ?? []
  lines.push(`resident: ${resident({}).join(" ")}`)
  lines.push(
    `resident with cognia-plugin-tools always loaded: ${resident({ alwaysLoadServers: ["cognia-plugin-tools"] }).join(" ")}`
  )
  return lines
}

// ---- P3: the MCP tool bridge ---------------------------------------------------

const allowingBroker = {
  async call(method: string, params: { result?: unknown }) {
    if (method === "authorize") return { allow: true }
    if (method === "review") return { result: params.result }
    return {}
  },
}

function bridgeTools(serverName: string, session: Record<string, unknown>): BridgeTool[] {
  return rails.bridge(serverName, session, allowingBroker)
}

const ALL_BUILTIN_NAMES = data.categories.flatMap((category) =>
  category.tools.map((tool) => tool.name)
)

function bridgeSurface(label: string, serverName: string, session: Record<string, unknown>) {
  return [
    `## bridge · ${label}`,
    ...bridgeTools(serverName, session).map((tool) => listedLine(tool)),
  ]
}

// ---- P3b / P9: calls through each rail ----------------------------------------

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] } | null)?.content
  if (!Array.isArray(content)) return JSON.stringify(result)
  return content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("")
}

function callLines(label: string, outcome: string): string[] {
  return [
    `### ${label}`,
    ...normalize(outcome)
      .split("\n")
      .map((line) => `  ${line}`),
  ]
}

async function anthropicCall(
  label: string,
  options: Record<string, unknown>,
  name: string,
  args: Record<string, unknown>
): Promise<string[]> {
  const server = rails.buildServer({
    enabled: { coreFiles: true, coreFilesOnAnthropic: true },
    dispatchPath: "anthropic",
    cwd: ROOT,
    ...MODEL_SESSION,
    ...sessionState(),
    ...options,
  })
  assert.ok(server, "coreFiles must build a server")
  const client = await connect(server)
  try {
    const result = await client.callTool({ name, arguments: args })
    return callLines(label, `${result.isError ? "isError " : ""}${textOf(result)}`)
  } finally {
    await client.close()
  }
}

async function aiSdkCall(
  label: string,
  sendOptions: Record<string, unknown>,
  name: string,
  args: Record<string, unknown>
): Promise<string[]> {
  const tool = buildAiSdk({ builtinTools: { coreFiles: true }, ...sendOptions })[name]
  assert.ok(tool?.execute, `ai-sdk rail has no executable ${name}`)
  // The rail's tools read only the call id and the abort signal.
  const execute = tool.execute as (args: unknown, options: unknown) => Promise<unknown>
  approvalsAsked.length = 0
  let outcome: string
  try {
    const output = await execute(args, {
      toolCallId: "pins-call",
      messages: [],
      abortSignal: new AbortController().signal,
    })
    outcome = typeof output === "string" ? output : textOf(output)
  } catch (error) {
    outcome = `threw ${(error as Error).message}`
  }
  const asked = approvalsAsked.length ? `asked for ${approvalsAsked.join(",")}, allowed; ` : ""
  return callLines(label, `${asked}${outcome}`)
}

async function bridgeCall(
  label: string,
  session: Record<string, unknown>,
  name: string,
  args: Record<string, unknown>
): Promise<string[]> {
  const tool = bridgeTools("cognia-tools", session).find((entry) => entry.name === name)
  assert.ok(tool, `bridge has no ${name}`)
  const result = await tool.run(args)
  return callLines(label, `${result.isError ? "isError " : ""}${textOf(result)}`)
}

// ---- P2: the read-only deadline -------------------------------------------------

const HANG_MS = 25

function hangingDef(name: string): ToolDef {
  return {
    name,
    description: `${name} that never answers`,
    inputSchema: {},
    handler: () => new Promise(() => {}),
  }
}

async function deadlineLines(): Promise<string[]> {
  const [wrapped] = rails.withDeadline([hangingDef("grep")], HANG_MS, READ_ONLY_TOOL_NAMES)
  const registered = await wrapped!.handler({}, {})

  const aiSdkTool = rails.toAiSdkTool(hangingDef("grep"), null, HANG_MS, undefined)
  let thrown = "(resolved)"
  try {
    await aiSdkTool.execute({}, { toolCallId: "pins-deadline", messages: [] })
  } catch (error) {
    thrown = (error as Error).message
  }
  return [
    `registration-time (anthropic, bridge): ${stableStringify(registered)}`,
    `execute-time (ai-sdk): threw ${thrown}`,
  ]
}

// ---------------------------------------------------------------------------

test("P2/P3/P3b/P9: every rail's tool surface, call path and deadline match the golden", async () => {
  const sections: string[][] = []

  sections.push(
    await anthropicSurface("all categories, alwaysLoad, plan tools", {
      enabled: ALL_CATEGORIES,
      alwaysLoad: true,
      planTools: true,
    }),
    await anthropicSurface("all categories + coreFilesOnAnthropic, no plan tools", {
      enabled: { ...ALL_CATEGORIES, coreFilesOnAnthropic: true },
      planTools: false,
    }),
    await anthropicSurface("git + fileExtras inside a process sandbox", {
      enabled: { git: true, fileExtras: true },
      builtinProcessSandbox: { writableRoots: [ROOT] },
    }),
    await anthropicSurface("no categories", { enabled: {} }),
    await aiSdkSurface("all categories + plugin tools, openai", {
      builtinTools: ALL_CATEGORIES,
      pluginTools: PLUGIN_TOOLS,
      model: "gpt-5",
      provider: "openai",
    }),
    await aiSdkSurface("all categories, ollama, no plan tools", {
      builtinTools: ALL_CATEGORIES,
      model: "qwen3",
      provider: "ollama",
      planTools: false,
    }),
    await aiSdkSurface("allow list in Claude Code names + deny list", {
      builtinTools: ALL_CATEGORIES,
      pluginTools: PLUGIN_TOOLS,
      allowedTools: ["Read", "Grep", "git_status", "notes_search", "mcp__cognia-tools__file_hash"],
      disallowedTools: ["grep", "mcp__cognia-plugin-tools__notes_search"],
    }),
    await aiSdkSurface("toolSurface none", {
      builtinTools: ALL_CATEGORIES,
      pluginTools: PLUGIN_TOOLS,
      toolSurface: "none",
    }),
    bridgeSurface("all categories, every tool visible", "cognia-tools", {
      cwd: ROOT,
      enabledCategories: ALL_CATEGORIES,
      visibleBuiltinTools: ALL_BUILTIN_NAMES,
      ...MODEL_SESSION,
    }),
    bridgeSurface("plugin tools", "cognia-plugin-tools", {
      hostTools: PLUGIN_TOOLS,
    })
  )

  sections.push([
    "## calls",
    ...(await anthropicCall(
      "anthropic read, capped to 20 tokens",
      { maxToolResultTokens: 20 },
      "read",
      {
        file_path: NOTES,
      }
    )),
    ...(await anthropicCall("anthropic read, uncapped", {}, "read", { file_path: NOTES })),
    ...(await anthropicCall("anthropic read outside the writable roots", SANDBOX, "read", {
      file_path: SECRET,
    })),
    ...(await anthropicCall("anthropic write outside the writable roots", SANDBOX, "write", {
      file_path: ESCAPE,
      content: "escaped\n",
    })),
    ...(await aiSdkCall("ai-sdk read (no result cap on this rail)", {}, "read", {
      file_path: NOTES,
    })),
    ...(await aiSdkCall("ai-sdk read outside the writable roots", SANDBOX, "read", {
      file_path: SECRET,
    })),
    ...(await aiSdkCall("ai-sdk write outside the writable roots", SANDBOX, "write", {
      file_path: ESCAPE,
      content: "escaped\n",
    })),
    ...(await bridgeCall(
      "bridge read, capped to 20 tokens",
      {
        cwd: ROOT,
        enabledCategories: { coreFiles: true },
        visibleBuiltinTools: ["read"],
        maxToolResultTokens: 20,
        ...MODEL_SESSION,
      },
      "read",
      { file_path: NOTES }
    )),
  ])

  assert.equal(fs.existsSync(ESCAPE), false, "a confined write escaped the writable roots")

  sections.push(["## read-only deadline", ...(await deadlineLines())])

  const actual = [
    "# P2/P3/P3b/P9 tool-surface pins. Generated by src/tools/surface.pins.test.ts;",
    "# regenerate with UPDATE_GOLDEN=1 only for an intended behaviour change.",
    "#",
    "# Tool lines: <name> desc=<sha256(description)> schema=<sha256(input schema)> [meta] [ann].",
    "# Calls show the text a model receives; temp roots are <root> and <outside>.",
    "",
    ...sections.flatMap((section) => [...section, ""]),
  ].join("\n")

  if (process.env.UPDATE_GOLDEN === "1") fs.writeFileSync(GOLDEN, actual)
  const expected = fs.readFileSync(GOLDEN, "utf8")
  if (actual !== expected) {
    const a = actual.split("\n")
    const e = expected.split("\n")
    const diffs: string[] = []
    for (let i = 0; i < Math.max(a.length, e.length) && diffs.length < 40; i++) {
      if (a[i] !== e[i]) diffs.push(`line ${i + 1}\n  golden: ${e[i]}\n  actual: ${a[i]}`)
    }
    assert.fail(`tool surface drifted from the golden:\n${diffs.join("\n")}`)
  }
})

test("P3: code presentation swaps in run_code only where the host can sandbox", () => {
  const native = rails.collect({ enabled: { git: true, fileExtras: true }, cwd: ROOT })
  const probe = rails.probe()
  const sandboxed = Boolean(probe.canSpawnProcess && probe.strictSandbox)
  const names = (defs: readonly ToolDef[]) => defs.map((def) => def.name)

  assert.deepEqual(names(rails.present(native, "native")), names(native))
  assert.deepEqual(names(rails.present(native, undefined)), names(native))
  assert.deepEqual(
    names(rails.present(native, "code")),
    sandboxed ? ["run_code"] : [],
    "code presentation replaces the native surface, and never falls back to it"
  )
  assert.deepEqual(
    names(rails.present(native, "both")),
    sandboxed ? [...names(native), "run_code"] : names(native)
  )
})

test("P2: a bash call is never bounded by the read-only deadline", async () => {
  let settle!: (value: unknown) => void
  const slow: ToolDef = {
    name: "bash",
    handler: () =>
      new Promise((resolve) => {
        settle = resolve
      }),
  }
  const [wrapped] = rails.withDeadline([slow], 1, READ_ONLY_TOOL_NAMES)
  assert.equal(wrapped, slow, "exec tools keep their own handler")
  const pending = wrapped!.handler({}, {})
  await new Promise((resolve) => setTimeout(resolve, 10))
  settle("done")
  assert.equal(await pending, "done")
})
